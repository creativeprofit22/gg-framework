# Security policy

GG Coder stores provider API keys and OAuth tokens on your machine (`~/.gg/auth.json`) and runs a local agent daemon that can read files and execute commands. Security reports are taken seriously.

## Supported versions

Only the latest release gets security fixes:

- the desktop app: [latest GitHub release](https://github.com/KenKaiii/gg-framework/releases/latest)
- the npm packages (`@kenkaiiii/gg-ai`, `gg-agent`, `gg-core`, `ggcoder`): latest published version

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through [GitHub security advisories](https://github.com/KenKaiii/gg-framework/security/advisories/new).

Include:

- what an attacker can do, and what they need first (e.g. "a malicious web page", "a repo the user opens", "local access")
- steps to reproduce, or a proof of concept
- affected version and OS

You'll get an acknowledgement within 7 days. Once a fix ships, the advisory will be published with credit to you unless you'd rather stay anonymous.

## In scope

- the local daemon (`app-sidecar`): auth token, host allowlist, session isolation
- credential storage and OAuth flows
- the Tauri shell and its commands
- agent tools escaping their intended sandbox or approval rules

## Out of scope

- an AI model choosing to run a command you approved, or that your settings allow without approval
- attacks that need an already-compromised user account or machine
