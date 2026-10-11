"""Testes do plugin nativo radar_vagas (sem Hermes instalado: event/gateway/subprocess falsos).

Rodar da raiz do repositório:
    python3 -m unittest discover -s hermes/native-plugin
ou de dentro de hermes/native-plugin:
    python3 -m unittest
"""
import asyncio
import importlib.util
import json
import logging
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("radar_vagas", HERE / "radar_vagas" / "__init__.py")
radar_vagas = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(radar_vagas)

ALLOWED = "1650486356"


class Platform:
    """Imita o enum Platform do gateway (valor em .value)."""

    def __init__(self, value):
        self.value = value

    def __hash__(self):
        return hash(self.value)

    def __eq__(self, other):
        return isinstance(other, Platform) and other.value == self.value


TELEGRAM = Platform("telegram")


def make_event(text, user_id=ALLOWED, chat_id=ALLOWED, message_id="9001", reply_to=None, platform=TELEGRAM, internal=False):
    source = SimpleNamespace(platform=platform, chat_id=chat_id, user_id=user_id, chat_type="dm")
    event = SimpleNamespace(text=text, source=source, message_id=message_id, internal=internal)
    if reply_to is not None:
        event.reply_to_message_id = reply_to
    return event


class FakeAdapter:
    def __init__(self, success=True):
        self.sent = []
        self.success = success

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        self.sent.append({"chat_id": chat_id, "content": content, "reply_to": reply_to})
        return SimpleNamespace(success=self.success, message_id="1")


def completed(code=0, stdout="resposta registrada: [ab12cd] cnh · estado answered", stderr=""):
    return subprocess.CompletedProcess(args=[], returncode=code, stdout=stdout, stderr=stderr)


