# AGENTS.md

Read `CLAUDE.md` first — it is the authoritative project context (package
boundaries, app architecture, workflows, gotchas).

## Commands

- Install: `pnpm install`
- Build all: `pnpm build` (build order matters: gg-ai → gg-agent → ggcoder)
- Typecheck: `pnpm check`
- Lint: `pnpm lint` (fix: `pnpm lint:fix`)
- Test all: `pnpm test` (single package: `pnpm --filter @kenkaiiii/ggcoder test`)

## CI

CI lives in `.github/workflows/` and **must stay green**. `ci.yml` runs
build + typecheck + test + sidecar smoke on Linux/macOS/Windows — the Windows
leg is a blocking gate; never make it pass with `continue-on-error` or skipped
tests. Release automation (`release.yml`) triggers on `v*` tags; see
`.gg/commands/release.md`.

Never commit with `--no-verify`.
