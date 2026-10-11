# Segurança

O Radar guarda currículos, vagas e decisões do usuário e aciona um executor de candidaturas. Por isso nenhuma rota de dados é aberta: o acesso exige um token interno (agentes e scripts) ou uma sessão do dashboard. A fronteira de rede (bind em loopback, firewall, proxy TLS) continua necessária, mas não é a única barreira.

## Autenticação (contrato C3)

| Quem | Mecanismo | Onde fica o segredo |
| --- | --- | --- |
| Agentes, MCP auxiliar e scripts de `scripts/ops/` | header `x-radar-service-token` igual a `RADAR_INTERNAL_SERVICE_TOKEN` (comparação em tempo constante) | `.env.local` (modo 600) |
| Pessoa no navegador | `GET /auth?token=<RADAR_DASHBOARD_TOKEN>` grava o cookie `radar_session` (HttpOnly; SameSite=Strict; Path=/; Secure quando há TLS) e redireciona para `/` | `.env.local` (modo 600) |

- Exceções sem credencial: apenas `GET /api/health` e `GET /api/ready`.
- O token interno é obrigatório em todos os ambientes; sem ele configurado, as rotas internas respondem `503 internal_token_not_configured`.
- O link de sessão é gerado por `node scripts/ops/dashboard-link.mjs` e pode ser enviado ao operador pelo Telegram do Hermes com `--send` (`hermes send`). Trate o link como senha: para revogá-lo, gere outro `RADAR_DASHBOARD_TOKEN` e reinicie o serviço.
- Nunca imprima tokens em log, relatório, issue ou conversa. `ops/hermes/radar.env.example` traz os nomes, nunca valores.

## Proteções de requisição

- **Bind**: `RADAR_BIND_HOST` (padrão `127.0.0.1`). Exponha fora do container somente por proxy TLS ou, na LAN, com firewall restrito à sub-rede doméstica.
- **Host**: só hosts de `RADAR_ALLOWED_HOSTS` são aceitos (resposta `421 host_not_allowed`) — mitiga DNS rebinding. Entradas sem porta valem também com a porta de escuta; `127.0.0.1`, `localhost` e `[::1]` são sempre aceitos.
- **Sessão**: `radar_session` é um id aleatório de 32 bytes guardado em memória (reiniciar o serviço encerra as sessões); validade `RADAR_SESSION_TTL_DAYS` (padrão 30). `POST /api/logout` revoga a sessão.
- **Corpo**: só objeto JSON (`400 invalid_body`), limite de 1 MB por requisição (8 MB só no upload de currículo-base, `413 payload_too_large`); campos validados com zod, URLs só `http(s)`.
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
- o servidor MCP é registrado como `trust: untrusted`: toda ferramenta que grava pede aprovação humana no Hermes;
- agentes continuam limitados por papel, `tool_scopes`, `allowed_domains` e campos editáveis;
- Browser Harness de leitura continua separado do executor de candidatura;
- CAPTCHA e bloqueios nunca são contornados;
- dúvidas continuam bloqueadas até resposta de uma identidade em `TELEGRAM_ALLOWED_USERS`.

## CI

A CI (`.github/workflows/ci.yml`) fixa actions por SHA, roda `npm audit --omit=dev --audit-level=high`, varre o repositório atrás de valores de secrets (tokens do Radar e do Telegram, chaves AWS, chaves privadas) e confere a cópia da skill no pacote do Hermes.
