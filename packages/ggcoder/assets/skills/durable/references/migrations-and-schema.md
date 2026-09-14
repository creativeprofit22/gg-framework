# Durable — migrations & schema

Load for any migration or schema finding. Postgres examples dominate because it is the default; MySQL and SQLite divergences are called out. `SNAPSHOT` = sourced 17 August 2026 — version behaviors decay, verify before asserting.

## The one rule that prevents most downtime

**Never deploy a schema change and the code that depends on it in the same step.** Old code must keep working against the new schema, and new code must keep working against the old schema, for at least one deploy cycle. That is what expand-contract buys.

## Expand-contract (parallel change)

Every breaking change is two or three separately-deployed steps, each leaving the system fully functional:

1. **Expand** — add the new column/table/index (nullable, no constraints yet). Old code ignores it; nothing breaks.
2. **Backfill + dual-write** — copy old data to new in batches; code writes both; code reads new with fallback to old. Deploy, watch, wait.
3. **Contract** — after the old path is provably dead (feature flag flipped, traffic at zero), remove the old column and the dual-write.

Rollback at any point is "flip back to the old path", not "restore the database".

**Rename a column** — never `RENAME COLUMN` on a live system (breaks all in-flight code): add `email`, backfill from `email_addr`, dual-write, switch reads, drop `email_addr` in a later deploy.

**Change a type or split a column** — add the new column, backfill with transformation in batches, cut writes over, drop old. Same shape, always.

## Lock-safety table (Postgres)

What common DDL actually does to a live table (`SNAPSHOT` — verify per version):

