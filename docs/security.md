# Segurança

O Radar guarda currículos, vagas e decisões do usuário e aciona um executor de candidaturas. Por isso nenhuma rota de dados é aberta: o acesso exige um token interno (agentes e scripts) ou uma sessão do dashboard. A fronteira de rede (bind em loopback, firewall, proxy TLS) continua necessária, mas não é a única barreira.

## Autenticação (contrato C3)

| Quem | Mecanismo | Onde fica o segredo |
| --- | --- | --- |
| Agentes, MCP auxiliar e scripts de `scripts/ops/` | header `x-radar-service-token` igual a `RADAR_INTERNAL_SERVICE_TOKEN` (comparação em tempo constante); nunca alcança os portões humanos | `.env.local` (modo 600, usuário `radar`) |
| Pessoa no navegador | `GET /auth?token=<RADAR_DASHBOARD_TOKEN>` grava o cookie `radar_session` (HttpOnly; SameSite=Strict; Path=/; Secure quando há TLS) e redireciona para `/` | `.env.local` (modo 600, usuário `radar`) |

- Exceções sem credencial: apenas `GET /api/health` e `GET /api/ready`.
- O token interno é obrigatório em todos os ambientes; sem ele configurado, as rotas internas respondem `503 internal_token_not_configured`.
- Decisões humanas aceitam **só a sessão do dashboard** (o token de serviço recebe `403 human_session_required`): `authorize-auto` (AUTORIZO), `confirm-final` (ENVIAR), `cancel-final`, `PUT /api/settings/automation` (kill-switch, limites, allowlist de ATS) e a captura `GET /api/applications/{id}/evidence/{evidenceId}`. Um agente com o token interno não consegue autorizar nem confirmar o próprio envio.
- O link de sessão é gerado por `node scripts/ops/dashboard-link.mjs` e pode ser enviado ao operador pelo Telegram do Hermes com `--send` (`hermes send`). Trate o link como senha: para revogá-lo (e encerrar todas as sessões abertas), gere outro `RADAR_DASHBOARD_TOKEN` e reinicie o serviço.
- Nunca imprima tokens em log, relatório, issue ou conversa. `ops/hermes/radar.env.example` traz os nomes, nunca valores.
- `/auth` limita tentativas erradas **por IP de origem** (20 em 10 minutos → `429` só para esse IP). Um token válido sempre autentica, mesmo com o limite atingido: o limite só barra novas falhas, e nenhum dispositivo da LAN tranca o dono. `X-Forwarded-For` só é considerado quando a conexão vem do proxy em loopback com `RADAR_TRUST_PROXY_TLS=true`, e vale a entrada mais à direita (a que o proxy acrescentou). O proxy não deve registrar a query string de `/auth` (veja `ops/hermes/nginx-radar.conf.example`). Risco aceito: o token do link não expira e passa pelo histórico do Telegram; rotacione-o se o link vazar.

## Portões humanos (#10)

Interesse, `APROVO` e `AUTORIZO` são decisões humanas, e o servidor garante isso pela credencial, não pelo prompt. As rotas abaixo só aceitam a **sessão do dashboard**; com o token de serviço respondem `403 human_session_required` (sem credencial, `401`):

| Rota | Decisão |
| --- | --- |
| `POST /api/jobs/{id}/decision`, `/decision/undo`, `/feedback`, `/restore`; `DELETE /api/jobs/{id}` | interesse, sem tempo, descarte, desfazer, excluir/restaurar |
| `POST /api/resumes/{id}/approve` | `APROVO` |
| `POST /api/applications`; `PATCH /api/applications/{id}` | criar candidatura; registrar envio manual/resultado |
| `POST /api/applications/{id}/authorize-auto`, `/revoke-auto`, `/select-manual` | `AUTORIZO`, revogação, modo manual |
| `POST /api/profiles/{id}/confirm`, `/facts/{factId}/review` | confirmar perfil e revisar cada fato (usados nos currículos e na nota) |
| `POST /api/profiles`, `POST /api/profiles/{id}/facts`, `PATCH /api/profiles/{id}` com fato `origin: "user"` ou `state: "confirmed"` | declarar fato em nome do usuário ou gravá-lo já confirmado |
| `POST /api/possible-duplicates/{id}/resolve`, `/undo` | mesclar/separar duplicatas e desfazer a decisão (24 h; mesclar só registra a decisão, nenhuma vaga é apagada) |
| `POST /api/human-questions/{id}/respond` | responder pelo painel a pergunta do executor (inclusive a que não chegou ao Telegram) |
| `POST /api/field-conflicts/{id}/resolve` | escolher entre o valor atual e o do enriquecimento |
| `DELETE /api/base-resumes/{id}` | excluir o currículo-base (PDF) |
| `DELETE /api/agents/{id}`, `DELETE /api/sources/{id}` | excluir agente ou fonte (irreversível; o serviço pode pausar) |
| `PUT /api/sources/{id}` ou `POST /api/sources` que religa uma fonte desligada | voltar a buscar numa fonte que a pessoa desligou (o serviço pode atualizá-la e desligá-la) |
| `PATCH /api/resumes/{id}` de um currículo aprovado | devolver para revisão, o que desfaz o `APROVO` e revoga o `AUTORIZO` |
| `POST /api/sources/{id}/terms` | aceitar termos de uso de uma fonte |
| `POST /api/agents`; `POST /api/agents/{id}/publish`, `/rollback`, `/discard-draft` | criar agente (nasce publicado), publicar permissões e prompt (rascunho que não é humano só com o checksum do diff revisado) e descartar rascunho |

