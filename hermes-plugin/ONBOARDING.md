# Onboarding do Busca Emprego no Hermes

Este é o manual operacional que o Hermes deve seguir ao instalar ou reconfigurar o plugin. O contrato legível por máquina está em `onboarding.json`; este guia explica as decisões, perguntas e verificações. O fluxo é **fail closed**: se uma resposta, credencial, autorização ou teste estiver ausente, o Hermes não habilita a fonte, o agente ou o agendamento correspondente.

## 1. Regras que o Hermes deve obedecer

1. Nunca pedir senha, cookie, token ou chave em chat, formulário comum, log ou configuração do plugin.
2. Para um segredo novo, abrir a entrada segura do secret store do Hermes. Depois, passar ao plugin somente uma referência `hermes://...` ou `vault://...`.
3. Para login por navegador, abrir uma sessão de autenticação do Browser Harness e deixar o usuário digitar a credencial diretamente na janela segura. Guardar apenas `browser_profile_id`.
4. Só habilitar uma fonte após o usuário confirmar os termos, o domínio e as operações permitidas.
5. Manter leitura/enriquecimento separados da sessão de candidatura. CAPTCHA, MFA ou dúvida interrompem o fluxo; nunca são contornados.
6. `APROVO` aprova uma versão de currículo. Somente `AUTORIZO` permite uma candidatura automática para a vaga, currículo, versão e URL exatos.

## 2. Conversa inicial obrigatória

O Hermes deve perguntar uma coisa por vez e resumir a configuração antes de gravá-la. Texto recomendado:

> Vou configurar o Busca Emprego sem receber segredos neste chat. Primeiro: você quer usar **staging** (recomendado para o primeiro teste) ou **production**?

Depois:

> Qual identificador do operador responsável por esta instalação? Ele será usado em `RADAR_OPERATOR_ID` e na auditoria.

> Posso usar os caminhos padrão do ambiente escolhido para release, SQLite e backups, e a porta interna 18787 em staging/8787 em production?

> Vou criar ou selecionar duas credenciais da API no cofre: uma de usuário e uma de serviço. Abra a entrada segura do Hermes; não cole os tokens aqui.

> Quais fontes deseja ativar agora? Para cada uma, vou confirmar domínio, estratégia de autenticação, termos e operações permitidas.

> Deseja conectar o Telegram para dúvidas durante uma candidatura? Vou testar a capability e o destinatário autorizados sem expor bot token ou chat ID ao plugin.

Ao final, o Hermes mostra um resumo sem valores secretos e pede confirmação para construir e iniciar. O agendamento permanece desligado até o smoke test manual passar.

## 3. Coleta de credenciais

“Entrada segura” significa uma capability nativa do host que não devolve o valor ao modelo nem o grava na conversa. Se o host não oferecer essa capability, o Hermes deve parar e orientar o operador a criar o segredo diretamente no cofre; não deve pedir que o usuário cole o valor como alternativa.

| Estratégia | Pergunta do Hermes | O que fica no plugin |
| --- | --- | --- |
| `none` | “Esta fonte é pública e não exige login?” | nenhuma credencial |
| `bearer` | “Abra o cofre e informe o token desta fonte.” | `secret_ref`, por exemplo `hermes://busca-emprego/staging/fontes/exemplo-token` |
| `basic` | “Abra o cofre e informe usuário/senha desta fonte.” | uma referência ao conjunto seguro, nunca usuário/senha |
| `browser_profile` | “Deseja criar ou selecionar um perfil isolado e autenticar-se na janela segura?” | `browser_profile_id` |

Para toda fonte, o Hermes ainda pergunta:

- nome e domínio exato;
- operações desejadas: descoberta, enriquecimento e/ou consulta salarial;
- se os termos foram revisados e aceitos para essas operações;
- quais agentes podem usar a fonte e quais domínios entram em `allowed_domains`.

Se a resposta aos termos não for uma confirmação literal, a fonte deve ser salva desabilitada.

### Glassdoor

O padrão recomendado é `browser_profile`; token/cookie manual não deve ser solicitado. O diálogo é:

> Para o Glassdoor, vou usar um perfil isolado do Browser Harness. Não informe sua senha no chat. Posso abrir a janela segura para você entrar e concluir MFA, se houver?

Depois do login, o Hermes valida o perfil com uma navegação somente leitura, registra o `browser_profile_id`, confirma o domínio permitido e testa uma consulta sem candidatura. Sessão de Glassdoor não é reutilizada pelo executor de candidaturas. CAPTCHA ou bloqueio encerra o teste e mantém a fonte desabilitada.

## 4. Credenciais da API e gateways

O Hermes deve gerar dois tokens aleatórios diferentes, com pelo menos 32 caracteres, e montar `RADAR_AUTH_CREDENTIALS` dentro do secret store:

```json
[
  {"id":"usuario-principal","kind":"user","token":"VALOR_NO_COFRE","projects":["busca-emprego"],"tools":["*"]},
  {"id":"hermes-runtime","kind":"service","token":"OUTRO_VALOR_NO_COFRE","projects":["busca-emprego"],"tools":["jobs.write","applications.read","applications.write"]}
]
```

