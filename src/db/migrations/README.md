# Migrações do SQLite

Toda mudança de schema (tabela, coluna, índice) e toda migração de dados passa por aqui.
`src/db.ts` não cria nem altera tabelas: ao ser importado ele chama `initDb()`
(`src/db/migrate.ts`), que abre a conexão (`src/db/connection.ts`) e executa `migrate(db)` uma vez.

## Como funciona

- `schema_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)` guarda o `id` de cada
  migração aplicada. A coluna se chama `name` porque a tabela já existia antes do versionamento
  com marcadores de migrações de dados (`install_default_agent_presets_v1` etc.), que continuam lá.
- `migrate(db)` abre `BEGIN EXCLUSIVE`, relê os ids aplicados **dentro do lock**, aplica os
  pendentes na ordem do array `MIGRATIONS` (`index.ts`), grava cada id e faz `COMMIT`. Se algo
  falhar, o lote inteiro é desfeito. Dashboard e servidor MCP podem subir juntos sobre o mesmo
  arquivo: um espera o outro (`busy_timeout`) e cada migração roda uma única vez.
- `0001_baseline` é o schema histórico completo + as migrações de dados antigas. É idempotente
  porque bancos anteriores ao versionamento também a executam (e só ganham o registro).

## Ids reservados (branches em paralelo)

| id     | issue | tema                  |
| ------ | ----- | --------------------- |
| `0002` | #31   | checagem de fatos     |
| `0003` | #32   | executor              |
| `0004` | #33   | vaga viva / repost    |
| `0005` | #34   | score / blockers      |
| `0006` | #35   | JSON Resume           |

Outras mudanças usam o próximo número livre a partir de `0007`. Como as branches podem ser
integradas fora de ordem (ex.: `0004` em produção antes de `0002`), uma migração reservada não
pode depender de outra reservada; ela só pode assumir o baseline e as que já estavam em `main`
quando foi escrita. O runner aplica qualquer id ausente, mesmo que um id maior já esteja aplicado.

## Como adicionar uma migração

1. Crie `src/db/migrations/000N_descricao_curta.ts` (id em minúsculas, `^\d{4}_[a-z0-9_]+$`):

   ```ts
   import { ensureColumn, type Migration } from "./types.js";

   export const migration0007: Migration = {
     id: "0007_descricao_curta",
     up(db) {
       db.exec(`CREATE TABLE IF NOT EXISTS exemplo (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)`);
       ensureColumn(db, "jobs", "nova_coluna", "TEXT");
     }
   };
   ```

2. Registre no array `MIGRATIONS` de `index.ts`, mantendo a ordem crescente de id
   (`migrate()` recusa ids fora de ordem ou malformados).
3. Regras para `up(db)`:
   - já roda dentro da transação `BEGIN EXCLUSIVE`: **não** use `BEGIN`/`COMMIT`
     (se precisar de atomicidade parcial use `tx(db, fn)` de `../connection.js`, que vira SAVEPOINT);
   - não altere pragmas que exigem estar fora de transação (`journal_mode`, `foreign_keys`);
   - não importe `src/db.ts` (import circular): use só `db` recebido, `../util.js`,
     `../agent-configs.js` e módulos sem estado;
   - nunca edite uma migração já publicada; corrija com uma nova.
4. Teste: `test/migrations.test.mjs` mostra como abrir um banco temporário e chamar
   `migrate()`; acrescente lá (ou num teste da feature) o caso da sua migração.