O token de serviço continua servindo às rotas de automação (descoberta, enriquecimento, rascunho de currículo, revisão ATS, nota, fila autorizada, claim/submit/fail, perguntas humanas). No perfil ele só **propõe**: fato sem `origin` vindo do serviço (ou de um agente MCP) é gravado como `derived`/`proposed` com o trecho "Informado por service:<nome>", e a resposta de entrevista repassada pelo Hermes (`POST /api/profiles/{id}/interview`) vira fato proposto, sem sobrescrever a declaração humana. O núcleo também recusa revisão e confirmação de perfil a atores `service:*`/`agent:*` (`profile.fact.review.forbidden`, `profile.confirm.forbidden`).

### Isolamento por usuário Unix

O portão só vale se o Hermes não conseguir virar "humano". Por isso:

- o dashboard roda com um **usuário Unix dedicado** (ex.: `radar`), diferente do usuário do Hermes (`hermes`);
- `.env.local` (com `RADAR_INTERNAL_SERVICE_TOKEN` e `RADAR_DASHBOARD_TOKEN`) e o banco SQLite (com `-wal`/`-shm`) pertencem a `radar` com modo `600`; o diretório de dados, `700`. O usuário `hermes` não lê nenhum deles;
- o código do release pertence a `radar` (ou root) e não é gravável pelo `hermes`;
- o link de sessão (`scripts/ops/dashboard-link.mjs`) é gerado pelo operador como `radar`, nunca pelo agente.

