---
layout: home

hero:
  name: "Idle Hands"
  text: "Local-first coding agent CLI"
  tagline: "TUI-first coding workflow for OpenAI-compatible endpoints"
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Command Reference
      link: /reference/commands
    - theme: alt
      text: GitHub
      link: https://github.com/visorcraft/idlehands

features:
  - title: Fullscreen TUI by default
    details: Deterministic layout, streaming output, slash commands, tool timeline, and keyboard-driven editing.
  - title: Runtime orchestration
    details: Manage hosts, backends, and models; launch and probe servers; derive active endpoint automatically.
  - title: Trifecta subsystem
    details: Vault memory, Replay checkpoints, and Lens indexing in one integrated system.
  - title: Safety + approvals
    details: Approval modes and safety tiers are independent, with optional lockdown for strict environments.
  - title: Bot frontends
    details: Telegram and Discord support with optional systemd user service management.
  - title: Headless / CI ready
    details: JSON and NDJSON output modes with fail-on-error and diff-only options.
---

## Quick install

```bash
npm i -g https://github.com/visorcraft/idlehands/releases/download/v0.6.1/idlehands-0.6.1.tgz
idlehands --help
```

::: tip First run
If no config exists, running `idlehands` launches setup automatically.
:::

## Quick start

```bash
idlehands setup
idlehands
idlehands -p "run npm test and fix failures"
```
