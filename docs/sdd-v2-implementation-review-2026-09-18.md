# Review de implementação — SDD v2

**Data:** 18/09/2026
**Resultado:** implementação local fortalecida; nenhum gate de release está integralmente aprovado.

## Swarm executado

- cobertura SDD: mapeou requisitos, implementação e lacunas;
- review de implementação: revisou invariantes de domínio, autorização e rotas;
- auditoria de testes: criou probes para transações, PDF, ATS, autorização, SSRF e capabilities.

## Correções comprovadas

- PDF: validação, checksum, extração textual e mapeamento real de página, inclusive stream Flate;
- perfil: fatos evidenciados, confirmação, snapshot e atualização idempotente de entrevista;
- rodadas: somente fontes prontas, snapshot publicado, lote/checkpoint atômicos, cursor, retry e contadores;
- oportunidades: novas ocorrências não sobrescrevem decisão humana; conflitos ficam auditáveis;
- score: preferência só ajusta vaga cuja faceta/valor coincide;
- ATS: writer determinístico usa apenas fatos confirmados; reviewer recalcula conteúdo e palavras-chave;
- autorização: HTTPS obrigatório, URL/hash/versão revalidados, nonce, claim único, evidência obrigatória e revogação por mudança de destino;
- pergunta humana: resposta retoma mesma execução claimed; manual/parar revogam envelope;
- gateway: rotas internas exigem token fora de desenvolvimento; automação fica desligada sem feature flag;
- plugin: capabilities efetivas são interseção de papel, configuração publicada e credencial; DNS/IP privado, loopback, link-local e redirects são recusados;
- fontes: alteração material invalida smoke readiness; mudança de domínio exige nova aprovação de termos;
- UI: área Operação v2 mostra perfil, fatos, readiness, rodadas, duplicatas, preferências e perguntas pendentes.

## Evidência executada

| Comando | Resultado |
|---|---|
| `npm run build` | passou |
| suíte raiz definida por `npm test` | testes funcionais, SDD, segurança e carga passaram; `ops` exigiu execução fora do sandbox por usar subprocessos |
| `node test/ops.test.mjs && node test/mcp-server.test.mjs` | passou: backup/restore e MCP com 24 agentes |
| `cd hermes-plugin && npm test` | 12/12 passaram |
| Browser Harness em Chrome headless, banco limpo | passou: 24 agentes ativos, 16 fontes ativas, prompt com pergunta isolada/`Outro` e criação de agente configurável |
| `git diff --check` | passou |

Ambiente disponível usa Node `v22.22.2`; `package.json` exige Node `>=24`. Certificação na versão suportada continua pendente.

Browser Harness concluiu validação funcional da aba Configurações em Chrome headless. Auditoria responsiva completa, teclado e leitor de tela continuam pendentes.

## Findings ainda abertos

### Bloqueiam Gate A

- tracer bullet real perfil → Hermes → fontes piloto → ingestão → cartão;
- contratos estruturados ainda não governam toda saída de agente;
- schedule/catalog real do Hermes e retry/cancelamento ponta a ponta;
- `run_id` ainda não acompanha toda evidência.

### Bloqueiam Gate B

- exportação final PDF/DOCX do currículo ATS;
- todas as mutações de workflow ainda não passam por única fronteira de transição;
- teste E2E completo writer → reviewer → aprovação → candidatura manual.

### Bloqueiam Gate C

- worker Browser Harness conectado à fila real;
- Telegram durável integrado às perguntas SQLite;
- portal controlado real com dúvida, retomada e evidência de envio;
- auditoria visual responsiva e de acessibilidade completa.

### Bloqueiam Gate D

- migrações formais substituindo `ensureColumn`;
- retenção/LGPD, métricas e alertas operacionais;
- redução de PII no bootstrap geral;
- fila/idempotência persistentes no plugin;
- teste em Node 24 e checklist assinado pelo operador.

## Decisão de release

- Gate A: **não aprovado**.
- Gate B: **não aprovado**.
- Gate C: **não aprovado**; feature flag deve permanecer desligada.
- Gate D: **não aprovado**.

Estado recomendado: manter como implementação local/protótipo verificável. Não habilitar candidatura automática em produção até fechar Gate C.
