# SDD v2 — Busca Emprego

**Status:** implementação parcial em 18/09/2026; itens marcados foram implementados no backend e/ou cobertos pelos testes existentes
**Leitura:** `[x]` indica implementação local; integração real, E2E e produção continuam desmarcados quando ausentes.
**Versão:** 2.0-draft
**Data-base:** 18/09/2026
**Escopo:** perfil profissional, agentes, busca, oportunidades, currículo ATS, candidatura, interface, segurança e operação
**Substitui após aprovação:** requisitos futuros e parciais espalhados em `production-sdd-bdd-tdd.md` e `implementation-audit-2026-09-17.md`

## 1. Finalidade

Este documento define comportamento-alvo e critérios verificáveis do Busca Emprego. Documentação não equivale a implementação. Item só pode ser marcado como concluído quando:

1. implementação correspondente existir;
2. testes indicados passarem;
3. critérios de resultado aceito forem demonstrados;
4. nenhum resultado não aceito do requisito ocorrer;
5. evidência do teste for registrada no artefato de release.

Termos normativos:

- **DEVE:** requisito obrigatório.
- **NÃO DEVE:** comportamento proibido.
- **DEVERIA:** requisito recomendado, dispensável somente com decisão registrada.
- **PODE:** comportamento opcional.

## 2. Estado atual resumido

Implementado e testado localmente:

- dashboard web responsivo;
- armazenamento SQLite;
- CRUD de vagas, agentes, fontes, currículos e candidaturas;
- workflow básico com comandos e controle de versão;
- upload local de PDF-base;
- aprovação literal `APROVO`;
- autorização literal `AUTORIZO` por vaga/currículo/versão;
- versionamento, publicação e rollback de agentes;
- allowlist de domínios e campos editáveis;
- proveniência parcial e conflitos por campo;
- contratos de agentes, adapters Hermes, Browser Harness e Telegram;
- testes locais de workflow, domínio, carga, backup, restore e MCP.

Parcial ou ausente:

- extração e análise do PDF;
- perfil profissional versionado e confirmado;
- onboarding profissional;
- rodada de busca ponta a ponta;
- validação efetiva de todos os contratos dos agentes;
- deduplicação canônica persistida;
- score e preferências conectados à ingestão;
- modelo de IA e orçamento por agente;
- agendamento real;
- preparação ATS automática;
- autorização vinculada à URL/hash;
- worker de candidatura;
- pausa e retomada reais via Telegram;
- segurança separada entre clientes LAN e gateways internos;
- migrações formais, retenção, métricas e E2E completo.

## 3. Objetivos

### 3.1 Objetivos obrigatórios

1. Ler currículo-base e formar perfil profissional factual, evidenciado e confirmado.
2. Buscar vagas usando versão congelada desse perfil.
3. Consolidar mesma vaga encontrada em fontes ou rodadas diferentes.
4. Explicar aderência, cobertura, evidências e incertezas.
5. Aprender preferências somente com eventos explícitos.
6. Criar currículo ATS por vaga sem inventar fatos.
7. Manter candidatura manual utilizável sem automação.
8. Permitir automação somente com autorização de uso único e destino validado.
9. Pausar candidatura diante de dúvida, CAPTCHA, MFA, dado sensível ou mudança de destino.
10. Tornar toda ação relevante auditável e recuperável.

### 3.2 Fora de escopo inicial

- rede social de candidatos;
- compartilhamento público de currículos;
- negociação automática com recrutadores;
- geração de competências inexistentes;
- bypass de CAPTCHA, MFA, paywall ou termos de portal;
- candidatura automática sem `AUTORIZO` específico;
- múltiplos usuários com permissões distintas dentro da mesma instalação;
- escala horizontal antes de fila e idempotência duráveis.

## 4. Vocabulário de domínio

| Termo | Definição |
|---|---|
| Currículo-base | PDF fornecido pelo usuário como fonte documental. |
| Fato profissional | Informação extraída ou informada, vinculada a evidência e estado de confirmação. |
| Perfil profissional | Conjunto versionado de fatos confirmados, objetivos e restrições de busca. |
| Snapshot do perfil | Cópia imutável do perfil usada por uma rodada. |
| Rodada | Execução identificada de busca em uma ou mais fontes. |
| Resultado de fonte | Item bruto validado retornado por um coletor. |
| Oportunidade canônica | Vaga consolidada preservando fontes, ocorrências e estado humano. |
| Ocorrência | Observação da oportunidade em fonte e rodada específicas. |
| Evidência | Referência curta e auditável que sustenta um campo ou decisão calculada. |
| Score base | Aderência calculada somente com critérios comparáveis. |
| Cobertura | Percentual de peso para o qual existem dados suficientes. |
| Ajuste de preferência | Ajuste limitado derivado de feedback explícito. |
| Currículo ATS | Versão de currículo produzida para uma oportunidade específica. |
| `APROVO` | Confirmação da versão corrente do currículo ATS. |
| `AUTORIZO` | Autorização de negócio para uma tentativa automática específica. |
| Envelope de autorização | Vínculo imutável entre vaga, currículo, versão, URL/hash, ator e prazo. |
| Pergunta humana | Bloqueio correlacionado a uma candidatura e campo específicos. |

