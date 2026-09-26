# Lean — per-stack playbooks

Load only the sections the profile triggered. Commands assume a POSIX shell unless noted. Claims sourced on the snapshot date (17 August 2026) carry `SNAPSHOT`; tool versions and thresholds decay — re-verify with web access before asserting as current.

## Web frontend

**Targets (official web.dev stable thresholds, measured at p75, mobile and desktop split):**

| Metric                          | Good    | Needs improvement | Poor    |
| ------------------------------- | ------- | ----------------- | ------- |
| LCP (Largest Contentful Paint)  | ≤ 2.5s  | ≤ 4.0s            | > 4.0s  |
| INP (Interaction to Next Paint) | ≤ 200ms | ≤ 500ms           | > 500ms |
| CLS (Cumulative Layout Shift)   | ≤ 0.1   | ≤ 0.25            | > 0.25  |

SEO blogs circulate claims of a March 2026 tightening of LCP to 2.0s (`SNAPSHOT` — could not be confirmed on web.dev at snapshot time). Treat 2.0s as an aspiration, not a threshold; verify before quoting either number to a user.

**Measure:** Lighthouse (DevTools or `lighthouse https://x --output json` in CI), Chrome DevTools Performance tab for long tasks, Network waterfall for request chains, Coverage tab for shipped-but-unused JS/CSS, `web-vitals` npm package for RUM field data. Lighthouse CI or `size-limit` as the regression gate.

**Symptom → usual cause:**

| Symptom  | Usual causes                                                                               | Fixes                                                                                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slow LCP | Oversized hero image, render-blocking CSS/JS, slow TTFB, web-font swap                     | AVIF/WebP + `srcset`, explicit dimensions, `fetchpriority="high"` on the LCP image, preload the font + `font-display: swap` (subset it), inline critical CSS / defer the rest, fix server TTFB first if > ~400–600ms — no frontend work survives that |
| Poor INP | Long tasks (>50ms) on the main thread, expensive handlers, layout thrash, hydration weight | Split long tasks (`scheduler.yield()` where available, else task chunking), debounce expensive input handlers, batch DOM reads before writes, animate only `transform`/`opacity`, move heavy compute to a web worker, ship less JS                    |
| High CLS | Images/embeds without dimensions, late banners pushing content, font swap                  | Width/height or `aspect-ratio` on all media, reserve ad/banner slots (`min-height`), `content-visibility` for below-fold, avoid injecting above existing content                                                                                      |
| Slow nav | Waterfall fetches, client-side everything, no prefetch                                     | Parallelize with `Promise.all`, prefetch likely-next routes, partial/staged rendering, keep-alive connections                                                                                                                                         |

**Sweep list:** code splitting at routes (`React.lazy`/dynamic `import()`), tree-shaking blockers (side-effectful modules, CJS in the graph), image audit (format, dimensions, `loading="lazy"` + `decoding="async"` below fold), font count and subsetting, dependency weight (bundle analyzer: `source-map-explorer`, `rollup-plugin-visualizer`, `webpack-bundle-analyzer`), virtualized long lists, memoization only where the React DevTools Profiler showed a real re-render cost — memo-by-default is perf theater, context split instead of one giant provider, `passive: true` listeners for scroll/touch, debounced resize/search handlers, service worker caching where offline or repeat visits matter.

## Node.js / backend / API

**Measure:** `autocannon` or `k6` for load (watch p99, not the average — the average lies), `clinic doctor` / `clinic flame` / `0x` for CPU and event-loop diagnosis, `--inspect` + Chrome DevTools for heap. DB: slow-query log, `EXPLAIN ANALYZE`.

**Sweep list:**