**MCP pela API (#10):** o servidor MCP (`src/mcp-server.ts`) não abre o SQLite. Cada ferramenta chama a API do dashboard (`RADAR_API_URL`) com o token de serviço, então o processo roda como `hermes`, sem acesso ao banco nem ao `.env.local`, e passa pelos mesmos portões de qualquer cliente do token: nenhuma ferramenta chama rota humana e, se chamasse, receberia 403. Rotas de agente usadas só pelo MCP (`POST /api/agents/{id}/jobs|batches|runs|jobs/{id}/enrichment`, `GET /api/applications/{id}/authorization`) aceitam somente o token de serviço, exigem o agente da rota publicado e ativo (lote e execução também na API) e conferem `allowed_domains` dos itens no servidor; `x-radar-agent-id` diferente do agente da rota é recusado (409 `agent.binding.mismatch`). O cabeçalho `x-radar-agent-id` (agente existente no projeto) rotula o ator como `agent:<agent_id>`, que o núcleo trata como serviço: só propõe.

## Origem nas auditorias (#19)

O ator de cada evento de workflow e de auditoria vem da credencial: `human:dashboard` (sessão), `service:<nome>` (token de serviço; `<nome>` vem do header opcional `x-radar-service-name`, padrão `internal`, e só rotula — não dá permissão) e `agent:<agent_id>` (ferramentas MCP). O executor grava `worker:<worker_id>`. O detalhe da vaga no dashboard mostra o histórico com a origem de cada passo (`GET /api/jobs/{id}/history`). Eventos antigos com ator genérico (`user`, `lan-user`) aparecem como "origem não identificada".

## Proteções de requisição

- **Bind**: `RADAR_BIND_HOST` (padrão `127.0.0.1`). Com um IP específico de LAN, o servidor também escuta em `127.0.0.1:PORT`, para que watchdog, health check, pontes do Telegram e executor continuem funcionando. Exponha fora do container somente por proxy TLS ou, na LAN, com firewall restrito à sub-rede doméstica.
- **Host**: só hosts de `RADAR_ALLOWED_HOSTS` são aceitos (resposta `421 host_not_allowed`) — mitiga DNS rebinding. Entradas sem porta valem também com a porta de escuta; `127.0.0.1`, `localhost` e `[::1]` são sempre aceitos.
- **Sessão**: `radar_session` é um id aleatório de 32 bytes; o servidor guarda só o sha256 do id, no SQLite (`dashboard_sessions`), então reiniciar o serviço não desloga ninguém. Cada sessão fica amarrada à impressão digital do `RADAR_DASHBOARD_TOKEN` vigente: trocar o token e reiniciar encerra todas. Validade `RADAR_SESSION_TTL_DAYS` (padrão 30). `POST /api/logout` revoga a sessão.
- **Corpo**: só objeto JSON (`400 invalid_body`), limite de 1 MB por requisição (8 MB só no upload de currículo-base, `413 payload_too_large`); campos validados com zod em objetos estritos (campo não previsto → `400 invalid_body` com `field.not_allowed`), URLs só `http(s)`.
- **Upload de PDF**: assinatura `%PDF-` obrigatória; a extração (pdfjs e o extrator legado) roda num worker com `resourceLimits` e timeout, e cada stream comprimido é limitado (`maxOutputLength`), o que neutraliza bombas de compressão.
- **Log de requisições**: uma linha JSON `http.request` por requisição com `request_id`, método, caminho (sem query string), status e duração. O `X-Request-Id` recebido do proxy é reaproveitado quando bem formado; senão o servidor gera um. O valor volta no header `x-request-id` e aparece também em `http.error`.
- **Erros**: respostas `{ error: <código estável>, message: <texto pt-BR> }`; erro inesperado vira `500 internal_error` com mensagem genérica, detalhes só no log.
- **CSRF**: rotas mutantes exigem `Content-Type: application/json` (exceto uploads com tipo próprio) e, quando o navegador envia `Origin`, ele precisa casar com o `Host`. O cookie é `SameSite=Strict`.
- **TLS por proxy**: `x-forwarded-proto` só é confiado quando a conexão vem de loopback e `RADAR_TRUST_PROXY_TLS=true`.
- Cabeçalhos: CSP, `frame-ancestors 'none'`, `nosniff`, política de permissões e referrer restritivo.

## Regras de rede

- Porta canônica 8787 (uma instalação pode trocar via `PORT` no `.env.local`).
- Não crie port forwarding, UPnP, túnel público ou regra WAN para a porta do Radar. Para acesso remoto, use VPN privada.
- `scripts/ops/verify-environment.mjs` aceita HTTPS ou HTTP apenas para localhost, `.local` e endereços privados.

## Segredos fora do Radar

- Logins de portais: cofre de credenciais do Hermes (`hermes vault add`); o modelo nunca vê a senha e o banco do Radar guarda só `secret_ref`/`browser_profile_id`.
- Bot do Telegram: `TELEGRAM_BOT_TOKEN` no `.env` do Hermes (`/opt/data/.env`). O Radar só usa os identificadores `TELEGRAM_ALLOWED_USERS`/`TELEGRAM_HOME_CHANNEL`.
- O servidor MCP recebe ambiente filtrado pelo Hermes; `hermes/plugin/mcp.json` e `hermes/config.example.yaml` não contêm credenciais.
- `ops/hermes/radar-s6-run.sh` exporta ao processo só as chaves da sua allowlist, sem `source` do `.env.local`.

## Controles funcionais

- candidatura automática exige `AUTORIZO` para vaga, currículo, versão e URL exatos; `APROVO` não equivale a `AUTORIZO`;
- envio automático só em ATS de empresa (allowlist em `settings`, host igual ou subdomínio), conferido ao autorizar, reservar, pedir a confirmação final e enviar — também nas rotas HTTP, não só no MCP;
- dry-run sempre: o executor para antes do clique final e envia captura PNG (até 2 MB, assinatura conferida) + resumo dos campos; o envio exige um `submit_token` aleatório de uso único, gerado após o ENVIAR humano e entregue uma vez ao worker dono do claim; o banco guarda só o SHA-256;
- limite diário de envios automáticos (padrão 5, America/Sao_Paulo; opcional por ATS) e kill-switch no banco, relido a cada verificação pelos dois processos; `RADAR_AUTO_APPLICATION_ENABLED` continua sendo o teto;
- o servidor MCP é registrado como `trust: untrusted`: toda ferramenta que grava pede aprovação humana no Hermes;
- agentes continuam limitados por papel, `tool_scopes`, `allowed_domains` e campos editáveis;
- Browser Harness de leitura continua separado do executor de candidatura;
- CAPTCHA e bloqueios nunca são contornados;
- dúvidas continuam bloqueadas até resposta de uma identidade em `TELEGRAM_ALLOWED_USERS`.

## Riscos aceitos

- **IP da LAN no histórico do Git**: um endereço privado da rede doméstica (RFC 1918) aparece em commits antigos, fora da árvore atual. Reescrever o histórico quebraria clones e referências existentes para proteger um dado de baixa sensibilidade (endereço não roteável, sem credencial associada), então o risco foi aceito. Nenhum IP ou caminho específico de máquina deve voltar a arquivos versionados.

## CI

A CI (`.github/workflows/ci.yml`) roda em matriz Node 22.16 (mínimo de `engines`) e 24, fixa actions por SHA, roda `npm audit --omit=dev --audit-level=high`, varre o repositório atrás de valores de secrets (tokens do Radar e do Telegram, chaves AWS, chaves privadas) e confere a cópia da skill no pacote do Hermes.
