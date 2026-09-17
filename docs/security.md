# Segurança da API

O módulo `src/auth.ts` fornece autenticação Bearer para usuários e para o serviço Hermes, autorização por projeto e ferramenta e rate limiting local. `src/server.ts` aplica essa verificação a todas as rotas `/api`, exceto o health check. A porta ainda deve permanecer em rede interna ou atrás de proxy TLS.

## Variáveis mínimas

`RADAR_AUTH_CREDENTIALS` é obrigatória e deve ser injetada pelo armazenamento seguro do ambiente. É um array JSON; não grave seu valor no repositório, SQLite, logs ou métricas.

```text
RADAR_AUTH_CREDENTIALS=[{"id":"usuario-principal","kind":"user","token":"<segredo-aleatorio-com-32-ou-mais-caracteres>","projects":["busca-emprego"],"tools":["*"]},{"id":"hermes","kind":"service","token":"<outro-segredo-aleatorio-com-32-ou-mais-caracteres>","projects":["busca-emprego"],"tools":["jobs.write","applications.read","applications.write"]}]
RADAR_AUTH_RATE_LIMIT_MAX=60
RADAR_AUTH_RATE_LIMIT_WINDOW_MS=60000
```

Os dois limites são opcionais e usam os valores mostrados como padrão. Tokens de usuário e serviço precisam ser distintos. Gere-os com fonte criptograficamente segura, distribua-os somente aos respectivos clientes e faça rotação pelo secret manager.

## Uso

Crie uma única instância de `BearerAuthenticator` durante a inicialização. Para cada chamada, forneça o header `Authorization`, o projeto solicitado, a ferramenta associada à rota e uma chave estável de rate limit obtida de proxy confiável. O retorno diferencia `401 UNAUTHENTICATED`, `403 FORBIDDEN` e `429 RATE_LIMITED`; no último caso, publique `Retry-After` com `retryAfterSeconds`.

Escopos HTTP aceitam correspondência exata. `*` existe para administração explícita e deve ser evitado no Hermes. O usuário que administra agentes pelo dashboard precisa de `agents.manage`; a interface completa também usa outros escopos, por isso o exemplo local usa `*`. A rota de eventos do Hermes exige `jobs.write`. Internamente, a configuração do agente restringe novamente a operação a `browser.read`, `jobs.create`, `jobs.enrich`, `jobs.read` e `salary.lookup`; esses nomes internos não substituem o escopo HTTP.

Além do escopo da credencial, cada versão de agente define `source_ids`, `allowed_domains`, `browser_enabled` e seus próprios `tool_scopes`. `source_ids` seleciona conectores; não é uma allowlist. `browser_enabled=true` exige `browser.read` efetivo e `allowed_domains` não vazio. URLs de navegação, criação, enriquecimento, consulta salarial e evidência precisam pertencer à allowlist inclusive após redirecionamento. A autorização `AUTORIZO` não amplia essa lista e não transforma `browser.read` em navegador de candidatura.

O navegador de descoberta e o executor de candidatura usam perfis e processos lógicos separados. Não compartilhar cookies, local storage, downloads ou sessões autenticadas. O executor recebe somente a tarefa vinculada a um `AUTORIZO` vigente e continua sujeito à sua credencial de serviço e aos controles de domínio próprios da candidatura.

O limitador é deliberadamente em memória e vale por processo. Ele não substitui um limitador compartilhado quando houver múltiplas réplicas e perde os contadores ao reiniciar. Em produção distribuída, mantenha a mesma interface e use armazenamento compartilhado no gateway ou serviço próprio.

O comparador reduz os tokens a digests SHA-256 de tamanho fixo antes de usar `timingSafeEqual` e percorre todas as credenciais. Respostas de erro não incluem ID, token ou indicação do escopo existente.