## 5. Arquitetura-alvo

```text
Currículo-base
  -> Perfil Profissional
       -> snapshot confirmado
            -> Rodada de Busca
                 -> coletores
                 -> validação de contratos
                 -> Oportunidade canônica
                      -> ocorrências/proveniência
                      -> score/preferências
                      -> decisão humana
                           -> Currículo por Vaga
                                -> writer
                                -> reviewer
                                -> APROVO
                                     -> manual
                                     -> AUTORIZO
                                          -> Candidatura Autorizada
                                               -> Browser Harness
                                               -> Pergunta Humana/Telegram
                                               -> evidência de envio
```

### 5.1 Módulos obrigatórios

#### Perfil Profissional

Concentra upload, extração, OCR, fatos, evidências, entrevista, confirmação, versões e snapshots.

#### Política de Agentes

Concentra papel, capabilities, fontes, domínios, modelo, esforço, orçamento, timeout, concorrência, prompt publicado e snapshot de execução.

#### Rodada de Busca

Concentra fan-out, checkpoints, validação, retries, ingestão, avaliação, encerramento e contadores.

#### Oportunidade

Concentra identidade canônica, ocorrências, deduplicação, proveniência, conflitos, score, preferências, workflow e decisões.

#### Currículo por Vaga

Concentra geração factual, revisão ATS, findings, gaps, versões, aprovação e exportação.

#### Candidatura Autorizada

Concentra modo manual, envelope `AUTORIZO`, claim, execução, perguntas, retomada, evidência e revogação.

#### Leituras da Interface

Concentra resumos pequenos, detalhes sob demanda, métricas, pendências e proteção de dados sensíveis.

## 6. Especificações funcionais

## 6.1 Currículo-base e extração

### SDD-CV-001 — Upload seguro

O sistema DEVE:

- aceitar somente PDF;
- validar MIME e assinatura `%PDF-`;
- limitar arquivo a 5 MB enquanto limite não for reconfigurado;
- calcular SHA-256;
- detectar upload repetido;
- armazenar nome original sanitizado;
- registrar ator e horário;
- nunca incluir bytes do PDF no bootstrap geral.

**Resultado aceito:** PDF válido recebe identificador, checksum e estado `uploaded`.
**Resultado não aceito:** arquivo não PDF, arquivo acima do limite, nome com path traversal ou PDF duplicado silenciosamente.

### SDD-CV-002 — Extração textual

O sistema DEVE:

- extrair texto por página;
- preservar número da página e offsets/trechos úteis;
- detectar PDF sem camada de texto;
- usar OCR somente quando necessário e configurado;
- marcar falha como `needs_review`;
- não tratar texto vazio como currículo válido.

**Resultado aceito:** usuário consegue revisar texto e localizar origem por página.
**Resultado não aceito:** currículo ATS criado a partir de PDF vazio, texto corrompido tratado como fato ou OCR silencioso sem confiança.

### SDD-CV-003 — Extração de fatos

Fatos suportados:

- dados de contato necessários;
- resumo profissional;
- experiências, empresas, cargos, datas e descrições;
- formação;
- certificações;
- competências;
- idiomas;
- projetos e resultados;
- localidade;
- links profissionais.

Cada fato DEVE conter:

- tipo;
- valor;
- evidência de página/trecho;
- origem `pdf`, `user` ou `derived`;
- confiança;
- estado `proposed`, `confirmed`, `rejected` ou `needs_review`.

**Resultado aceito:** fato confirmado aponta para evidência ou declaração humana.
**Resultado não aceito:** inferência promovida automaticamente a fato confirmado.

## 6.2 Onboarding e Perfil Profissional

### SDD-PROFILE-001 — Entrevista inicial

Antes da primeira rodada, sistema DEVE obter:

- cargos ou famílias de cargo;
- senioridade;
- competências confirmadas;
- competências desejáveis;
- atividades ou condições a evitar;
- localidades, países ou raio;
- remoto, híbrido e/ou presencial;
- faixa salarial, moeda e período;
- tipos de contrato;
- idiomas exigidos e confirmados.

Método:

- uma pergunta por mensagem;
- duas a quatro alternativas mutuamente exclusivas quando aplicável;
- opção `Outro`;
- pergunta livre quando opções forem inadequadas;
- não repetir resposta confirmada;
- perguntar lacunas ou contradições detectadas no PDF;
- permitir pular dado desconhecido não obrigatório.

**Resultado aceito:** entrevista termina com resumo editável.
**Resultado não aceito:** questionário longo numa única mensagem, repetição desnecessária ou competência não confirmada apresentada como habilidade.

### SDD-PROFILE-002 — Confirmação e versão

Sistema DEVE:

- salvar entrevista como draft;
- mostrar fatos, objetivos, preferências e restrições separadamente;
- exigir confirmação humana antes de ativar;
- criar versão imutável;
- manter somente uma versão ativa;
- preservar versões anteriores;
- invalidar somente rodadas futuras após mudança.

