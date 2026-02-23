# Getting Started

## Requirements

- Node.js **24+**
- Linux (recommended target environment)

## Install (npm)

```bash
npm i -g @visorcraft/idlehands@latest
idlehands --help
```

## Build from source

```bash
git clone https://github.com/visorcraft/idlehands.git
cd idlehands
npm i
npm run build
node dist/index.js --help
```

## Quick start

```bash
# setup wizard
idlehands setup

# interactive session
idlehands

# one-shot task
idlehands -p "run npm test and fix failures"

# point at a specific project
idlehands --dir ~/projects/myapp
```

Common resume/fresh patterns:

```bash
idlehands --continue
idlehands --resume
idlehands --resume my-session
idlehands --fresh
```

---

## Recommended Linux hardening

Use a dedicated low-privilege account for production usage.

```bash
sudo useradd --system --create-home --home-dir /home/idlehands --shell /bin/bash idlehands
sudo passwd -l idlehands
sudo mkdir -p /home/idlehands/work
sudo chown -R idlehands:idlehands /home/idlehands
```

Run Idle Hands as that user:

```bash
sudo -u idlehands -H bash -lc 'idlehands setup'
sudo -u idlehands -H bash -lc 'idlehands --dir /home/idlehands/work'
```

This limits access scope and reduces blast radius.

---

## Running bots as a service

Idle Hands includes service management for bot frontends:

```bash
idlehands service install
idlehands service start
idlehands service status
idlehands service logs
```

If you want user services to continue after logout:

```bash
sudo loginctl enable-linger <user>
```

If using dedicated account `idlehands`, manage the service while logged in as that user.

---

## Next steps

- [Setup Wizard](/guide/setup-wizard)
- [Trifecta](/guide/trifecta)
- [Bots](/guide/bots)
- [Runtime Orchestration](/guide/runtime)
- [CLI Reference](/reference/cli)
