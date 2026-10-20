<pre align="center">
   ▄██████▄     ▄██████▄        ▄████████  ▄██████▄  ████████▄     ▄████████    ▄████████
  ███    ███   ███    ███      ███    ███ ███    ███ ███   ▀███   ███    ███   ███    ███
  ███    █▀    ███    █▀       ███    █▀  ███    ███ ███    ███   ███    █▀    ███    ███
 ▄███         ▄███             ███        ███    ███ ███    ███  ▄███▄▄▄      ▄███▄▄▄▄██▀
▀▀███ ████▄  ▀▀███ ████▄       ███        ███    ███ ███    ███ ▀▀███▀▀▀     ▀▀███▀▀▀▀▀&nbsp;&nbsp;
  ███    ███   ███    ███      ███    █▄  ███    ███ ███    ███   ███    █▄  ▀███████████
  ███    ███   ███    ███      ███    ███ ███    ███ ███   ▄███   ███    ███   ███    ███
  ████████▀    ████████▀       ████████▀   ▀██████▀  ████████▀    ██████████   ███    ███
                                                                               ███    ███
</pre>

https://github.com/user-attachments/assets/8f264af5-c757-4dcc-b622-b9e0edf36f89

<p align="center">
  <strong>Cause the other agents piss me off.</strong>
</p>

<p align="center">
  <a href="https://github.com/KenKaiii/gg-framework/releases/latest"><img src="https://img.shields.io/github/v/release/KenKaiii/gg-framework?style=for-the-badge&label=Download&color=b0b6ff" alt="GG Coder desktop release"></a>
  <a href="https://github.com/KenKaiii/gg-framework/stargazers"><img src="https://img.shields.io/github/stars/KenKaiii/gg-framework?style=for-the-badge&label=Stars&color=yellow" alt="Star GG Coder on GitHub"></a>
  <a href="https://www.npmjs.com/package/@kenkaiiii/ggcoder"><img src="https://img.shields.io/npm/v/@kenkaiiii/ggcoder?style=for-the-badge&label=CLI&color=blue" alt="ggcoder npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://youtube.com/@kenkaidoesai"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://skool.com/kenkai"><img src="https://img.shields.io/badge/Skool-Community-b0b6ff?style=for-the-badge" alt="Skool"></a>
</p>

GG Coder is a desktop AI app for coding, chatting, running whole goals and making videos. Pick your AI provider, open as many windows as you need, and tell it what you want done. Less babysitting, more getting things done.

## Why GG Coder

**The leanest coding agent I've tested.** I raced GG Coder against 9 other coding agents on the same model. GG had the fastest time, level with Goose and Copilot, and was the cheapest of all 10.

| Agent              | Time for the full suite | Usage per suite | GG Coder compared          |
| ------------------ | ----------------------- | --------------- | -------------------------- |
| **GG Coder**       | **125 s**               | **$0.095**      |                            |
| Goose              | 126 s                   | $0.106          | same speed, 11% less usage |
| GitHub Copilot CLI | 129 s                   | $0.126          | same speed, 25% less usage |
| Claude Code        | 154 s                   | $0.212          | 19% faster, 55% less usage |
| Oh My Pi           | 161 s                   | $0.150          | 23% faster, 37% less usage |
| Crush              | 164 s                   | $0.196          | 24% faster, 52% less usage |
| Factory Droid      | 172 s                   | $0.130          | 28% faster, 27% less usage |
| Deep Agents        | 197 s                   | $0.206          | 37% faster, 54% less usage |
| Qwen Code          | 229 s                   | $0.319          | 46% faster, 70% less usage |
| Hermes Agent       | 285 s                   | $0.146          | 56% faster, 35% less usage |

On a subscription, less usage means more work out of your plan. The same allowance covers about **2.2x** the coding it would in Claude Code, and about **1.6x** what it would in Oh My Pi.

<sub>Every agent on Claude Haiku 5.5, across more than 3,000 test runs.</sub>

## What you get