**Resultado aceito:** rodada referencia versão exata confirmada.
**Resultado não aceito:** perfil muda silenciosamente durante rodada ou feedback parcial altera fato pessoal.

### SDD-PROFILE-003 — Contexto mínimo

Coletores DEVEM receber somente snapshot compacto de busca. Não DEVEM receber PDF, currículo integral ou conversas anteriores.

Redator ATS DEVE receber somente:

- oportunidade atual;
- fatos confirmados necessários;
- currículo-base selecionado;
- preferências explícitas relevantes.

**Resultado aceito:** contexto de uma vaga não vaza para outra.
**Resultado não aceito:** memória livre substitui snapshots ou coletor recebe currículo integral.

## 6.3 Política de Agentes e Modelos

### SDD-AGENT-001 — Capabilities por papel

Capability efetiva DEVE ser interseção entre:

```text
capabilities permitidas pelo papel
∩ capabilities publicadas na configuração
∩ capabilities da credencial de execução
```

Prompt, página externa ou resposta de ferramenta NÃO DEVE ampliar capability.

**Resultado aceito:** configuração incompatível é rejeitada antes da publicação.
**Resultado não aceito:** `match_evaluator` ganha `jobs.create` por payload direto ou agente customizado contorna matriz.

### SDD-AGENT-002 — Versionamento

Alteração de nome, papel, prompt, fonte, domínio, capability, modelo, orçamento ou timeout DEVE criar draft imutável. Nova execução usa somente versão publicada. Execução em andamento mantém snapshot original.

**Resultado aceito:** publicação e rollback preservam checksum e histórico.
**Resultado não aceito:** edição no lugar de versão publicada.

### SDD-AGENT-003 — Modelo por agente

Configuração DEVE suportar:

- `model_id` fornecido pelo catálogo do Hermes;
- esforço de raciocínio suportado;
- máximo de tokens de entrada e saída;
- teto de custo por execução/rodada;
- política de fallback;
- exigência de saída estruturada;
- timeout e concorrência.

Radar NÃO DEVE manter catálogo hardcoded. Hermes valida disponibilidade e compatibilidade.

**Resultado aceito:** snapshot registra política e execução registra modelo efetivo.
**Resultado não aceito:** fallback amplia capability, ignora teto de custo ou usa modelo sem saída estruturada quando contrato exigir.

### SDD-AGENT-004 — Política recomendada

| Papel | Política |
|---|---|
| Coordenador | modelo econômico; coordenação principalmente determinística |
| Coletor | modelo econômico; contexto moderado; saída estruturada |
| Normalizador | regras determinísticas primeiro |
| Deduplicador | algoritmo primeiro; IA nunca funde fuzzy sozinha |
| Enriquecedor | contexto restrito à vaga |
| Matcher | cálculo determinístico; IA somente para classificação/evidência |
| Preference Learner | sem currículo; somente evento atual |
| Resume Writer | modelo de maior qualidade; somente perfil + vaga |
| ATS Reviewer | execução separada do writer quando orçamento permitir |
| Application Assistant | baixa criatividade; ferramentas e destino restritos |

## 6.4 Fontes e Rodada de Busca

### SDD-RUN-001 — Readiness de fonte

Fonte DEVE possuir estado:

- `configured`;
- `not_ready`;
- `ready`;
- `paused`;
- `blocked`.

Estado `ready` exige domínio, termos aplicáveis, autenticação necessária e smoke test de leitura.

**Resultado aceito:** fonte sem credencial permanece configurada, mas não executa.
**Resultado não aceito:** fonte marcada ativa aparece como sucesso sem conseguir autenticar.

### SDD-RUN-002 — Início da rodada

Rodada DEVE congelar:

- `run_id`;
- versão do perfil;
- fontes habilitadas e prontas;
- versões dos agentes;
- prompts;
- modelos e orçamentos;
- limites de lote/concorrência;
- instante de início.

Sem perfil confirmado, rodada NÃO DEVE iniciar.

### SDD-RUN-003 — Execução

Padrões iniciais:

- até 25 resultados por lote;
- até 20 trabalhos globais;
- uma coleta simultânea por domínio;
- timeout padrão 120 segundos;
- uma tentativa inicial e até três retentativas em 1 s, 5 s e 15 s, com jitter;
- erro permanente não é repetido automaticamente.

Falha de uma fonte NÃO DEVE cancelar fontes independentes. Rodada termina `completed`, `partial`, `failed` ou `cancelled`.

### SDD-RUN-004 — Contratos

Toda saída de agente DEVE ser validada antes de persistir. Campo extra, tipo incorreto, URL inválida ou enum desconhecido causa `SCHEMA_INVALID` ou rejeição parcial configurada.

**Resultado aceito:** erro aponta fonte, agente e campo sem expor segredo.
**Resultado não aceito:** `Record<string, unknown>` persistido sem validação.

### SDD-RUN-005 — Idempotência e retomada

Sistema DEVE persistir checkpoints por rodada, fonte, lote e cursor. Repetir lote não pode criar segunda ocorrência idêntica. Reinício do processo deve permitir retomada segura.

## 6.5 Oportunidade, deduplicação e proveniência