class RadarPluginTest(unittest.TestCase):
    def setUp(self):
        logging.disable(logging.CRITICAL)
        self.addCleanup(logging.disable, logging.NOTSET)
        self.tmp = tempfile.TemporaryDirectory()
        self.app_dir = Path(self.tmp.name)
        (self.app_dir / ".radar").mkdir()
        (self.app_dir / ".radar" / "telegram-refs.json").write_text(
            json.dumps({"refs": {f"telegram:{ALLOWED}:777": {"question_id": "ab12cd34", "code": "ab12cd"}}}),
            encoding="utf-8",
        )
        self.env = mock.patch.dict(os.environ, {
            "RADAR_APP_DIR": str(self.app_dir),
            "TELEGRAM_ALLOWED_USERS": ALLOWED,
            "RADAR_ANSWER_ALLOWED_USERS": "",
            "RADAR_TELEGRAM_REFS_PATH": "",
            "RADAR_NODE_BIN": "/usr/bin/node",
        })
        self.env.start()
        self.adapter = FakeAdapter()
        self.gateway = SimpleNamespace(adapters={TELEGRAM: self.adapter})

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def dispatch(self, event, gateway=None):
        return asyncio.run(radar_vagas.on_pre_gateway_dispatch(event, gateway=gateway or self.gateway, session_store=None))

    def test_command_from_allowed_user_is_consumed_and_answered(self):
        with mock.patch.object(radar_vagas.subprocess, "run", return_value=completed()) as run:
            result = self.dispatch(make_event("/radar responder ab12cd Sim, categoria B"))
        self.assertEqual(result, {"action": "skip", "reason": "radar-vagas-answer"})
        args, kwargs = run.call_args
        self.assertEqual(args[0], ["/usr/bin/node", str(self.app_dir / "scripts/ops/answer-human-questions.mjs"), "--stdin-json"])
        self.assertNotIn("shell", kwargs)
        self.assertEqual(kwargs["timeout"], radar_vagas.TIMEOUT_SECONDS)
        self.assertEqual(json.loads(kwargs["input"]), {
            "platform": "telegram", "chat_id": ALLOWED, "user_id": ALLOWED, "message_id": "9001",
            "reply_to_message_id": None, "text": "/radar responder ab12cd Sim, categoria B",
        })
        self.assertEqual(len(self.adapter.sent), 1)
        self.assertEqual(self.adapter.sent[0]["chat_id"], ALLOWED)
        self.assertEqual(self.adapter.sent[0]["reply_to"], "9001")
        self.assertTrue(self.adapter.sent[0]["content"].startswith("Radar: resposta registrada"))

    def test_pular_and_parar_commands_are_consumed(self):
        for text in ("/radar pular ab12cd", "/radar parar ab12cd", "/radar@RadarBot responder ab12cd ok"):
            with mock.patch.object(radar_vagas.subprocess, "run", return_value=completed()):
                self.assertEqual(self.dispatch(make_event(text))["action"], "skip", text)

    def test_plain_text_is_not_consumed(self):
        with mock.patch.object(radar_vagas.subprocess, "run") as run:
            for text in ("sim", "qual o clima amanhã?", "cancelar", "/radar", "/radar ajuda", "/radar responder"):
                self.assertIsNone(self.dispatch(make_event(text)), text)
        run.assert_not_called()
        self.assertEqual(self.adapter.sent, [])

    def test_reply_to_radar_question_is_consumed(self):
        with mock.patch.object(radar_vagas.subprocess, "run", return_value=completed()) as run:
            result = self.dispatch(make_event("Sim, tenho", reply_to="777"))
        self.assertEqual(result["action"], "skip")
        self.assertEqual(json.loads(run.call_args.kwargs["input"])["reply_to_message_id"], "777")

    def test_reply_to_other_message_is_not_consumed(self):
        with mock.patch.object(radar_vagas.subprocess, "run") as run:
            self.assertIsNone(self.dispatch(make_event("Sim", reply_to="12345")))
        run.assert_not_called()

    def test_unauthorized_user_is_not_consumed(self):
        with mock.patch.object(radar_vagas.subprocess, "run") as run:
            self.assertIsNone(self.dispatch(make_event("/radar responder ab12cd sim", user_id="999")))
            self.assertIsNone(self.dispatch(make_event("/radar responder ab12cd sim", user_id=None)))
            self.assertIsNone(self.dispatch(make_event("/radar responder ab12cd sim", chat_id=None)))
        run.assert_not_called()

    def test_missing_allowlist_fails_closed(self):
        with mock.patch.dict(os.environ, {"TELEGRAM_ALLOWED_USERS": "", "RADAR_ANSWER_ALLOWED_USERS": ""}), \
                mock.patch.object(radar_vagas.subprocess, "run") as run:
            self.assertIsNone(self.dispatch(make_event("/radar responder ab12cd sim")))
        with mock.patch.dict(os.environ, {"TELEGRAM_ALLOWED_USERS": "*"}), \
                mock.patch.object(radar_vagas.subprocess, "run") as run2:
            self.assertIsNone(self.dispatch(make_event("/radar responder ab12cd sim")))
        run.assert_not_called()
        run2.assert_not_called()

    def test_other_platform_and_internal_events_pass_through(self):
        with mock.patch.object(radar_vagas.subprocess, "run") as run:
            self.assertIsNone(self.dispatch(make_event("/radar responder ab12cd sim", platform=Platform("discord"))))
            self.assertIsNone(self.dispatch(make_event("/radar responder ab12cd sim", internal=True)))
        run.assert_not_called()

    def test_script_failure_is_reported_and_still_consumed(self):
        with mock.patch.object(radar_vagas.subprocess, "run", return_value=completed(4, "", "usuário não autorizado")):
            result = self.dispatch(make_event("/radar responder ab12cd sim"))
        self.assertEqual(result["action"], "skip")
        self.assertIn("não registrado", self.adapter.sent[0]["content"])

    def test_timeout_and_crash_never_raise(self):
        with mock.patch.object(radar_vagas.subprocess, "run", side_effect=subprocess.TimeoutExpired(cmd="node", timeout=30)):
            self.assertEqual(self.dispatch(make_event("/radar responder ab12cd sim"))["action"], "skip")
        with mock.patch.object(radar_vagas.subprocess, "run", side_effect=RuntimeError("boom")):
            self.assertEqual(self.dispatch(make_event("/radar responder ab12cd sim"))["action"], "skip")
        self.assertIn("demorou", self.adapter.sent[0]["content"])

    def test_without_adapter_falls_back_to_rewrite(self):
        with mock.patch.object(radar_vagas.subprocess, "run", return_value=completed()):
            result = self.dispatch(make_event("/radar responder ab12cd sim"), gateway=SimpleNamespace(adapters={}))
        self.assertEqual(result["action"], "rewrite")
        self.assertIn("Radar de Vagas", result["text"])
        self.assertNotIn("/radar responder", result["text"])

    def test_adapter_lookup_by_string_key(self):
        gateway = SimpleNamespace(adapters={"telegram": self.adapter})
        with mock.patch.object(radar_vagas.subprocess, "run", return_value=completed()):
            self.assertEqual(self.dispatch(make_event("/radar pular ab12cd"), gateway=gateway)["action"], "skip")

    def test_corrupted_refs_file_does_not_crash(self):
        (self.app_dir / ".radar" / "telegram-refs.json").write_text("{not json", encoding="utf-8")
        with mock.patch.object(radar_vagas.subprocess, "run") as run:
            self.assertIsNone(self.dispatch(make_event("Sim", reply_to="777")))
        run.assert_not_called()

    def test_register_wires_hook_and_help_command(self):
        ctx = mock.Mock()
        radar_vagas.register(ctx)
        ctx.register_hook.assert_called_once_with("pre_gateway_dispatch", radar_vagas.on_pre_gateway_dispatch)
        name = ctx.register_command.call_args.args[0]
        handler = ctx.register_command.call_args.kwargs["handler"]
        self.assertEqual(name, "radar")
        self.assertIn("/radar responder", handler(""))

    def test_plugin_yaml_declares_metadata(self):
        manifest = (HERE / "radar_vagas" / "plugin.yaml").read_text(encoding="utf-8")
        for key in ("name: radar_vagas", "version:", "description:", "requires_env:", "TELEGRAM_ALLOWED_USERS"):
            self.assertIn(key, manifest)


if __name__ == "__main__":
    unittest.main()