- **Event-loop blocking:** sync fs/crypto/zlib in request handlers, `JSON.parse` of huge payloads on the hot path, regex backtracking. Move to workers or streams.
- **N+1 queries:** one join/include/dataloader instead of a loop of queries. The most common backend bottleneck, by far.
- **Missing indexes:** every frequent filter/sort column; verify with `EXPLAIN ANALYZE` that the plan uses them.
- **Unpaginated reads:** `SELECT *` on growing tables, `findMany()` without `take`. Cursor pagination for stable ordering.
- **Connection pools:** sized for the DB's real limit; check for pool exhaustion under load (requests queueing on a connection).
- **Caching with bounds:** TTL or LRU on expensive derivations; invalidate on write. Cache stampede guard (lock or stale-while-revalidate) when a hot key expires.
- **Payload:** gzip/brotli on responses, HTTP/2+ or keep-alive, avoid re-serializing the same object per request.
- **Memory ceiling:** `--max-old-space-size` matched to the container limit so GC pressure shows up as errors you chose, not an OOM kill at a random allocation.
- **Retries:** capped, with backoff and jitter; unbounded retry loops are a self-inflicted outage plus a memory leak (each attempt holds state).

## Electron

Official maintainer guidance (electronjs.org performance tutorial, `SNAPSHOT`): profile, then fix the most resource-hungry thing; repeat. VS Code and Slack got fast exactly this way.

**Sweep list:**

- **Lazy `require`:** Node modules loaded at startup cost startup forever. Require at first use for heavy/rare paths; defer expensive setup with idle-time initialization.
- **Price modules before adopting:** `node --cpu-prof --heap-prof -e "require('mod')"` — the canonical example is a "simple" connectivity checker that parsed a 100k-line JSON port list at load. Server-oriented modules are often wrong for desktop.
- **Never block the main process:** UI jank and dead IPC come from main-process busy work. CPU-heavy work goes to utility processes / worker threads; keep main for orchestration.
- **Bundle renderer code** (bundler or esbuild) instead of hundreds of module loads at window open.
- **Window hygiene:** lazy-create `BrowserWindow`s, destroy (not just hide) windows whose content is expensive and rarely revisited, `process.getProcessMemoryInfo()` per process to find which side eats.
- **Tray/menu/global-shortcut listeners** registered once, removed on app quit; background throttling is default — don't defeat it with busy polling (`powerSaveBlocker` only while genuinely needed).
- **Startup:** `Menu.setApplicationMenu(null)` when no menu is needed; splash/deferred window show to cut time-to-visible; V8 compile cache for large renderer bundles.
- Security config (`contextIsolation`, sandbox) is bulletproof's lane — but note sandboxing also shrinks renderer memory; do not weaken it for speed.

## Tauri

**Sweep list:**

- **Release profile:** in `Cargo.toml` `[profile.release]` — `lto = true` (or `"thin"`), `codegen-units = 1`, `strip = true`; `panic = "abort"` if acceptable. `opt-level = "s"/"z"` trades speed for size — measure which you need.
- **IPC cost:** every `invoke` serializes with serde — don't shuttle large blobs or big JSON back and forth per keystroke; chunk, delta, or move the work to the Rust side. Watch for per-frame IPC from frontend animation/monitoring loops.
- **State:** `tauri::State` with `Mutex` held across `.await` serializes everything behind it; scope locks tightly.
- **Frontend** follows the web section exactly — the webview is a browser; bundle size and long tasks hit the same.
- **Assets:** embed vs. fetch per asset class; large binaries should not ship inside the binary if they can be fetched/unpacked on demand.
- **Plugins:** lazy-init heavy plugins; each one is startup cost on the Rust and JS side both.
- **Measure:** `cargo bloat` / `cargo tree -d` for binary weight and duplicate deps; standard Rust profilers (`perf`, Instruments, `cargo-flamegraph`) for hot paths.

## Mobile

**Sweep list:** cold-start path (lazy screen registration, defer non-critical SDK init — analytics can wait), list virtualization (`FlatList`/`RecyclerView`/`LazyColumn` — never render 1000 rows), image assets per density via asset catalogs (not runtime-downscaled full images), main-thread discipline (decode/parse off the main thread), memory-warning handling that actually drops caches.

**Measure/leak tools:** Android — Android Studio Profiler, `LeakCanary` for lifecycle leaks, `dumpsys meminfo`; iOS — Instruments Allocations/Leaks, Xcode memory graph debugger. Responding to memory warnings by freeing caches is table stakes on both.

## Native / compiled

