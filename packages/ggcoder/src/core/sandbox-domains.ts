/**
 * Default network allowlist for the OS command sandbox.
 *
 * The sandbox is allowlist-only (a bare `*` is rejected), so shipping it on by
 * default is only viable if ordinary development still works untouched. These
 * are the hosts mainstream toolchains actually contact for dependency
 * resolution, source checkout and registry auth — nothing that reads user data.
 *
 * Deliberately excluded: arbitrary app/API hosts, telemetry endpoints and
 * URL shorteners. A project that needs one adds it once in Settings, which is
 * the moment the boundary earns its keep.
 */
export const DEFAULT_ALLOWED_DOMAINS: readonly string[] = [
  // ── Source hosting (git clone/fetch/push over HTTPS) ──
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "gitlab.com",
  "*.gitlab.com",
  "bitbucket.org",
  "*.bitbucket.org",
  "codeberg.org",

  // ── JavaScript ──
  "registry.npmjs.org",
  "*.npmjs.org",
  "registry.yarnpkg.com",
  "*.yarnpkg.com",
  "jsr.io",
  "deno.land",
  "*.deno.land",
  "unpkg.com",
  "cdn.jsdelivr.net",
  "*.jsdelivr.net",
  "cdnjs.cloudflare.com",

  // ── Python ──
  "pypi.org",
  "*.pypi.org",
  "files.pythonhosted.org",
  "*.pythonhosted.org",

  // ── Go (module proxy + checksum database) ──
  "proxy.golang.org",
  "sum.golang.org",
  "*.golang.org",
  "storage.googleapis.com",

  // ── Rust ──
  "crates.io",
  "*.crates.io",
  "static.rust-lang.org",
  "*.rust-lang.org",

  // ── Ruby ──
  "rubygems.org",
  "*.rubygems.org",

  // ── JVM ──
  "repo1.maven.org",
  "*.maven.org",
  "repo.maven.apache.org",
  "plugins.gradle.org",
  "*.gradle.org",

  // ── PHP ──
  "packagist.org",
  "*.packagist.org",

  // ── .NET ──
  "api.nuget.org",
  "*.nuget.org",

  // ── Containers ──
  "docker.io",
  "*.docker.io",
  "*.docker.com",
  "ghcr.io",
  "quay.io",
  "registry.k8s.io",

  // ── macOS/Linux toolchain installers ──
  "formulae.brew.sh",
  "*.brew.sh",
];