### SDD-JOB-001 — Identidade canônica

Ordem de comparação:

1. `source_id + source_job_id`;
2. URL canônica;
3. empresa, título, localização e data segundo regra fuzzy.

Correspondência exata cria nova ocorrência. Correspondência fuzzy apenas cria `possible_duplicate`.

**Resultado aceito:** mesma vaga em duas fontes produz um cartão e duas fontes.
**Resultado não aceito:** fuzzy funde automaticamente ou reencontro reinicia estado humano.

### SDD-JOB-002 — Ocorrências

Cada ocorrência DEVE registrar:

- oportunidade canônica;
- rodada;
- fonte;
- ID externo;
- URLs original e canônica;
- hash do payload;
- horário;
- estado da abertura observado.

### SDD-JOB-003 — Proveniência

Campo preenchido por agente DEVE apontar para evidência contendo:

- oportunidade;
- ocorrência;
- rodada;
- agente e versão;
- fonte e URL;
- campo;
- trecho mínimo permitido;
- hash do valor;
- confiança;
- origem;
- instante.

Dado humano prevalece até resolução explícita de conflito.

**Resultado aceito:** usuário compara valor vigente e candidato.
**Resultado não aceito:** nova fonte sobrescreve silenciosamente valor humano.

### SDD-JOB-004 — Links separados

Campos:

- `source_url`: evidência de origem;
- `linkedin_post_url`: post;
- `job_url`: página da vaga;
- `application_url`: formulário/destino de candidatura.

Um campo NÃO DEVE preencher ausência de outro. Todos devem usar HTTPS e política de domínio.

## 6.6 Score e preferências

### SDD-MATCH-001 — Score base

| Critério | Peso |
|---|---:|
| Cargo/família | 25 |
| Competências | 25 |
| Senioridade | 15 |
| Local/modalidade | 15 |
| Remuneração | 10 |
| Preferências explícitas | 10 |

Critério desconhecido fica `excluded`, não zero. Cobertura é soma dos pesos comparáveis.

Bandas:

- cobertura abaixo de 60%: `insufficient_data`;
- score maior ou igual a 80: `strong_match`;
- score entre 65 e 80: `review`;
- score abaixo de 65: `low_match`.

**Resultado aceito:** seis critérios, score, cobertura, evidências, forças e gaps persistidos.
**Resultado não aceito:** score inteiro isolado sem explicação ou dado ausente valendo zero.

### SDD-PREF-001 — Feedback explícito

- interesse gera sinal positivo somente em facetas comparáveis;
- rejeição parcial gera sinal negativo somente na faceta apontada;
- rejeição total cria regra explicável;
- `SEM TEMPO`, expiração, recusa do empregador e sighting repetido não geram sinal negativo.

### SDD-PREF-002 — Supressão

Regra ativa DEVE ser aplicada depois da deduplicação e antes da criação/notificação do cartão. Item suprimido deve conservar resumo mínimo e motivo. Usuário deve poder restaurar item, pausar regra ou removê-la.

**Resultado aceito:** regra exibe contagem e origem.
**Resultado não aceito:** feedback parcial oculta vaga automaticamente.

## 6.7 Workflow

Estados:

```text
found -> validation -> strong_match/review -> selected
-> resume -> resume_approved -> ready_to_apply -> applying -> applied
-> interview_scheduled -> interview_completed -> completed

saídas: discarded, expired
```

### SDD-WORKFLOW-001 — Fonte única de mudança

Toda mudança de status DEVE ocorrer por comando validado, com versão esperada, ator, evidência e evento. Funções de currículo, decisão e candidatura não podem alterar estado por SQL independente.

**Resultado aceito:** concorrência gera conflito, nunca sobrescrita silenciosa.
**Resultado não aceito:** PATCH genérico ou função auxiliar pula transições.

## 6.8 Currículo ATS por vaga

### SDD-ATS-001 — Geração factual

Writer DEVE usar somente:

- snapshot confirmado do perfil;
- currículo-base selecionado;
- oportunidade atual;
- requisitos e evidências atuais.

Writer NÃO DEVE inventar empregador, data, cargo, formação, certificação, idioma, ferramenta ou métrica.

Saída:

- conteúdo;
- mudanças rastreáveis;
- palavras-chave com evidência;
- gaps;
- fatos utilizados;
- versão.

### SDD-ATS-002 — Revisão independente

Reviewer DEVE verificar:

- factualidade;
- cronologia;
- datas e cargos;
- legibilidade ATS;
- idioma;
- palavras-chave;
- estrutura simples.

Qualquer fato sem evidência resulta `fail`.

### SDD-ATS-003 — Aprovação

`APROVO` somente pode aprovar versão salva com extração disponível e revisão ATS `pass` ou override humano explicitamente justificado.

Editar currículo aprovado DEVE:

- criar nova versão;
- remover aprovação vigente;
- invalidar autorização automática associada;
- exigir nova revisão.

**Resultado não aceito:** aprovação de conteúdo vazio, draft sem base/evidência ou edição mantendo `AUTORIZO`.

## 6.9 Candidatura manual

### SDD-APP-MANUAL-001

