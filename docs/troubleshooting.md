# Runtime Orchestration Troubleshooting

This guide covers common runtime orchestration failures and fast diagnostics.

## 1) "Lock held by another process"

You attempted `idlehands select --model ...` while another orchestration run is active.

### Why it happens

- Another CLI session is switching runtimes
- A prior run crashed and left a stale lock

### What to do

1. Retry after a short wait.
2. If lock is stale (owner PID no longer exists), reclaim/force takeover.
3. If lock is active and legitimate, wait or cancel.

### Helpful commands

```bash
idlehands select status
idlehands hosts doctor
```

If needed, inspect and remove stale lock manually only when you have confirmed the PID is dead.

---

## 2) "Host unreachable"

SSH host cannot be contacted or authenticated.

### Checklist

- Confirm `hosts[].connection.host`, `port`, and `user`
- Verify `key_path` exists and permissions are correct
- Test direct SSH outside Idle Hands
- Check firewall / LAN routing

### Commands

```bash
idlehands hosts validate
idlehands hosts test <host-id>
idlehands hosts doctor
```

If direct SSH fails, fix network/auth first; orchestration will not succeed until transport is stable.

---

## 3) "Model not found"

The requested model ID does not exist or is disabled.

### Checklist

- Ensure `models[].id` matches exactly
- Confirm `models[].enabled` is `true`
- Confirm the selected model’s `host_policy` and `backend_policy` are satisfiable

### Commands

```bash
idlehands models
idlehands models show <model-id>
idlehands hosts validate
```

Also verify command usage:

```bash
idlehands select --model <model-id>
```

---

## 4) "Backend verification failed"

`backends[].verify_cmd` returned failure, or backend setup did not apply correctly.

### Common causes

- Missing driver/runtime packages (CUDA/ROCm/Vulkan tools)
- Wrong backend selected for target host
- Missing backend binary in `$PATH`

### What to check

- Backend/host cross-reference (`host_filters`)
- Host capability declaration (`hosts[].capabilities.backends`)
- Verification command correctness

### Commands

```bash
idlehands backends show <backend-id>
idlehands hosts test <host-id>
idlehands hosts doctor
```

---

## 5) "Health probe timeout"

Model start command ran, but `launch.probe_cmd` never became healthy before timeout.

### Common causes

- Port already in use
- Runtime takes longer than `probe_timeout_sec`
- Model too large for available VRAM
- `probe_cmd` points to wrong host/port/path

### What to check

- `models[].launch.probe_cmd`
- `models[].runtime_defaults.port`
- host GPU memory/headroom

### Commands

```bash
idlehands select --model <id> --dry-run --json
idlehands hosts doctor
```

If startup is slow but valid, increase `probe_timeout_sec`.

---

## Diagnostic commands to know

## `idlehands hosts doctor`

Use this first for environment-level issues. Typical checks include:

- host reachability
- backend/tool availability
- command sanity checks

## `idlehands hosts validate`

Use this for config-level issues:

- schema correctness
- unknown keys
- bad IDs and duplicates
- invalid host/backend/model cross-references
- invalid template variables in `*_cmd` fields

---

## Fast triage workflow

```bash
# 1) Validate config integrity
idlehands hosts validate

# 2) Run environment diagnostics
idlehands hosts doctor

# 3) Inspect plan without side effects
idlehands select --model <id> --dry-run --json

# 4) Execute live switch
idlehands select --model <id>
```

If failures persist, capture the command output and relevant `runtimes.json` snippets (redact secrets) before escalating.
