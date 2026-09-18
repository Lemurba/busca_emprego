# Onboarding do Busca Emprego no Hermes

Este é o manual operacional que o Hermes deve seguir ao instalar ou reconfigurar o plugin. Existe **uma única aplicação**, instalada com configuração de produção; o usuário não escolhe entre staging e production. O mesmo artefato pode ser testado isoladamente antes do start, sem criar outra variante do aplicativo. O contrato legível por máquina está em `onboarding.json`. Os 16 portais e 24 agentes padrão começam ativos. Falta de credencial, login ou teste pausa somente a execução dependente.

## 1. Regras que o Hermes deve obedecer

1. Nunca pedir senha, cookie, token ou chave em chat, formulário comum, log ou configuração do plugin.
2. Para um segredo novo, abrir a entrada segura do secret store do Hermes. Depois, passar ao plugin somente uma referência `hermes://...` ou `vault://...`.
3. Para login por navegador, abrir uma sessão de autenticação do Browser Harness e deixar o usuário digitar a credencial diretamente na janela segura. Guardar apenas `browser_profile_id`.
4. Manter todos os portais padrão habilitados e registrar domínio, autenticação e operações configuradas.
5. Manter leitura/enriquecimento separados da sessão de candidatura. CAPTCHA, MFA ou dúvida interrompem o fluxo; nunca são contornados.
6. `APROVO` aprova uma versão de currículo. Somente `AUTORIZO` permite uma candidatura automática para a vaga, currículo, versão e URL exatos.
7. Usar exclusivamente a integração Telegram já vinculada ao Hermes. Não pedir bot token, chat ID, destinatário ou criação de outro bot.

## 2. Conversa inicial obrigatória

O Hermes usa os padrões `/opt/hermes/plugins/busca-emprego`, `/var/lib/hermes/busca-emprego/radar.sqlite` e porta interna `8787`. Só pergunta o que não puder descobrir automaticamente. Texto recomendado:

> Vou instalar a única versão de produção do Busca Emprego usando os padrões do Hermes. O dashboard e a API ficarão abertos na rede doméstica, sem login ou token. Usarei o Telegram que já está vinculado ao Hermes.

> Qual identificador do operador responsável por esta instalação? Ele será usado em `RADAR_OPERATOR_ID` e na auditoria.

> Os 16 portais e 24 agentes padrão começarão ativos. Deseja configurar agora alguma credencial ou perfil de navegador exigido por uma fonte?

O Hermes não faz pergunta de configuração do Telegram. Ele apenas verifica silenciosamente se a capability `telegram.question` já vinculada responde. Ao final, mostra um resumo sem valores secretos e pede confirmação para construir e iniciar. O agendamento permanece desligado até o smoke test manual passar.

## 3. Coleta de credenciais

“Entrada segura” significa uma capability nativa do host que não devolve o valor ao modelo nem o grava na conversa. Se o host não oferecer essa capability, o Hermes deve parar e orientar o operador a criar o segredo diretamente no cofre; não deve pedir que o usuário cole o valor como alternativa.

| Estratégia | Pergunta do Hermes | O que fica no plugin |
| --- | --- | --- |
| `none` | “Esta fonte é pública e não exige login?” | nenhuma credencial |
| `bearer` | “Abra o cofre e informe o token desta fonte.” | `secret_ref`, por exemplo `hermes://busca-emprego/fontes/exemplo-token` |
| `basic` | “Abra o cofre e informe usuário/senha desta fonte.” | uma referência ao conjunto seguro, nunca usuário/senha |
| `browser_profile` | “Deseja criar ou selecionar um perfil isolado e autenticar-se na janela segura?” | `browser_profile_id` |

Para uma fonte adicional, o Hermes pergunta somente:

- nome e domínio exato;
- operações desejadas: descoberta, enriquecimento e/ou consulta salarial;
- quais agentes podem usar a fonte e quais domínios entram em `allowed_domains`.

### Glassdoor

Quando a consulta exigir sessão autenticada, use `browser_profile`; token/cookie manual não deve ser solicitado. O diálogo é:

> Para o Glassdoor, vou usar um perfil isolado do Browser Harness. Não informe sua senha no chat. Posso abrir a janela segura para você entrar e concluir MFA, se houver?

Depois do login, o Hermes valida o perfil com uma navegação somente leitura, registra o `browser_profile_id`, confirma o domínio permitido e testa uma consulta sem candidatura. Sessão de descoberta não é reutilizada pelo executor de candidaturas. CAPTCHA ou bloqueio pausa a execução para ação humana; o conector permanece ativo.

## 4. Gateways internos

O Radar não possui login, chave da API, `RADAR_AUTH_CREDENTIALS` ou escopos HTTP. O Hermes fornece internamente a capability necessária para seus próprios gateways; esse vínculo não é uma credencial que o usuário precise digitar no dashboard.

Configuração mínima do plugin:

