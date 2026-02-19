# Idle Hands

Local-first coding agent CLI for OpenAI-compatible endpoints.

📖 Full documentation at [https://visorcraft.github.io/IdleHands/](https://visorcraft.github.io/IdleHands/)

## Key features

- Fullscreen TUI by default for TTY sessions (`--no-tui` for classic mode)
- Runtime orchestration across hosts, backends, and models
- Trifecta subsystem: Vault memory, Replay checkpoints, Lens indexing
- Approval modes (`plan`, `reject`, `default`, `auto-edit`, `yolo`) + safety tiers
- `--non-interactive` mode for CI/pipelines (rejects unconfirmed operations)
- Telegram and Discord bot frontends with systemd user service support
- Headless/CI output modes (`json`, `stream-json`)

## Install

```bash
npm i -g @visorcraft/idlehands
idlehands --help
```

## Quick start

```bash
idlehands setup
idlehands
idlehands -p "run npm test and fix failures"
```
