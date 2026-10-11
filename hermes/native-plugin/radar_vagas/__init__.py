"""Radar de Vagas — plugin nativo do Hermes Agent.

Registra um hook ``pre_gateway_dispatch`` que intercepta, ANTES da autorização e do
despacho para o agente, apenas as mensagens do Telegram que são respostas às perguntas
humanas do Radar:

* comando explícito ``/radar responder <código> <texto>``, ``/radar pular <código>`` ou
  ``/radar parar <código>``; ou
* reply do Telegram a uma mensagem de pergunta que o Radar enviou (o id da mensagem
  respondida casa com uma referência gravada por ``notify-human-questions.mjs`` em
  ``<RADAR_APP_DIR>/.radar/telegram-refs.json``).

Mensagens consumidas viram ``{"action": "skip"}`` (não chegam ao LLM). O registro é feito
por ``node <RADAR_APP_DIR>/scripts/ops/answer-human-questions.mjs --stdin-json`` (argv em
lista, sem shell, com timeout), e o resultado volta ao usuário por
``gateway.adapters[platform].send(chat_id, texto, reply_to=message_id)``. Se o adapter não
estiver disponível, o hook devolve ``{"action": "rewrite"}`` com um aviso curto (o agente
repassa o resultado).

Só age para a plataforma telegram e para user ids da allowlist
(``RADAR_ANSWER_ALLOWED_USERS`` ou ``TELEGRAM_ALLOWED_USERS``). Sem allowlist, não consome
nada (falha fechada para o Radar; a conversa normal do Hermes segue). Qualquer erro é
capturado e registrado em log — o gateway nunca cai por causa deste plugin.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
import os
import re
import shutil
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

DEFAULT_APP_DIR = "/opt/data/dashboard/busca_emprego"
SCRIPT_RELATIVE = Path("scripts") / "ops" / "answer-human-questions.mjs"
TIMEOUT_SECONDS = 30
MAX_REPLY_CHARS = 800

COMMAND_RE = re.compile(
    r"^/radar(?:@[A-Za-z0-9_]+)?\s+(responder|pular|parar)\s+[A-Za-z0-9]{4,18}(?:\s|$)",
    re.IGNORECASE,
)

USAGE = (
    "Radar de Vagas — respostas às perguntas humanas:\n"
    "• /radar responder <código> <sua resposta>\n"
    "• /radar pular <código>  (só pergunta opcional)\n"
    "• /radar parar <código>  (interrompe a candidatura)\n"
    "• ou responda (reply) à mensagem da pergunta.\n"
    "O código aparece entre colchetes na mensagem da pergunta."
)


def _app_dir() -> Path:
    return Path(os.environ.get("RADAR_APP_DIR") or DEFAULT_APP_DIR)


def _allowed_users() -> set[str]:
    raw = os.environ.get("RADAR_ANSWER_ALLOWED_USERS") or os.environ.get("TELEGRAM_ALLOWED_USERS") or ""
    return {item.strip() for item in raw.split(",") if item.strip() and item.strip() != "*"}


def _refs_path() -> Path:
    override = os.environ.get("RADAR_TELEGRAM_REFS_PATH")
    return Path(override) if override else _app_dir() / ".radar" / "telegram-refs.json"


def _known_refs() -> set[str]:
    try:
        data = json.loads(_refs_path().read_text(encoding="utf-8"))
        refs = data.get("refs", {}) if isinstance(data, dict) else {}
        return set(refs.keys()) if isinstance(refs, dict) else set()
    except FileNotFoundError:
        return set()
    except Exception as exc:  # arquivo corrompido nunca derruba o gateway
        logger.warning("radar_vagas: não leu %s: %s", _refs_path(), exc)
        return set()


def _platform_name(platform) -> str:
    value = getattr(platform, "value", platform)
    return str(value or "").lower()


def _str_or_none(value) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _inbound(event) -> dict | None:
    """Extrai os campos documentados do MessageEvent/SessionSource; None se não for Telegram."""
    source = getattr(event, "source", None)
    if source is None or _platform_name(getattr(source, "platform", None)) != "telegram":
        return None
    message_id = _str_or_none(getattr(event, "message_id", None)) or _str_or_none(getattr(source, "message_id", None))
    return {
        "platform": "telegram",
        "chat_id": _str_or_none(getattr(source, "chat_id", None)),
        "user_id": _str_or_none(getattr(source, "user_id", None)),
        "message_id": message_id,
        "reply_to_message_id": _str_or_none(getattr(event, "reply_to_message_id", None)),
        "text": str(getattr(event, "text", "") or ""),
    }


def should_consume(payload: dict) -> bool:
    """True só para comando /radar explícito ou reply a uma pergunta do Radar, de usuário autorizado."""
    allowed = _allowed_users()
    if not allowed:
        logger.warning("radar_vagas: TELEGRAM_ALLOWED_USERS/RADAR_ANSWER_ALLOWED_USERS ausente — nada é consumido")
        return False
    if not payload.get("chat_id") or not payload.get("user_id") or payload["user_id"] not in allowed:
        return False
    if COMMAND_RE.match(payload["text"].strip()):
        return True
    reply_to = payload.get("reply_to_message_id")
    if reply_to:
        return f"telegram:{payload['chat_id']}:{reply_to}" in _known_refs()
    return False


def run_answer(payload: dict) -> tuple[int, str]:
    """Roda o script de resposta (sem shell) e devolve (código de saída, texto para o usuário)."""
    app_dir = _app_dir()
    script = app_dir / SCRIPT_RELATIVE
    node = os.environ.get("RADAR_NODE_BIN") or shutil.which("node") or "node"
    try:
        completed = subprocess.run(
            [node, str(script), "--stdin-json"],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
            cwd=str(app_dir),
            check=False,
        )
    except subprocess.TimeoutExpired:
        logger.error("radar_vagas: answer-human-questions excedeu %ss", TIMEOUT_SECONDS)
        return 124, "Radar: o registro da resposta demorou demais. Tente de novo em instantes."
    except OSError as exc:
        logger.error("radar_vagas: não executou %s: %s", script, exc)
        return 127, "Radar: não consegui executar o registro da resposta (app indisponível)."
    output = (completed.stdout or "").strip() or (completed.stderr or "").strip() or f"saída {completed.returncode}"
    if completed.returncode != 0:
        logger.info("radar_vagas: answer saiu com %s: %s", completed.returncode, output.replace("\n", " ")[:300])
    prefix = "Radar: " if completed.returncode == 0 else "Radar (não registrado): "
    return completed.returncode, (prefix + output)[:MAX_REPLY_CHARS]


def _find_adapter(gateway, platform):
    adapters = getattr(gateway, "adapters", None)
    if not adapters:
        return None
    try:
        adapter = adapters.get(platform)
    except Exception:
        adapter = None
    if adapter is not None:
        return adapter
    wanted = _platform_name(platform)
    try:
        for key, candidate in adapters.items():
            if _platform_name(key) == wanted:
                return candidate
    except Exception:
        return None
    return None


async def _reply(gateway, platform, chat_id: str, text: str, reply_to: str | None) -> bool:
    adapter = _find_adapter(gateway, platform)
    if adapter is None or not hasattr(adapter, "send"):
        return False
    result = adapter.send(chat_id, text, reply_to=reply_to)
    if inspect.isawaitable(result):
        result = await result
    success = getattr(result, "success", None)
    if success is None and isinstance(result, dict):
        success = result.get("success")
    return success is not False


async def on_pre_gateway_dispatch(event, gateway=None, session_store=None, **kwargs):
    """Hook ``pre_gateway_dispatch``: skip para respostas do Radar, None (allow) para o resto."""
    try:
        if getattr(event, "internal", False):
            return None
        payload = _inbound(event)
        if payload is None or not should_consume(payload):
            return None
    except Exception:
        logger.exception("radar_vagas: erro ao avaliar mensagem; seguindo despacho normal")
        return None

    try:
        _code, reply_text = await asyncio.to_thread(run_answer, payload)
    except Exception:
        logger.exception("radar_vagas: erro ao registrar resposta")
        reply_text = "Radar (não registrado): erro interno ao registrar a resposta."

    try:
        platform = getattr(getattr(event, "source", None), "platform", "telegram")
        if await _reply(gateway, platform, payload["chat_id"], reply_text, payload.get("message_id")):
            return {"action": "skip", "reason": "radar-vagas-answer"}
    except Exception:
        logger.exception("radar_vagas: falha ao responder pelo adapter")
    # Sem adapter para responder: o agente repassa o resultado (o texto original não segue).
    return {
        "action": "rewrite",
        "text": f"[Radar de Vagas — mensagem do sistema] {reply_text}\nApenas informe este resultado ao usuário; não execute nenhuma ação.",
    }


def radar_command(raw_args: str = "") -> str:
    """Handler de ``/radar``: só ajuda. O registro acontece no hook (que tem remetente e message_id)."""
    return USAGE


def register(ctx):
    ctx.register_hook("pre_gateway_dispatch", on_pre_gateway_dispatch)
    try:
        ctx.register_command("radar", handler=radar_command, description="Radar de Vagas: responder perguntas humanas")
    except Exception:
        logger.exception("radar_vagas: não registrou /radar (o hook continua ativo)")