- **Code:** a coding agent that plans, edits, runs your tests and tells you straight what it verified. Plan mode lets you review the plan before anything changes.
- **Ken Autopilot:** reviews the coding work and keeps it going until it's actually done and checked, so you don't have to babysit it.
- **GG Goals:** hand over a whole goal and walk away. It agrees the approach with you, then does the work, splitting big independent parts across a team of workers that run side by side, and keeps you posted until the goal is met. It works on any folder, not just code: research, documents, plans.
- **Agent Steroids:** a local library of real, current open-source code. Your agent looks up how real projects solve a problem instead of guessing, offline and with no limits.
- **Chat:** conversations that remember context.
- **GG Motion:** turns your ideas into videos.
- **Your models, your way:** sign in with Claude, ChatGPT, Gemini, Grok or Kimi subscriptions, use API keys for OpenAI, Anthropic, DeepSeek, GLM, MiniMax, OpenRouter and more, or run local models. A usage meter shows how much of your plan you've used.
- **Plugs into your workflow:** connect MCP servers, and drive GG from Telegram, voice notes included.

## Get started

1. Install GG Coder:

   **macOS (Apple Silicon):** [Download the latest release](https://github.com/KenKaiii/gg-framework/releases/latest) and open the `.dmg`.

   **Windows:** [Download the latest release](https://github.com/KenKaiii/gg-framework/releases/latest) and run the `.exe` installer.

   **Development:** With Node.js 22 or newer, pnpm 10 (the repo pins `pnpm@10.17.1`; `corepack enable` picks it up), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) installed:

   ```bash
   git clone https://github.com/KenKaiii/gg-framework.git
   cd gg-framework
   pnpm install
   pnpm build
   pnpm --filter gg-app tauri dev
   ```

2. Open the app, connect your AI provider, and pick Code, Chat, or Motion.

3. Check your changes (from the repo root):

   ```bash
   pnpm check          # typecheck every package
   pnpm lint           # ESLint
   pnpm format:check   # Prettier, read-only
   pnpm test           # full test suite
   ```

   For app-only work, `pnpm --filter gg-app check`, `lint` and `test` are quicker. See [gg-app/README.md](gg-app/README.md).

### Optional settings

Nothing needs an `.env` file: you sign in to providers inside the app. These environment variables are optional overrides:

| Variable                                                                   | What it does                                                                           |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GG_AGENT_DIR`                                                             | Absolute path for settings, sessions and logins. Defaults to `~/.gg`.                  |
| `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_DEPLOYMENT` | Azure OpenAI connection. The base URL must be a full `https` Responses endpoint.       |
| `AZURE_OPENAI_MODEL_ID`                                                    | Optional model name to show for the Azure deployment.                                  |
| `GGCODER_GEMINI_OAUTH_CLIENT_ID`, `GGCODER_GEMINI_OAUTH_CLIENT_SECRET`     | Use your own Google Cloud OAuth client for Gemini sign-in instead of the built-in one. |

## This Local Fork

This checkout is a local fork of [KenKaiii/gg-framework](https://github.com/KenKaiii/gg-framework) that carries its own fixes. It builds as a separate app, **GG Coder Local Fork**, so it never overwrites the official install, and it doesn't use the official update feed.

- Build the fork's installer: `pnpm app:build:local-patched`
- Pull in upstream changes and keep the local fixes: `pnpm app:update:local-fixes` (checks only by default; it never pushes unless you pass `--push`)

How updates and protected branches work is in [gg-app/LOCAL_FIXES.md](gg-app/LOCAL_FIXES.md).

## Build with the framework

Want the engine without the desktop app? Use the same packages in your own apps. Install just what you need.

- [**@kenkaiiii/gg-ai**](packages/gg-ai/README.md): Connect to AI providers and stream responses.
- [**@kenkaiiii/gg-agent**](packages/gg-agent/README.md): Build agents that use your tools and work through tasks.
- [**@kenkaiiii/gg-core**](packages/gg-core/README.md): Model selection, authentication, and local model discovery.
- [**@kenkaiiii/ggcoder**](packages/ggcoder/README.md): The coding agent, sessions, and tools behind the app and CLI.

For your own agent, start here:

```bash
npm install @kenkaiiii/gg-ai @kenkaiiii/gg-agent
```

The package links above cover setup and usage. MIT licensed, so you can build on it.

## Learn with me

Come build with me in my [Skool community](https://skool.com/kenkai). Get help, share what you're making, and learn how to get more out of AI.
