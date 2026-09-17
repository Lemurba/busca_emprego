# Plugin Busca Emprego para Hermes

Runtime portátil descrito em [`../docs/production-sdd-bdd-tdd.md`](../docs/production-sdd-bdd-tdd.md). A versão 0.3.2 possui uma única configuração de instalação e inclui adapters HTTPS concretos para Hermes, Browser Harness e Telegram. O plugin herda a capability Telegram já vinculada ao Hermes; não configura bot, token, chat ID ou destinatário.

O Hermes deve começar por [`ONBOARDING.md`](ONBOARDING.md). O manifesto aponta também para `onboarding.json`, que fixa a instalação única de produção, reduz as perguntas, define os quatro modos de autenticação de fontes e os testes obrigatórios. Segredos são coletados exclusivamente pela entrada segura do host, nunca pela conversa.

## Conteúdo

- `manifest.json` e schemas de configuração/manifest;
- prompts versionáveis e contratos JSON dos nove papéis lógicos, incluindo `job_enrichment`;
- coleta com descrição completa, benefícios, requisitos, responsabilidades, informações adicionais, `linkedin_post_url` e `job_url`;
- enriquecimento com patch limitado aos campos autorizados e `evidence_source_url` obrigatório;
- coordenador com limite global (máximo 20), uma coleta simultânea por domínio e lotes de até 25;
- idempotência por rodada/fonte e interface substituível para armazenamento durável;
- até três retentativas, com atrasos 1 s, 5 s e 15 s mais jitter; 401/403, schema inválido e bloqueio contratual são permanentes;
- gate Telegram que mantém a preparação bloqueada diante de dúvida sem capacidade/destinatário do Hermes, limita uma pergunta ativa por candidatura e valida correlação e remetente;
- Browser Harness de leitura disponível exclusivamente para scouting/enrichment e adapter de candidatura separado, que exige autorização por vaga, currículo/versão e hash da URL; submissão sem evidência observável é rejeitada;
- agentes configuráveis pelo dashboard, com capabilities fixadas por papel: prompt e customização nunca ampliam ferramentas;
- testes isolados sem rede.

## Integração no host

```ts
import { Coordinator, TelegramQuestionGate } from "@busca-emprego/hermes-plugin";

// Os adapters concretos usam gateways HTTPS provisionados pelo Hermes.
// Não passe bot token ou credencial da fonte: use referências/perfis do Hermes.
const coordinator = new Coordinator({ runtime, idempotency, config, promptVersionId });
const telegramGate = new TelegramQuestionGate(hermesTelegramCapability);
```

Antes de produção, substitua `MemoryIdempotencyStore` por um adapter transacional/durável. Em mais de uma instância, a fila também precisa de backend compartilhado. Os caminhos de gateway são `v1/plugin-agents/invoke`, `v1/read`, `v1/applications/execute` e `v1/telegram/questions`; o proxy do Hermes deve mapeá-los às capacidades correspondentes. O executor nunca contorna CAPTCHA e só aceita `submitted` quando o Harness devolve `evidenceRef`.

## Verificação

Na raiz deste diretório:

```sh
npm install
npm test
```

O build requer Node.js 24 ou superior. O pacote de runtime fica isolado em `hermes-plugin/`, mas integra-se à API e ao dashboard do projeto principal para fontes, versões de agentes, proveniência e conflitos.
