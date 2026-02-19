# Getting Started

## Requirements

- Node.js **24+**
- Linux

## Install (release tarball)

```bash
npm i -g https://github.com/visorcraft/idlehands/releases/download/v0.6.1/idlehands-0.6.1.tgz
idlehands --help
```

## Build from source

```bash
git clone https://github.com/visorcraft/idlehands.git
cd idlehands
npm i
npm run build
./dist/index.js --help
```

## Offline / air-gapped

```bash
# install from copied tarball
npm i -g ./idlehands-0.6.1.tgz

# disable internet-dependent internal checks
idlehands --offline
```

## Quick start

```bash
# interactive session
idlehands

# one-shot task
idlehands -p "run npm test and fix failures"

# point at a specific project
idlehands --dir ~/projects/myapp
```

Common resume patterns:

```bash
idlehands --continue
idlehands --resume
idlehands --resume my-session
idlehands --fresh
idlehands --endpoint http://127.0.0.1:8080/v1
```