```json
{
  "projectId": "busca-emprego",
  "apiBaseUrl": "http://127.0.0.1:8787",
  "maxConcurrency": 20,
  "maxPerDomain": 1,
  "batchSize": 25,
  "timeoutMs": 120000,
  "retry": {"delaysMs":[1000,5000,15000],"jitterRatio":0.2},
  "integration": {
    "hermesBaseUrl": "https://hermes-gateway.internal",
    "browserHarnessBaseUrl": "https://browser-harness.internal",
    "serviceTokenSecretRef": "hermes://busca-emprego/runtime-service-token",
    "requestTimeoutMs": 120000,
    "allowInsecureLocalhost": false
  }
}
```

O gateway do Hermes expõe `v1/plugin-agents/invoke` e `v1/telegram/questions`; o último usa a conta/capability Telegram já vinculada. O Browser Harness expõe `v1/read` e `v1/applications/execute`. HTTPS é obrigatório, exceto localhost quando `allowInsecureLocalhost=true` for escolhido explicitamente para desenvolvimento.

## 5. Construir e iniciar

No container Hermes existente, sem criar outro container:

```sh
cd /opt/hermes/plugins/busca-emprego
npm ci
npm test
RADAR_OPERATOR_ID=operador-responsavel \
RADAR_APP_DIR=/opt/hermes/plugins/busca-emprego \
RADAR_DB_PATH=/var/lib/hermes/busca-emprego/radar.sqlite \
PORT=8787 \
ops/hermes/radar-process.sh
```

Em operação contínua, o Hermes registra `ops/hermes/radar-process.sh` no supervisor já usado pelo container, conforme `ops/hermes/supervisord-radar.conf.example`. O processo escuta em `0.0.0.0:8787`, portanto o roteador/firewall deve permitir a porta somente na rede doméstica e bloqueá-la na WAN.

Ordem de verificação:

1. `GET /api/health` retorna sucesso.
2. `GET /api/ready` confirma SQLite, ambiente e operador.
3. `GET /api/bootstrap` funciona sem token ou login a partir de outro dispositivo da LAN.
4. `scripts/ops/verify-environment.mjs` confirma que a URL é HTTPS ou HTTP em endereço privado da LAN.

Falha em qualquer item faz o Hermes parar o processo ou mantê-lo fora do tráfego; agentes continuam configurados e o cron não inicia até correção.

## 6. Primeiro teste de agente e fonte

O aplicativo já cadastra os 16 portais e publica um `source_scout` separado para cada um. Para fonte adicional, o Hermes usa `/api/sources` com somente `secret_ref` ou `browser_profile_id` e cria um coletor com:

- `source_ids` contendo somente a fonte configurada;
- `allowed_domains` com o domínio confirmado;
- `browser.read`, `jobs.read` e `jobs.create`, sem capability de candidatura;
- concorrência 1 no primeiro teste;
- prompt orientado a registrar URL e evidência sem inventar campos.

Salvar cria uma versão `draft`. O Hermes executa o teste com fixture, mostra diff/capabilities ao operador e só então publica pela rota `/api/agents/{id}/publish`. Rollback usa `/api/agents/{id}/rollback` e sempre cria uma nova versão auditável.

Depois, faça uma execução manual com uma fonte. Confirme que a vaga contém `source_url`, que cada campo enriquecido possui evidência e que divergências aparecem como conflito revisável. Somente após esse teste o Hermes pergunta se deve habilitar o cron/swarm.

## 7. Telegram e candidatura

O Hermes fornece ao plugin a capability Telegram e a identidade vinculada à conta atual. O plugin não possui configuração de bot ou destinatário e não inclui `recipientId` na requisição: `v1/telegram/questions` entrega pelo vínculo já mantido pelo Hermes. O setup executa apenas um teste de capability. Uma resposta resolve somente o `human_question_id` correspondente e não concede `AUTORIZO`.

O executor de candidatura usa o Browser Harness separado e chama `v1/applications/execute` somente com o envelope vigente de autorização. Mudança de URL, currículo ou versão invalida a autorização. Sem evidência observável do portal, o resultado não pode ser `submitted`.

## 8. Reconfiguração, rotação e recuperação

- Rotação: atualizar o valor no cofre mantendo a referência quando possível; testar o gateway e revogar o valor antigo.
- Fonte bloqueada: pausar a execução afetada, preservar auditoria e pedir ação sobre login, MFA ou CAPTCHA; manter o conector configurado.
- Telegram indisponível: manter a candidatura em `needs_review`.
- Nova configuração de agente: criar draft, testar, publicar; nunca editar snapshot publicado no banco.
- Falha de release: seguir `docs/operations-runbook.md`, incluindo backup, restore testado e rollback do release.

O onboarding está concluído quando health, readiness, acesso sem login pela LAN, autenticação das fontes que precisarem, agentes padrão publicados, proveniência/conflito e capability Telegram vinculada tiverem evidências de teste. Se Telegram do Hermes estiver indisponível, busca continua, mas candidatura com dúvida permanece em `needs_review`.