Fluxo manual DEVE:

- exigir interesse e currículo aprovado;
- mostrar `application_url` sem preenchimento automático;
- permitir usuário confirmar envio;
- registrar data, ator, notas e evidência opcional;
- não depender do worker automático.

**Resultado aceito:** status `submitted` após confirmação humana explícita.
**Resultado não aceito:** abrir link marca candidatura como enviada.

## 6.10 Candidatura automática

### SDD-APP-AUTO-001 — Envelope `AUTORIZO`

Envelope DEVE conter:

- authorization ID;
- application ID;
- job ID;
- resume ID e versão;
- URL canônica;
- hash da URL;
- hash da cadeia de redirecionamento validada quando aplicável;
- ator e horário;
- expiração configurável;
- nonce de uso único;
- estados issued, claimed, consumed, revoked ou expired.

Mudança de vaga, decisão, currículo, versão, URL, host ou redirecionamento DEVE revogar envelope.

### SDD-APP-AUTO-002 — Claim e execução

Worker DEVE fazer claim atômico. Somente worker interno autorizado recebe conteúdo mínimo necessário. Duas instâncias não podem executar mesma autorização.

### SDD-APP-AUTO-003 — Pausa obrigatória

Execução DEVE pausar antes de continuar quando encontrar:

- pergunta sem resposta confirmada;
- resposta ambígua;
- dado sensível;
- declaração legal;
- CAPTCHA;
- MFA;
- login interativo não preparado;
- teste/assessment;
- mudança de URL ou domínio;
- erro de upload;
- divergência entre vaga e currículo.

### SDD-APP-AUTO-004 — Confirmação

Status `submitted` exige confirmação observável do portal e `evidence_ref`. Clique em botão não basta.

**Resultado não aceito:** submissão sem evidência, reutilização de autorização ou envio após mudança de URL.

## 6.11 Perguntas humanas e Telegram

### SDD-QUESTION-001

Pergunta DEVE registrar:

- ID;
- candidatura, vaga, currículo e versão;
- etapa e campo;
- texto e motivo da incerteza;
- obrigatoriedade;
- escolhas opcionais;
- estado;
- mensagem Telegram;
- resposta, ator e horários.

Somente uma pergunta ativa por candidatura.

### SDD-QUESTION-002

Resposta somente é aceita da identidade vinculada pelo Hermes e correlacionada por reply ou ID. Radar não deve exigir configuração duplicada de bot, destinatário ou chat ID.

Comandos:

- `RESPONDER id: texto`;
- `PULAR id`, somente campo opcional;
- `MANUAL id`;
- `PARAR id`.

Falha de entrega ou resposta ambígua mantém `needs_review`.

## 6.12 Interface

Telas obrigatórias:

1. Configuração inicial;
2. Perfil profissional;
3. Visão geral;
4. Rodadas;
5. Vagas/Kanban;
6. Detalhe da oportunidade;
7. Possíveis duplicatas;
8. Preferências e filtradas;
9. Currículos ATS;
10. Candidaturas;
11. Pendências humanas;
12. Agentes, modelos e custos;
13. Fontes e agendamentos;
14. Configurações e retenção.

Regras:

- cartões compactos;
- detalhe sob demanda;
- score acompanhado de cobertura;
- fatos acompanhados de origem/confiança;
- ações protegidas não usam cadeia de `window.prompt` como experiência final;
- tema claro/escuro;
- navegação básica por teclado;
- estado comunicado por texto, não apenas cor;
- interface móvel funcional.

## 7. Segurança e privacidade

### SDD-SEC-001 — Separação de tráfego

Instalação DEVERIA separar:

```text
listener/proxy LAN:
  dashboard e comandos humanos

listener interno Hermes:
  eventos de agente
  fila autorizada
  perguntas/respostas
  execução
```

Rotas internas exigem identidade de gateway, token de serviço ou mTLS. “Sem login na LAN” não autoriza gateways anônimos.

### SDD-SEC-002 — SSRF e navegação

Sistema DEVE:

- aceitar HTTPS;
- rejeitar credenciais embutidas;
- validar domínio permitido;
- resolver DNS e bloquear destinos privados/link-local/loopback IPv4 e IPv6;
- validar cada redirecionamento;
- proteger contra DNS rebinding;
- separar sessão de leitura e candidatura.

### SDD-SEC-003 — Dados pessoais

PDF, texto extraído, perfil, respostas e currículo ATS são dados pessoais. Sistema DEVE definir:

- retenção por entidade;
- exclusão segura;
- exportação;
- backup;
- acesso mínimo;
- logs sanitizados;
- proibição de CV/prompt/resposta sensível em métricas.

## 8. Operação

### SDD-OPS-001 — Migrações

Migrações DEVEM ser monotônicas, versionadas, transacionais e testadas sobre cópia do banco. Release cria backup antes de migração. Falha restaura versão anterior ou bloqueia inicialização com diagnóstico seguro.

### SDD-OPS-002 — Durabilidade

Enquanto instalação for única, SQLite pode armazenar:

- fila de trabalhos;
- claims;
- checkpoints;
- idempotency keys;
- perguntas pendentes;
- envelopes de autorização.

