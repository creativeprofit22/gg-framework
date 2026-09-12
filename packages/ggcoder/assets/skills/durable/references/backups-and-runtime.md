# Durable — backups, recovery & runtime data safety

Load for any backup, recovery, or runtime finding. `SNAPSHOT` = sourced 17 August 2026 — provider tiers and defaults change often; verify before asserting.

## Part 1 — Backups & recovery

### RPO/RTO first

- **RPO** (Recovery Point Objective): how much data loss is acceptable — "5 minutes" vs "a day".
- **RTO** (Recovery Time Objective): how long until you are back up.

Pick both consciously; they dictate the tier. An app where users type for hours wants an RPO near zero; a read-mostly catalog may accept a day. Stating them where the backup is configured turns "we have backups" into an actual contract.

### The tiers, best to weakest

1. **PITR (point-in-time recovery)** — base backup + continuous write-ahead-log archive; restore to any second in the retention window. RPO of seconds-to-minutes. Gold standard for transactional data.
2. **Scheduled logical dumps** (`pg_dump`, `mongodump`, Firestore export) — portable, cheap, easy to verify by inspection; but restore time scales with size and everything after the dump starts is lost. Fine as the archive layer or the only layer for small apps.
3. **Storage/block snapshots** — fast, near-zero impact; restoring a running DB from a raw snapshot leaves crash recovery to do the rest. Good for staging clones; for disaster recovery prefer PITR.
4. **Nothing / a copy on the same machine** — the default state of most small projects, and the finding most often reported after it stops mattering.

**3-2-1 floor**: at least 3 copies, 2 different media/systems, 1 off-site (different provider or account is fine). A dump cron writing to the same VPS is one disk failure from zero.

### Managed-provider baselines (`SNAPSHOT` 17 Aug 2026 — verify tiers/retention before quoting)

| Provider       | What you get by default/on paid tiers                                                        |
| -------------- | -------------------------------------------------------------------------------------------- |
| Supabase       | Pro: 7-day PITR included; daily logical backups; restore lands a new project                 |
| Neon           | Continuous WAL archive; PITR up to 30 days on higher tiers; branching doubles as time-travel |
| AWS RDS        | Automated backups 1–35 days (PITR); manual snapshots on demand                               |
| Crunchy Bridge | 14-day PITR by default; longer via S3 archive                                                |
| MongoDB Atlas  | Continuous backup / cloud snapshots by tier                                                  |

The recurring failure: the free tier's weekly backup or none at all, assumed to be PITR because the marketing page said "backups". Check the project's actual settings, not the provider's homepage.

**Self-hosted Postgres**: pgBackRest, Barman, or WAL-G → S3-compatible storage. **Self-hosted/embedded SQLite**: Litestream (continuous WAL replication to object storage, near-zero RPO) or restic/borg on a schedule as the weaker floor. **Firestore/DynamoDB-style**: scheduled exports to storage — PITR is a paid or absent feature; check the project's state.

### The restore drill (the only proof)

1. Note the current time / snapshot point of a known state.
2. Make a recognizable change (insert a canary row).
3. Restore to the noted point into a _separate_ location — never over the live DB.
4. Verify the canary is absent. Time the whole operation — that measured duration is the real RTO; write it down.
5. Repeat on a schedule (quarterly is the common bar); the drill doc itself is the runbook you'll follow at 3am.

**File uploads need their own answer** — DB backups don't cover a disk of user uploads unless the backup includes the volume or the uploads live in object storage with versioning (S3 versioning or equivalent preserves deleted/overwritten objects — turn it on and state the retention). DB row + orphaned-file mismatch is a finding: cleanup discipline (delete file then row, in that order, with the row's file path recorded for resweep) or accept orphans.

### What a backup must exclude/include

