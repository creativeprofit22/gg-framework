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

GG Coder is a desktop AI app that helps you write code, chat, and make videos. Ken Autopilot checks the coding work, chat remembers context, and GG Motion creates videos from your ideas. Pick your AI provider, open as many windows as you need, and tell it what you want to do. Less babysitting, more getting things done.

## Get started

1. Install GG Coder:

   **macOS (Apple Silicon):** [Download the latest release](https://github.com/KenKaiii/gg-framework/releases/latest) and open the `.dmg`.

   **Windows:** [Download the latest release](https://github.com/KenKaiii/gg-framework/releases/latest) and run the `.exe` installer.

   **Development:** With Node.js, pnpm, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) installed:

   ```bash
   git clone https://github.com/KenKaiii/gg-framework.git
   cd gg-framework
   pnpm install
   pnpm build
   pnpm --filter gg-app tauri dev
   ```

2. Open the app, connect your AI provider, and pick Code, Chat, or Motion.

## Build with the framework

Want the engine without the desktop app? Use the same packages in your own apps. Install just what you need.

- [**@kenkaiiii/gg-ai**](packages/gg-ai/README.md): Connect to AI providers and stream responses.
- [**@kenkaiiii/gg-agent**](packages/gg-agent/README.md): Build agents that use your tools and work through tasks.
- [**@kenkaiiii/gg-core**](https://www.npmjs.com/package/@kenkaiiii/gg-core): Model selection, authentication, and local model discovery.
- [**@kenkaiiii/ggcoder**](packages/ggcoder/README.md): The coding agent, sessions, and tools behind the app and CLI.

For your own agent, start here:

```bash
npm install @kenkaiiii/gg-ai @kenkaiiii/gg-agent
```

The package links above cover setup and usage. MIT licensed, so you can build on it.

## Learn with me

Come build with me in my [Skool community](https://skool.com/kenkai). Get help, share what you're making, and learn how to get more out of AI.
