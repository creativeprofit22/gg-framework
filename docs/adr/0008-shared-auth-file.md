# ADR 0008: Every process shares one auth.json, changed only under a lock

**Status:** Accepted. Written down on 2026-11-05 from the code and project
instructions; the original date and the alternatives weighed were not recorded.

## Context

The `ggcoder` CLI, the desktop daemon and other GG processes sign in to the
same providers. Asking the user to sign in once per process would be
confusing, so they share one `auth.json`. Several processes can refresh the
same OAuth token at once, and a provider revokes a token once it has been
refreshed.

## Decision

- All processes read and write the same `auth.json` through
  `packages/gg-core/src/auth-storage.ts`.
- A change takes the file lock, re-reads the file inside the lock, then
  replaces the file atomically. Writing back an earlier snapshot is not
  allowed, because it would erase another process's login.
- A forced refresh passes the token that was rejected. If the file already
  holds a different token, a sibling process has refreshed it, so that token
  is reused instead of refreshing again.
- A failed refresh removes only that provider's entry, never the whole file.

## Consequences

- One sign-in works everywhere, and one sign-out applies everywhere.
- Every new writer must follow the lock, re-read and atomic-replace order;
  getting it wrong shows up as logouts in other processes rather than in the
  code that caused them.
- Hard to reverse: splitting the file per process would require migrating
  every existing login.