Include: the data, schema history (migrations), and anything unrecreatable (uploads, generated-but-expensive artifacts). Exclude/rotate: secrets in plaintext dumps (a dump with PII inherits compliance-guard's storage rules — encrypt at rest, restrict access), logs, caches. Test that the restore includes what you think: a backup that skips a table because of a wrong flag is the most humiliating restore failure.

## Part 2 — Runtime data safety

### Idempotency & exactly-once writes

Anything retried — webhooks, queue jobs, mobile clients on flaky networks, imports — **will** run twice. Patterns, in order of preference:

- **Store-side dedup**: unique constraint on the natural key (webhook event ID, job ID + attempt) and `INSERT ... ON CONFLICT DO NOTHING` returning whether it inserted. The store is the arbiter; no race can beat it.
- **Upsert by natural key**: `ON CONFLICT ... DO UPDATE` with a deterministic outcome, so replay converges instead of duplicating.
- **Compare-and-set / optimistic concurrency**: `UPDATE ... WHERE version = :expected`, check affected count — the guard for read-modify-write races (balance updates, seat claims, counter increments).
- **Outbox pattern**: state changes and the events they trigger written in one transaction to an outbox table, published by a separate relay — eliminates "DB updated but email/queue lost" (and its evil twin, "email sent but DB rolled back"). The default answer where a store lacks cross-service transactions.

Check-then-act without a constraint (`if not exists: insert`) is a bug that just hasn't raced yet.

### Connection & session pitfalls (correctness, not speed)

- **Transaction-mode poolers** (PgBouncer/Supavisor, Neon pooler, RDS Proxy defaults): each transaction may run on a different connection — session state breaks. Casualties: session-level `SET`/`prepared statements` (named ones), advisory locks, `LISTEN/NOTIFY`, temp tables, `COPY`. Patterns: keep per-transaction state in SQL (`SET LOCAL`), use `pg_advisory_xact_lock` (transaction-scoped), or route state-needing work to a direct/session connection.
- **Serverless functions**: one pool per _instance_ (module scope), never per request; assume the process freezes between invocations — no in-memory "it'll flush later".
- **Postgres connections are processes** — exhausting them fails every new client; the fix is a pooler, not a bigger `max_connections`. (Sizing the pool for throughput is lean's lane.)
- **Always release/close in `finally`** — a leaked connection per request is a slow outage and a durability finding.

### SQLite runtime rules

- **WAL mode on** (`PRAGMA journal_mode=WAL`) — readers don't block the writer; the default rollback journal serializes everything.
- **`busy_timeout` set** (e.g. 5000ms) — without it, concurrent access returns `SQLITE_BUSY` instantly instead of waiting.
- **`PRAGMA foreign_keys = ON` on every connection** — it is per-connection and off by default; constraints silently unenforced is a schema-integrity finding wearing runtime clothes.
- **One writer** — route writes through a single instance or a write queue; multiple app instances writing one SQLite file on shared/network storage corrupts. Local disk (NVMe), not NFS.
- **Backup without Litestream**: `VACUUM INTO 'backup.db'` or the `sqlite3 .backup` command — never copy the file mid-write; the WAL file and the checkpoint state are part of the database.

### Atomic file writes and cleanup

- **Temp-then-rename** for any file a reader may open: write to `path.tmp`, `fsync`, then `rename` over the target. Atomic on POSIX; a crash mid-write never leaves a truncated JSON the app will happily parse.
- **Delete in dependency order and resweep**: child rows then parent; file after the row referencing it is gone (or record orphans for a sweep job). Reversible orderings first: soft-delete the row, mark the file, sweep files later — undoability beats tidiness.

---

**Provenance:** snapshot 17 August 2026. Sources: Postgres WAL/PITR documentation and pgBackRest/Barman/WAL-G docs, Litestream documentation (SQLite WAL replication), provider documentation for Supabase/Neon/RDS/Crunchy/MongoDB Atlas backup tiers (tier specifics are `SNAPSHOT` — they change often), PgBouncer documentation (transaction-mode feature matrix), SQLite documentation (WAL, busy_timeout, foreign_keys pragma, VACUUM INTO), current disaster-recovery practice guides (3-2-1, RPO/RTO, restore drills). Provider tiers and defaults decay fastest — re-verify before asserting.
