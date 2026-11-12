import fs from "node:fs";
import path from "node:path";

/**
 * Hosted-platform CLIs the agent could drive on the user's behalf (Railway,
 * Vercel, gh, ...). Without this the model does not know the CLI is on PATH
 * and sends the user to a dashboard for something `railway logs` answers.
 *
 * Detection is filesystem-only, like verify-commands: a project signal file
 * in `cwd` AND (optionally) the binary on PATH. Nothing is spawned and auth
 * is never probed — `whoami` costs network and goes stale mid-session — so
 * each entry carries its login command instead and the model asks the user
 * to run it when a call fails on auth.
 */
interface PlatformCli {
  /** Executable name looked up on PATH. */
  binary: string;
  /** Any of these existing (relative to cwd) means the project uses the platform. */
  signals: readonly string[];
  /** What the CLI is good for — steers the model toward it. */
  use: string;
  /** Command the USER runs when a call fails on auth (browser step). Empty when N/A. */
  login: string;
  /** Install instruction offered when the project uses the platform but the CLI is absent. */
  install: string;
}

const REGISTRY: readonly PlatformCli[] = [
  {
    binary: "railway",
    signals: ["railway.json", "railway.toml"],
    use: "logs, deploys, variables, services",
    login: "railway login",
    install: "npm i -g @railway/cli",
  },
  {
    binary: "vercel",
    signals: ["vercel.json", ".vercel"],
    use: "deploys, logs, env vars, domains",
    login: "vercel login",
    install: "npm i -g vercel",
  },
  {
    binary: "netlify",
    signals: ["netlify.toml"],
    use: "deploys, logs, env vars, functions",
    login: "netlify login",
    install: "npm i -g netlify-cli",
  },
  {
    binary: "flyctl",
    signals: ["fly.toml"],
    use: "deploys, logs, machines, secrets",
    login: "flyctl auth login",
    install: "https://fly.io/docs/flyctl/install/",
  },
  {
    binary: "wrangler",
    signals: ["wrangler.toml", "wrangler.json", "wrangler.jsonc"],
    use: "Cloudflare Workers deploys, tail logs, KV/D1/R2",
    login: "wrangler login",
    install: "npm i -g wrangler",
  },
  {
    binary: "supabase",
    signals: ["supabase/config.toml"],
    use: "migrations, db push/pull, functions, project status",
    login: "supabase login",
    install: "npm i -g supabase",
  },
  {
    binary: "firebase",
    signals: ["firebase.json"],
    use: "deploys, functions logs, emulators",
    login: "firebase login",
    install: "npm i -g firebase-tools",
  },
  {
    binary: "gh",
    signals: [".github"],
    use: "PRs, issues, CI run logs, releases",
    login: "gh auth login",
    install: "https://cli.github.com",
  },
  {
    binary: "docker",
    signals: [
      "Dockerfile",
      "compose.yaml",
      "compose.yml",
      "docker-compose.yml",
      "docker-compose.yaml",
    ],
    use: "build images, run containers, compose logs",
    login: "",
    install: "https://docs.docker.com/get-docker/",
  },
  {
    binary: "aws",
    signals: ["samconfig.toml", "cdk.json", "serverless.yml", "serverless.yaml"],
    use: "CloudWatch logs, Lambda, S3, stack status",
    login: "aws sso login (or aws configure)",
    install: "https://aws.amazon.com/cli/",
  },
  {
    binary: "sam",
    signals: ["samconfig.toml"],
    use: "SAM build/deploy, local Lambda invoke, stack logs",
    login: "",
    install:
      "https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html",
  },
  {
    binary: "serverless",
    signals: ["serverless.yml", "serverless.yaml"],
    use: "Serverless Framework deploys, function logs, invoke",
    login: "serverless login",
    install: "npm i -g serverless",
  },
  {
    binary: "heroku",
    signals: ["heroku.yml", "app.json", "Procfile"],
    use: "logs, releases, config vars, dynos, add-ons",
    login: "heroku login",
    install: "brew install heroku/brew/heroku (or npm i -g heroku)",
  },
  {
    binary: "render",
    signals: ["render.yaml"],
    use: "services, deploys, logs, env vars",
    login: "render login",
    install: "brew install render",
  },
  {
    binary: "doctl",
    signals: [".do/app.yaml", ".do/deploy.template.yaml"],
    use: "App Platform deploys/logs, droplets, databases",
    login: "doctl auth init",
    install: "brew install doctl",
  },
  {
    binary: "gcloud",
    signals: ["app.yaml", "cloudbuild.yaml", ".gcloudignore"],
    use: "App Engine/Cloud Run deploys, Cloud Build, logs, IAM",
    login: "gcloud auth login",
    install: "https://cloud.google.com/sdk/docs/install",
  },
  {
    binary: "az",
    signals: ["host.json", "staticwebapp.config.json"],
    use: "Azure Functions/Static Web Apps, resources, logs",
    login: "az login",
    install: "https://learn.microsoft.com/cli/azure/install-azure-cli",
  },
  {
    binary: "azd",
    signals: ["azure.yaml"],
    use: "azd up/deploy, provision, env, monitor",
    login: "azd auth login",
    install: "https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd",
  },
  {
    binary: "terraform",
    signals: [".terraform.lock.hcl", "main.tf"],
    use: "plan, apply, state, outputs",
    login: "",
    install: "https://developer.hashicorp.com/terraform/install",
  },
  {
    binary: "pulumi",
    signals: ["Pulumi.yaml"],
    use: "preview, up, stack outputs, config",
    login: "pulumi login",
    install: "brew install pulumi/tap/pulumi (or curl -fsSL https://get.pulumi.com | sh)",
  },
  {
    binary: "kubectl",
    signals: ["kustomization.yaml", "skaffold.yaml", "Chart.yaml"],
    use: "pods, logs, apply, rollouts, port-forward",
    login: "",
    install: "https://kubernetes.io/docs/tasks/tools/",
  },
  {
    binary: "helm",
    signals: ["Chart.yaml"],
    use: "chart install/upgrade, releases, values",
    login: "",
    install: "https://helm.sh/docs/intro/install/",
  },
  {
    binary: "eas",
    signals: ["eas.json"],
    use: "Expo builds, submit, updates, build logs",
    login: "eas login",
    install: "npm i -g eas-cli",
  },
  {
    binary: "fastlane",
    signals: ["fastlane/Fastfile"],
    use: "iOS/Android build lanes, signing, store upload",
    login: "",
    install: "brew install fastlane",
  },
  {
    binary: "sentry-cli",
    signals: [".sentryclirc", "sentry.properties"],
    use: "releases, source maps, debug symbols",
    login: "sentry-cli login",
    install:
      "brew install getsentry/tools/sentry-cli (or curl -sL https://sentry.io/get-cli/ | sh)",
  },
  {
    binary: "glab",
    signals: [".gitlab-ci.yml"],
    use: "MRs, issues, pipeline logs, releases",
    login: "glab auth login",
    install: "brew install glab",
  },
  {
    binary: "shopify",
    signals: ["shopify.app.toml", "shopify.theme.toml"],
    use: "app/theme dev, deploy, push, logs",
    login: "shopify auth login",
    install: "npm i -g @shopify/cli@latest",
  },
  {
    binary: "kamal",
    signals: ["config/deploy.yml", ".kamal"],
    use: "deploy, app logs, rollback, accessories",
    login: "",
    install: "gem install kamal",
  },
  {
    binary: "convex",
    signals: ["convex.json", "convex"],
    use: "dev, deploy, function logs, dashboard data, env",
    login: "convex login",
    install: "npm i convex",
  },
  {
    binary: "sanity",
    signals: ["sanity.cli.ts", "sanity.cli.js", "sanity.config.ts", "sanity.config.js"],
    use: "deploy studio, datasets, documents, schema",
    login: "sanity login",
    install: "npm i sanity",
  },
  {
    binary: "sst",
    signals: ["sst.config.ts"],
    use: "deploy, dev, resource outputs, secrets",
    login: "",
    install: "npm i sst",
  },
];