O texto acima descreve o formato; `VALOR_NO_COFRE` nunca deve aparecer em arquivo ou log. O token do runtime também é disponibilizado aos adapters por uma referência como `hermes://busca-emprego/staging/runtime-service-token`.

Configuração mínima do plugin:

```json
{
  "projectId": "busca-emprego",
  "apiBaseUrl": "http://127.0.0.1:18787",
  "maxConcurrency": 20,
  "maxPerDomain": 1,
  "batchSize": 25,
  "timeoutMs": 120000,
  "retry": {"delaysMs":[1000,5000,15000],"jitterRatio":0.2},
  "integration": {
    "hermesBaseUrl": "https://hermes-gateway.internal",
    "browserHarnessBaseUrl": "https://browser-harness.internal",
    "telegramGatewayBaseUrl": "https://telegram-gateway.internal",
    "serviceTokenSecretRef": "hermes://busca-emprego/staging/runtime-service-token",
    "requestTimeoutMs": 120000,
    "allowInsecureLocalhost": false
  }
}
```

Os gateways precisam expor `v1/plugin-agents/invoke`, `v1/read`, `v1/applications/execute` e `v1/telegram/questions`. HTTPS é obrigatório, exceto localhost quando `allowInsecureLocalhost=true` for escolhido explicitamente para desenvolvimento.

## 5. Construir e iniciar

No container Hermes existente, sem criar outro container:

```sh
cd /opt/hermes/plugins/busca-emprego-staging
npm ci
npm test
RADAR_OPERATOR_ID=operador-responsavel \
RADAR_APP_DIR=/opt/hermes/plugins/busca-emprego-staging \
RADAR_DB_PATH=/var/lib/hermes/busca-emprego-staging/radar.sqlite \
PORT=18787 \
ops/hermes/radar-process.sh
```

`RADAR_AUTH_CREDENTIALS` deve ser injetada pelo cofre no processo, não escrita nesse comando. Em operação contínua, o Hermes deve registrar `ops/hermes/radar-process.sh` no supervisor já usado pelo container; há exemplos em `ops/hermes/supervisord-radar*.conf.example`.

Ordem de verificação:

1. `GET /api/health` retorna sucesso.
2. `GET /api/ready` confirma SQLite, ambiente e operador.
3. `GET /api/bootstrap` sem token é recusado.
4. `GET /api/bootstrap` com a credencial de usuário funciona.
5. O endpoint externo TLS passa em `scripts/ops/verify-environment.mjs`.

Falha em qualquer item faz o Hermes parar o processo ou mantê-lo fora do tráfego; agentes e cron continuam desabilitados.

## 6. Primeiro agente e primeira fonte

O Hermes cadastra a fonte por `/api/sources` usando somente `secret_ref` ou `browser_profile_id`. Em seguida, cria um agente `source_scout` com:

- `source_ids` contendo somente a fonte validada;
- `allowed_domains` com o domínio confirmado;
- `browser.read`, `jobs.read` e `jobs.create`, sem capability de candidatura;
- concorrência 1 no primeiro teste;
- prompt orientado a registrar URL e evidência sem inventar campos.

Salvar cria uma versão `draft`. O Hermes executa o teste com fixture, mostra diff/capabilities ao operador e só então publica pela rota `/api/agents/{id}/publish`. Rollback usa `/api/agents/{id}/rollback` e sempre cria uma nova versão auditável.

Depois, faça uma execução manual com uma fonte. Confirme que a vaga contém `source_url`, que cada campo enriquecido possui evidência e que divergências aparecem como conflito revisável. Somente após esse teste o Hermes pergunta se deve habilitar o cron/swarm.

## 7. Telegram e candidatura

O Hermes seleciona uma capability Telegram já autorizada ou solicita bot/destinatário pela entrada segura do host. Envia uma mensagem de teste e verifica o remetente autorizado. Uma resposta do Telegram resolve apenas o `human_question_id` correspondente; ela não concede `AUTORIZO`.

O executor de candidatura usa o Browser Harness separado e chama `v1/applications/execute` somente com o envelope vigente de autorização. Mudança de URL, currículo ou versão invalida a autorização. Sem evidência observável do portal, o resultado não pode ser `submitted`.

## 8. Reconfiguração, rotação e recuperação

- Rotação: atualizar o valor no cofre mantendo a referência quando possível; testar o gateway e revogar o valor antigo.
- Fonte bloqueada: desabilitar, preservar auditoria e pedir revisão de termos/perfil; não tentar contornar o bloqueio.
- Telegram indisponível: manter a candidatura em `needs_review`.
- Nova configuração de agente: criar draft, testar, publicar; nunca editar snapshot publicado no banco.
- Falha de release: seguir `docs/operations-runbook.md`, incluindo backup, restore testado e rollback do release.

O onboarding está concluído apenas quando health, readiness, autenticação, uma fonte, um agente publicado, proveniência/conflito e Telegram (se escolhido) tiverem evidências de teste. Produção continua bloqueada até todos os gates do checklist de release serem aprovados pelo operador.
