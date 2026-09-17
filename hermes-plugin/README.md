# Plugin Busca Emprego para Hermes

Scaffold portátil do runtime descrito em `docs/production-sdd-bdd-tdd.md`. Ele não presume uma API privada do Hermes: o host implementa `HermesRuntimeAdapter` para executar agentes, `ReadonlyBrowserHarnessAdapter` para leitura e `HermesTelegramCapability` para dúvidas de preparação. Tokens e destinatários não entram na configuração, banco ou logs deste plugin. Candidatura automática não é uma capability deste plugin.

## Conteúdo

- `manifest.json` e schemas de configuração/manifest;
- prompts versionáveis e contratos JSON dos nove papéis lógicos, incluindo `job_enrichment`;
- coleta com descrição completa, benefícios, requisitos, responsabilidades, informações adicionais, `linkedin_post_url` e `job_url`;
- enriquecimento com patch limitado aos campos autorizados e `evidence_source_url` obrigatório;
- coordenador com limite global (máximo 20), uma coleta simultânea por domínio e lotes de até 25;
- idempotência por rodada/fonte e interface substituível para armazenamento durável;
- até três retentativas, com atrasos 1 s, 5 s e 15 s mais jitter; 401/403, schema inválido e bloqueio contratual são permanentes;
- gate Telegram que mantém a preparação bloqueada diante de dúvida sem capacidade/destinatário do Hermes, limita uma pergunta ativa por candidatura e valida correlação e remetente;
- Browser Harness somente leitura, disponível exclusivamente para scouting/enrichment; o plugin não abre, preenche ou envia candidaturas;
- agentes configuráveis pelo dashboard, com capabilities fixadas por papel: prompt e customização nunca ampliam ferramentas;
- testes isolados sem rede.

## Integração no host

```ts
import { Coordinator, TelegramQuestionGate } from "@busca-emprego/hermes-plugin";

// Adapte a chamada real do Hermes a HermesRuntimeAdapter.
// Não passe token Telegram: injete a capacidade segura já configurada no Hermes.
// Para coleta/enriquecimento, adapte somente ReadonlyBrowserHarnessAdapter.readPage.
const coordinator = new Coordinator({ runtime, idempotency, config, promptVersionId });
const telegramGate = new TelegramQuestionGate(hermesTelegramCapability);
```

Antes de produção, substitua `MemoryIdempotencyStore` por um adapter transacional/durável. Em mais de uma instância, a fila também precisa de backend compartilhado. A camada host deve validar os JSON Schemas, persistir snapshots/versões/auditoria e integrar a API documentada do dashboard. Este scaffold não inventa endpoints Hermes. Seu adapter de Browser Harness expõe apenas leitura e não oferece operações de clique, preenchimento, bypass ou submissão.

## Verificação

Na raiz deste diretório:

```sh
npm install
npm test
```

O build requer Node.js 24 ou superior. O plugin não modifica `src/server.ts`, `src/db.ts` ou `public/` do projeto principal.