Memória local não pode ser fonte única desses estados.

### SDD-OPS-003 — Métricas

Registrar sem conteúdo pessoal:

- rodadas por estado;
- duração;
- erros por fonte;
- backlog;
- retries;
- modelo, tokens, custo e latência;
- conflitos pendentes;
- currículos aguardando revisão;
- candidaturas presas;
- perguntas sem entrega/resposta;
- espaço do banco;
- idade do último backup testado.

## 9. Fragilidades obrigatórias a corrigir

- [x] PDF armazenado sem leitura, OCR, checksum ou fatos.
- [x] Perfil confirmado citado por prompts, mas ausente no domínio.
- [ ] Coordenador encerra após coletores.
- [ ] Schemas não governam toda execução.
- [x] Dedupe puro não participa da persistência.
- [x] Mesma vaga em fontes diferentes pode duplicar.
- [x] Score detalhado não é persistido.
- [x] Supressão não é aplicada na ingestão.
- [x] Interesse não gera sinais positivos.
- [x] Workflow pode ser contornado por SQL/funções diretas.
- [ ] Capability por papel diverge entre plugin e backend.
- [x] Modelos e orçamento não fazem parte do snapshot.
- [ ] `run_id` não acompanha toda evidência.
- [ ] ATS cria placeholder e não executa writer/reviewer.
- [ ] Aprovação aceita conteúdo sem revisão ATS.
- [x] `AUTORIZO` não guarda URL/hash nem uso único.
- [x] Mudança de `application_url` não revoga autorização.
- [x] Fila autorizada expõe currículo integral na LAN.
- [ ] Browser Harness não possui worker conectado à fila.
- [ ] Telegram em memória diverge de perguntas SQLite.
- [ ] Resposta Telegram depende de configuração duplicada de chat ID.
- [ ] Bootstrap devolve dados completos demais.
- [x] Fontes aparecem ativas sem readiness real.
- [ ] Agendamento não existe no produto.
- [ ] Migrações dependem de `ensureColumn` no startup.
- [ ] Idempotência e fila do plugin são voláteis.
- [ ] Retenção/LGPD não definida.
- [ ] Teste de carga não atravessa pipeline real.
- [ ] Interface não mostra perfil, rodadas, duplicatas, filtradas ou pendências.
- [ ] Repositório não possui `CONTEXT.md` ou ADRs para decisões duráveis.

## 10. Pontos de melhoria

### P0 — Antes de nova automação

- [x] feature gate mantém schedule e candidatura automática desligados;
- [x] unificar capabilities;
- [x] unificar workflow;
- [x] separar rotas internas;
- [ ] criar migrações formais;
- [x] implementar PDF + perfil;
- [x] implementar ingestão canônica;
- [x] conectar score e preferências;
- [ ] validar contratos.

### P1 — Produto utilizável

- [x] política de modelos e custos;
- [ ] rodada completa;
- [x] source readiness;
- [ ] agendamento Hermes;
- [ ] ATS completo;
- [ ] manual completo;
- [x] UI de perfil, rodadas, preferências e pendências;
- [ ] métricas e retenção.

### P1 — Automação piloto

- [x] envelope de uso único;
- [x] claim atômico;
- [ ] worker Browser Harness;
- [ ] Telegram durável;
- [x] pausa/retomada;
- [x] evidência obrigatória;
- [ ] E2E em portal controlado.

### P2 — Depois do fluxo principal

- [ ] geocodificação e cache completos;
- [ ] métricas comparativas de interesse;
- [ ] catálogo avançado de prompts;
- [ ] otimização assistida baseada em evidências;
- [ ] escala horizontal;
- [ ] banco externo quando carga justificar.

## 11. Plano de entrega

### Marco M0 — Verdade operacional

Entregáveis:

- [ ] feature gates;
- [ ] matriz única de capabilities;
- [ ] workflow único;
- [ ] rotas humanas/internas separadas;
- [ ] migrações versionadas;
- [ ] `CONTEXT.md` e ADRs iniciais.

Aceito quando:

- capability incompatível é rejeitada;
- status não muda sem comando;
- automação não inicia;
- backup/restore pré-migração passa.

Não aceito quando:

- UI é única proteção de capability;
- PATCH genérico pula workflow;
- gateway interno permanece anônimo.

### Marco M1 — Perfil utilizável

Entregáveis:

- [x] extração PDF;
- [x] fatos/evidências;
- [x] entrevista;
- [x] confirmação;
- [x] versões e snapshot.

Aceito quando:

- PDF textual produz fatos revisáveis;
- PDF sem texto não gera perfil vazio;
- busca não inicia sem perfil confirmado;
- fato confirmado possui evidência.

### Marco M2 — Busca utilizável

Entregáveis:

- [ ] contratos validados;
- [x] rodadas e source runs;
- [x] oportunidades canônicas;
- [x] ocorrências;
- [x] possíveis duplicatas;
- [x] proveniência;
- [x] score/cobertura;
- [x] filtro de preferências.

Aceito quando:

