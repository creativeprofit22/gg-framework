# GG Framework

<p align="center">
  <strong>Modular TypeScript framework for building LLM-powered apps. From raw streaming to full coding agent.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kenkaiiii/ggcoder"><img src="https://img.shields.io/npm/v/@kenkaiiii/ggcoder?style=for-the-badge&label=ggcoder" alt="ggcoder npm version"></a>
  <a href="https://www.npmjs.com/package/@kenkaiiii/gg-boss"><img src="https://img.shields.io/npm/v/@kenkaiiii/gg-boss?style=for-the-badge&label=gg-boss" alt="gg-boss npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://youtube.com/@kenkaidoesai"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://skool.com/kenkai"><img src="https://img.shields.io/badge/Skool-Community-7C3AED?style=for-the-badge" alt="Skool"></a>
</p>

Four packages. Each one works on its own. Stack them together and you get a full coding agent — or an orchestrator that drives many of them at once.

| Package                                                                    | What it does                                                | README                                           |
| -------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| [`@kenkaiiii/gg-ai`](https://www.npmjs.com/package/@kenkaiiii/gg-ai)       | Unified LLM streaming API across four providers             | [packages/gg-ai](packages/gg-ai/README.md)       |
| [`@kenkaiiii/gg-agent`](https://www.npmjs.com/package/@kenkaiiii/gg-agent) | Agent loop with multi-turn tool execution                   | [packages/gg-agent](packages/gg-agent/README.md) |
| [`@kenkaiiii/ggcoder`](https://www.npmjs.com/package/@kenkaiiii/ggcoder)   | CLI coding agent with OAuth, tools, and TUI                 | [packages/ggcoder](packages/ggcoder/README.md)   |
| [`@kenkaiiii/gg-boss`](https://www.npmjs.com/package/@kenkaiiii/gg-boss)   | Orchestrator that drives many ggcoder workers from one chat | [packages/gg-boss](packages/gg-boss/README.md)   |

```
@kenkaiiii/gg-ai (standalone)
  └─► @kenkaiiii/gg-agent (depends on gg-ai)
        └─► @kenkaiiii/ggcoder (depends on both)
              └─► @kenkaiiii/gg-boss (orchestrates many ggcoder workers)
```

---

## Which package do I need?

| You want to...                                                  | Use                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------- |
| Stream LLM responses across providers with one API              | [`@kenkaiiii/gg-ai`](packages/gg-ai/README.md)       |
| Build an agent that calls tools and loops autonomously          | [`@kenkaiiii/gg-agent`](packages/gg-agent/README.md) |
| Use a ready-made CLI coding agent                               | [`@kenkaiiii/ggcoder`](packages/ggcoder/README.md)   |
| Drive many coding agents across multiple projects from one chat | [`@kenkaiiii/gg-boss`](packages/gg-boss/README.md)   |

Each package works on its own. Install only what you need.

```bash
npm i @kenkaiiii/gg-ai          # Just the streaming layer
npm i @kenkaiiii/gg-agent       # Streaming + agent loop
npm i -g @kenkaiiii/ggcoder     # The full CLI coding agent
npm i -g @kenkaiiii/gg-boss     # Multi-project orchestrator
```

---

## For developers

```bash
git clone https://github.com/KenKaiii/gg-framework.git
cd gg-framework
pnpm install
pnpm build
```

TypeScript 6.0 + pnpm workspaces + Ink 6.8/7.0 + React 19 + Vitest 4 + Zod v4

---

## Community

- [YouTube @kenkaidoesai](https://youtube.com/@kenkaidoesai) - tutorials and demos
- [Skool community](https://skool.com/kenkai) - come hang out

---

## License

MIT

---

<p align="center">
  <strong>Less bloat. More coding. Four providers. Four packages. One framework.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kenkaiiii/ggcoder"><img src="https://img.shields.io/badge/Install-npm%20i%20--g%20%40kenkaiiii%2Fggcoder-blue?style=for-the-badge" alt="Install ggcoder"></a>
  <a href="https://www.npmjs.com/package/@kenkaiiii/gg-boss"><img src="https://img.shields.io/badge/Orchestrate-npm%20i%20--g%20%40kenkaiiii%2Fgg--boss-7C3AED?style=for-the-badge" alt="Install gg-boss"></a>
</p>