export interface PlatformCliStatus {
  binary: string;
  use: string;
  login: string;
  install: string;
  installed: boolean;
  /** Found only in the project's node_modules/.bin — invoke via `npx`. */
  local: boolean;
}

/**
 * Platforms `cwd` uses, each flagged installed/missing. Order follows the
 * registry so the rendered section is stable across sessions (cached prefix).
 */
export function detectPlatformClis(
  cwd: string,
  pathEnv: string = process.env.PATH ?? "",
): PlatformCliStatus[] {
  const out: PlatformCliStatus[] = [];
  const localBin = path.join(cwd, "node_modules", ".bin");
  for (const cli of REGISTRY) {
    if (!cli.signals.some((s) => exists(path.join(cwd, s)))) continue;
    const global = onPath(cli.binary, pathEnv);
    const local = !global && onPath(cli.binary, localBin);
    out.push({
      binary: cli.binary,
      use: cli.use,
      login: cli.login,
      install: cli.install,
      installed: global || local,
      local,
    });
  }
  return out;
}

export function renderPlatformClisSection(clis: readonly PlatformCliStatus[]): string {
  if (clis.length === 0) return "";
  const ready = clis.filter((c) => c.installed);
  const missing = clis.filter((c) => !c.installed);
  const parts: string[] = [];
  if (ready.length > 0) {
    parts.push(
      "Installed and yours to run — use them directly; never send the user to a dashboard for something these answer:\n" +
        ready
          .map((c) => {
            const prefix = c.local ? "npx " : "";
            return (
              `- \`${prefix}${c.binary}\` — ${c.use}.` +
              (c.login
                ? ` Auth failure → ask the user to run \`${prefix}${c.login}\`, then retry.`
                : "")
            );
          })
          .join("\n"),
    );
  }
  if (missing.length > 0) {
    parts.push(
      "Project uses these but the CLI is not installed — when it would help, offer ONCE to install, then drop it:\n" +
        missing.map((c) => `- \`${c.binary}\` — ${c.use}. Install: ${c.install}`).join("\n"),
    );
  }
  return `## Platform CLIs\n\n${parts.join("\n\n")}`;
}

// ── helpers ──────────────────────────────────────────────────────────────

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function onPath(binary: string, pathEnv: string): boolean {
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (exists(path.join(dir, binary + ext))) return true;
    }
  }
  return false;
}