| Operation                           | Behavior                                                                 | Safe pattern                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADD COLUMN` (no default)           | Fast, brief lock                                                         | Fine as-is                                                                                                                                   |
| `ADD COLUMN ... NOT NULL DEFAULT x` | Fast since Postgres 11 (default not backfilled); table rewrite before 11 | Fine on ≥11; otherwise add nullable → backfill → `SET NOT NULL`                                                                              |
| `SET NOT NULL` on existing column   | Full-table scan under lock                                               | Backfill first, then set; or add a `CHECK` constraint `NOT VALID` then `VALIDATE`, then switch                                               |
| `CREATE INDEX`                      | Blocks writes for the whole build                                        | `CREATE INDEX CONCURRENTLY` (drop with `DROP INDEX CONCURRENTLY`); slower, non-transactional — if it fails, drop the invalid index and retry |
| `ADD FOREIGN KEY`                   | Locks while validating all rows                                          | Two-step: `ADD CONSTRAINT ... NOT VALID` then `VALIDATE CONSTRAINT` (weaker lock)                                                            |
| One giant `UPDATE`/`DELETE`         | Locks rows, bloats the table, stalls replication                         | Batch: keyset-select N rows → update → sleep → repeat, resumable from last key                                                               |
| `DROP COLUMN`                       | Fast (metadata) — but data is gone                                       | Only in the contract phase, after dual-write is verified dead                                                                                |

MySQL has no `CONCURRENTLY`: use `ALGORITHM=INSTANT/INPLACE` where the version supports it, `gh-ost` or `pt-online-schema-change` for big tables (`SNAPSHOT` — both maintained; verify current). Postgres big-table rebuilds (PK change, deep bloat, partitioning): `pg_repack`, which rebuilds online with minimal locking and needs ~2x disk temporarily.

## Resumable backfill skeleton

```sql
-- keyset, not OFFSET: stable order, restartable from last processed id
UPDATE users
SET status = 'active'
WHERE id IN (
  SELECT id FROM users WHERE id > :last_id AND status IS NULL
  ORDER BY id LIMIT 5000
)
RETURNING id;   -- record max(id) as the checkpoint; sleep between batches
```

From application code the same shape applies: select batch by `id > last`, write, record checkpoint durably (a checkpoint table or job state), sleep. A crashed backfill resumes at the checkpoint instead of restarting or double-writing. On stores without `RETURNING`, select the batch first, update by primary key, checkpoint the max selected id.

## Migration tooling discipline

- **Versioned, checked-in migrations from the first table** — Alembic (Python), Flyway/Liquibase (JVM), golang-migrate (Go), sqlx/Diesel (Rust), Drizzle Kit / Prisma Migrate (TS). Hand-run SQL files and "schema.sql we run sometimes" are how drift starts.
- **Review generated SQL before it touches anything real.** ORM migration generators emit what the schema diff implies: renaming a column in the schema file becomes `DROP COLUMN` + `ADD COLUMN` — the data is dropped. Prisma flow: `migrate dev --create-only`, read the SQL, fix it to a safe expand-contract, then apply. Drizzle: generate, then read the SQL before `migrate`. This review is the single highest-value habit in this file.
- **`db push`/sync-style commands are for throwaway dev databases only.** They bypass migration history; on a database with data they can apply destructive diffs without review. If a deploy script or CI contains `db push` against anything shared or persistent, that is a finding.
- **Never edit an applied migration.** The hash changes, history diverges, teammates' databases desync. Corrections are new migrations.
- **Forward-only in production.** Down migrations cannot faithfully reverse a migration that touched data (you cannot un-drop a column). "Rollback" is a new forward migration that reverses the change, written and tested like any other. Down migrations are a dev convenience at most.
- **Apply migrations as a distinct step before the new code rolls out** (deploy script step or pre-deploy Job), never lazily on first request, never concurrently from every replica. One applier, ordered, recorded.

## CI and testing

- A CI job that applies all migrations to a throwaway database (a fresh dump or seed of production shape) on every PR — catches broken SQL and lock surprises before merge, and keeps prod-shaped test data honest.
- Migration + dependent code in one PR is fine; shipping them as one _deploy step_ is not — expand and contract are separate deploys even when they merge as one review.

## Schema integrity sweep

- **Foreign keys enforced?** MySQL: check the engine (InnoDB enforces, MyISAM does not). SQLite: `PRAGMA foreign_keys = ON` per connection — it is OFF by default and every connection must set it. Postgres: on by default; hunt instead for `ON DELETE` behavior nobody chose — cascade on a `users` delete that sweeps orders, messages, and uploads is a mass-delete path wearing a constraint's clothing.
- **Unique constraints where identity lives** — email, username, external IDs (`stripe_customer_id`), webhook event IDs. Without the constraint, every race produces a duplicate; with it, the race becomes a retryable error. Partial unique indexes for soft delete: `CREATE UNIQUE INDEX ... ON users(email) WHERE deleted_at IS NULL` — the live rows stay unique, the deleted ones don't collide.
- **Nullable-in-fact columns** — every column the code treats as required should be `NOT NULL`, or the store will accept what the code never imagined.
- **Lossy types** — money in floating point (use integer cents or `NUMERIC`), IDs in 32-bit ints near overflow (YouTube hit this), timestamps without timezone when the product is multi-timezone, enums-as-free-text where a `CHECK` or lookup table belongs.
- **Orphan check** — rows referencing deleted parents (FKs added late don't clean history): count them before adding the constraint, and expect `VALIDATE` to fail if history is dirty. Decide: clean, archive, or keep the constraint `NOT VALID` deliberately and document why.
- **Drift** — schema file vs live DB: most ORMs can diff (`prisma migrate diff`, `drizzle-kit check`). Drift on production means migrations were bypassed at some point — a process finding, not just a schema one.

---

**Provenance:** snapshot 17 August 2026. Sources: Postgres documentation (DDL locking behavior, `CONCURRENTLY`, `NOT VALID`/`VALIDATE`, ADD COLUMN default fast-path), current zero-downtime migration practice guides (expand-contract/parallel-change, batched keyset backfill, forward-only production, pre-deploy application), Prisma/Drizzle documentation (create-only review workflow, `db push` scope), MySQL online-schema-change tooling (gh-ost, pt-online-schema-change) public docs. Version-specific lock behavior decays fastest — re-verify against the running version before asserting.