- duas fontes da mesma vaga geram um cartão;
- repetição gera sighting;
- fuzzy requer revisão;
- score é explicável;
- regra ativa filtra antes do cartão.

### Marco M3 — Agentes e modelos

Entregáveis:

- [ ] catálogo Hermes;
- [x] política por agente;
- [x] custo/tokens/latência;
- [ ] fixtures;
- [ ] rodada ponta a ponta;
- [ ] retry/cancelamento;
- [ ] schedule e readiness.

Aceito quando:

- uma ação inicia rodada completa;
- draft não governa execução;
- modelo efetivo e custo são auditáveis;
- falha de fonte resulta rodada parcial.

### Marco M4 — ATS utilizável

Entregáveis:

- [ ] writer;
- [ ] reviewer;
- [ ] facts-only enforcement;
- [x] findings/gaps;
- [x] aprovação e invalidação;
- [ ] PDF/DOCX.

Aceito quando:

- afirmações possuem evidência;
- fato inventado reprova;
- `APROVO` bloqueia em review fail;
- edição invalida aprovação/autorização.

### Marco M5 — Manual completo

Entregáveis:

- [x] seleção manual;
- [x] confirmação de envio;
- [x] acompanhamento;
- [x] entrevista;
- [x] resultado final.

Aceito quando fluxo manual funciona sem worker automático.

### Marco M6 — Automação piloto

Entregáveis:

- [x] URL/hash;
- [x] uso único;
- [x] claim;
- [ ] worker;
- [x] pergunta humana;
- [ ] Telegram;
- [ ] retomada;
- [x] evidência.

Aceito quando:

- `APROVO` não autoriza;
- URL alterada revoga;
- duas instâncias não duplicam envio;
- dúvida bloqueia;
- resposta errada não retoma;
- `submitted` exige evidência.

### Marco M7 — Produção

Entregáveis:

- [ ] UX final;
- [ ] acessibilidade;
- [ ] segurança de gateway;
- [ ] retenção;
- [ ] métricas/alertas;
- [ ] backup/restore;
- [ ] piloto real;
- [ ] checklist de release assinado.

## 12. Estratégia de testes

## 12.1 Testes unitários

### PDF e perfil

- [ ] assinatura/MIME/tamanho;
- [ ] checksum e duplicação;
- [ ] PDF textual;
- [ ] PDF sem texto;
- [ ] OCR indisponível;
- [ ] mapeamento página/trecho;
- [ ] fatos propostos/confirmados/rejeitados;
- [ ] salário mínimo maior que máximo;
- [ ] perfil sem confirmação;
- [ ] versionamento e ativação.

### Contratos e agentes

- [ ] campo extra;
- [ ] enum inválido;
- [ ] URL insegura;
- [ ] capability fora do papel;
- [ ] domínio ausente;
- [ ] modelo indisponível;
- [ ] fallback incompatível;
- [ ] teto de tokens/custo;
- [ ] snapshot publicado.

### Oportunidades

- [ ] identidade por source job ID;
- [ ] identidade por URL;
- [ ] tracking removido;
- [ ] fuzzy não funde;
- [ ] localização compatível/incompatível;
- [ ] ocorrência idempotente;
- [ ] preservação de estado humano;
- [ ] conflito contra dado humano;
- [ ] resolução de conflito.

### Score e preferências

- [ ] seis critérios;
- [ ] desconhecido excluído;
- [ ] cobertura 59,99/60;
- [ ] limites 64,99/65/79,99/80;
- [ ] interesse positivo;
- [ ] parcial negativa somente na faceta;
- [ ] total cria regra;
- [ ] `SEM TEMPO` neutro;
- [ ] regra ativa/pausada;
- [ ] restauração.

### Workflow

- [ ] toda transição válida;
- [ ] salto inválido;
- [ ] conflito de versão;
- [ ] reabertura;
- [ ] expiração;
- [ ] conclusão excepcional;
- [ ] tentativa de PATCH direto.

### ATS

- [ ] fato sem evidência;
- [ ] data/cargo alterado;
- [ ] palavra-chave sem suporte;
- [ ] draft vazio;
- [ ] review fail;
- [ ] aprovação correta;
- [ ] edição e invalidação.

### Candidatura

- [ ] `APROVO` isolado;
- [ ] URL/hash divergente;
- [ ] versão divergente;
- [ ] revogação;
- [ ] expiração;
- [ ] claim concorrente;
- [ ] uso único;
- [ ] ausência de evidência;
- [ ] mudança de redirect;
- [ ] manual separado.

### Telegram

- [ ] identidade errada;
- [ ] pergunta desconhecida;
- [ ] resposta ambígua;
- [ ] reply correlacionado;
- [ ] `PULAR` opcional/obrigatório;
- [ ] `MANUAL`;
- [ ] `PARAR`;
- [ ] falha de entrega;
- [ ] reminder;
- [ ] retomada única.

## 12.2 Testes de integração