- **Rust:** leaks are usually `Rc`/`Arc` cycles (switch one direction to `Weak`), `Box::leak`, unbounded channels, or tasks blocked forever holding state. Blocking calls inside async runtime threads stall the executor — use `spawn_blocking`. Measure: `cargo-flamegraph`, `heaptrack`, `pprof` crate. Children must be `wait()`ed — dropping a `Child` does not reap it (see `references/memory-and-processes.md`).
- **C/C++:** every `malloc`/`new`/`fopen` has an owner that frees/closes on all paths — RAII or scope guards, not discipline. Measure: valgrind memcheck/massif, AddressSanitizer/LeakSanitizer (`-fsanitize=address,leak`), `heaptrack`.
- **Go:** goroutine leaks — a goroutine blocked on a channel/ctx that never arrives holds everything it captured forever. `pprof` goroutine + heap profiles tell you both. Set `GOMEMLIMIT` in containers; tune `GOGC` only after measuring.
- **JVM:** bound the heap (`-Xmx`) to the container, watch for unbounded caches and listener registries; `jmap -histo`, async-profiler, JFR for allocation sites.
- **Games/hot loops:** frame budget is 16.6ms @60 (8.3ms @120) including everything. No per-frame allocation (object pools), no per-frame sync I/O, no GC spikes mid-frame; batch draws; time-slice background work.

## Python

Generators/streams instead of list-building for large data; vectorize hot loops (NumPy/pandas — or Polars for large frames) instead of Python-level iteration; never block the asyncio event loop with sync I/O or CPU work (offload to processes); `functools.lru_cache` is bounded — `cached_property` and hand-rolled dict caches are not. Measure: `tracemalloc` for allocation deltas, `memory_profiler` line-level, `py-spy` for live flamegraphs without stopping the process. Watch for reference cycles keeping big objects alive when `gc` is disabled or timing-dependent.

## Data & queries (any stack)

`EXPLAIN (ANALYZE)` the slow ones; indexes on frequent filters/sorts — but every index taxes writes, so measure both sides. Batch writes; avoid N single-row inserts inside a transaction per row. Cursor/keyset pagination over offset for deep pages. Slow-query log threshold low enough to catch regressions in CI-like environments. Cache expensive reads with explicit invalidation, not hope.

## Payload & dead weight (all stacks)

`SNAPSHOT` (17 Aug 2026): **Knip** is the standard JS/TS dead-code finder — unused files, exports, dependencies, and devDependencies across monorepo workspaces; `depcheck` is the older alternative. CSS: PurgeCSS (or the framework's built-in pruning) against real markup — beware class names built dynamically, which purgers cannot see; guard with a safelist. Shipped-code audit: DevTools Coverage for what the browser actually ran.

**Sweep list:** `knip` in CI; duplicate dependencies (`pnpm why <pkg>`, `npm ls <pkg>`) — two versions of one library is double weight; "two of the same job" audit (two icon sets, two date libs, two CSS systems, a utility lib plus hand-rolled copies of its functions); polyfills for browsers no longer supported; debug/symbol payloads shipped in release (strip; source maps to a symbol server, not the bundle); largest-files audit (`du`, bundle analyzer) — the top ten files are usually the whole story; unused assets in repos (images, fonts nobody references).

## Styling consistency (payload view)

The rule: **one way to express one visual decision.** Hunt repeated rule blocks that differ by one value, spacing/color literals that duplicate existing design tokens, the same component styled three ways, utility classes wrapped around handwritten CSS doing the same job, dead rules for removed components. Each duplication is bytes today and divergence tomorrow. Kill the copies, keep the token. If resolving it requires a design _decision_ (which of three styles is right), that call belongs to evidence-led-ui — coordinate rather than decide unilaterally.

---

**Provenance:** snapshot 17 August 2026. Sources: web.dev Web Vitals (stable LCP/INP/CLS thresholds), Electron official performance tutorial (module cost, lazy loading, main-process blocking, profiling guidance), Rust std `process::Child` docs (zombie reaping), Knip documentation and 2026 ecosystem coverage (dead-code standard claim — `SNAPSHOT`), Valgrind/LeakCanary/Instruments/pprof public docs for tool usage. Version-specific flags and thresholds decay fastest; re-verify before asserting.