- [ ] PDF -> perfil confirmado;
- [ ] perfil -> snapshot de rodada;
- [ ] scout -> validação -> ingestão;
- [ ] duas fontes -> uma oportunidade;
- [ ] duas rodadas -> duas ocorrências;
- [ ] score -> filtro -> cartão;
- [ ] feedback -> rodada seguinte;
- [ ] perfil + vaga -> writer -> reviewer;
- [ ] aprovação -> manual;
- [ ] autorização -> worker;
- [ ] worker -> dúvida -> Telegram -> retomada;
- [ ] envio -> evidência -> workflow;
- [ ] restart durante rodada;
- [ ] restart durante pergunta;
- [ ] restart durante candidatura claimed.

## 12.3 Tracer bullet E2E obrigatório

```text
fixture PDF
-> extração
-> revisão dos fatos
-> perfil confirmado
-> rodada com duas fontes
-> mesma vaga encontrada nas duas
-> um cartão + duas ocorrências
-> score explicado
-> interesse
-> ATS draft
-> ATS review
-> APROVO
-> candidatura manual confirmada

segunda oportunidade:
-> ATS aprovado
-> AUTORIZO com URL/hash
-> worker inicia
-> campo desconhecido
-> Telegram pergunta
-> resposta correlacionada
-> worker retoma
-> portal confirma
-> evidence_ref
-> submitted
```

Resultado não aceito em qualquer etapa:

- duplicação de cartão;
- fato sem evidência;
- contexto de outra vaga;
- avanço sem confirmação;
- retry duplicando efeito;
- status pulado;
- submissão sem evidência.

## 12.4 Testes de segurança

- [ ] capability escalation;
- [ ] prompt injection em vaga/PDF;
- [ ] URL com credenciais;
- [ ] `http:`;
- [ ] localhost;
- [ ] RFC1918;
- [ ] link-local;
- [ ] IPv6 privado;
- [ ] DNS rebinding;
- [ ] redirect para host proibido;
- [ ] acesso LAN à fila interna;
- [ ] resposta Telegram falsificada;
- [ ] exposição de currículo em logs;
- [ ] path traversal em filename;
- [ ] payload acima do limite;
- [ ] concorrência no claim.

## 12.5 Testes de carga e resiliência

- [ ] 16 fontes simultâneas respeitando limite por domínio;
- [ ] 500 resultados atravessando pipeline real;
- [ ] 20 trabalhos globais;
- [ ] fonte lenta;
- [ ] fonte indisponível;
- [ ] 429/5xx com retry;
- [ ] 401/403 sem retry;
- [ ] restart e retomada;
- [ ] banco bloqueado;
- [ ] disco próximo do limite;
- [ ] backup concorrente;
- [ ] restore e quick check.

## 12.6 Testes de interface e acessibilidade

- [ ] onboarding por teclado;
- [ ] foco visível;
- [ ] labels de formulário;
- [ ] estado sem depender apenas de cor;
- [ ] mobile;
- [ ] tema claro/escuro;
- [ ] modal com foco preso e retorno correto;
- [ ] leitor de tela;
- [ ] erros associados aos campos;
- [ ] score e cobertura compreensíveis;
- [ ] conflito de proveniência revisável;
- [ ] pergunta pendente visível;
- [ ] custo/modelo visíveis.

## 13. Gates de release

### Gate A — Busca

- [ ] M0, M1, M2 e M3 concluídos;
- [ ] tracer bullet até cartão passa;
- [ ] fontes piloto têm termos/readiness;
- [ ] dedupe e score auditáveis.

### Gate B — ATS/manual

- [ ] M4 e M5 concluídos;
- [ ] factualidade e invalidação passam;
- [ ] manual funciona sem automação.

### Gate C — Automação piloto

- [ ] Gate B aprovado;
- [ ] M6 concluído;
- [ ] Browser Harness e Telegram reais validados;
- [ ] URL/hash, claim e evidence demonstrados;
- [ ] feature flag habilitada somente para portal piloto.

### Gate D — Produção doméstica contínua

- [ ] M7 concluído;
- [ ] retenção aprovada;
- [x] backup restaurado em teste recente;
- [ ] alertas funcionais;
- [x] rotas internas protegidas;
- [x] rollback ensaiado;
- [ ] checklist assinado pelo operador.

## 14. Definition of Done do produto

- [x] PDF é lido ou explicitamente marcado para revisão.
- [x] Perfil confirmado governa busca.
- [x] Rodadas usam snapshots imutáveis.
- [ ] Saídas de agentes são validadas.
- [x] Oportunidades são canônicas e preservam ocorrências.
- [x] Score possui cobertura, critérios e evidências.
- [x] Preferências afetam rodadas futuras conforme regras explícitas.
- [x] ATS usa somente fatos confirmados.
- [ ] Workflow não pode ser contornado.
- [x] Modelos, tokens, custo e latência ficam auditados.
- [x] Candidatura manual funciona ponta a ponta.
- [x] Automação usa autorização de uso único com URL/hash.
- [ ] Pergunta humana pausa e retoma worker real.
- [x] Submissão exige evidência observável.
- [x] backup e restore passam.
- [ ] Tráfego interno não fica exposto como dashboard LAN.
- [ ] Tracer bullet completo passa no artefato de produção.

Até todos os itens aplicáveis passarem, classificação correta permanece:

> **Protótipo integrado; automação não pronta para produção.**
