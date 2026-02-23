# Trifecta (Vault + Replay + Lens)

Trifecta is Idle Hands' integrated memory + reversibility + structure layer.

It combines three subsystems:

- **Vault**: persistent memory and notes
- **Replay**: file-edit checkpoints for rewind/diff/undo
- **Lens**: structural projections to reduce context bloat

Used together, these make sessions more resilient and less lossy over time.

---

## 1) Vault

Vault is long-lived memory stored on disk.

What it does:

- Stores explicit notes (`/note`, `vault_note`)
- Supports semantic retrieval (`/vault`, `vault_search`)
- Archives compacted history/tool output so context can be dropped safely
- **Auto-persists turn action summaries** so the model can recall what it did in prior turns

Primary commands:

- `/vault <query>`
- `/notes`
- `/note <key> <value>`

### Automatic turn summaries

When the agent completes a turn that involved tool calls, a structured summary is automatically persisted to the Vault. This summary includes:

- What the user asked (truncated for efficiency)
- Every tool action taken (e.g. `run: npx eslint --fix`, `edit src/app.ts lines 10-20`)
- The assistant's final response

This means the model can use `vault_search` to recall its own prior actions - even after context compaction has dropped the original messages. This is especially valuable for local models with limited context windows, where earlier turns are often lost.

Turn summaries are stored with `system` kind and keyed by ask ID, so they don't pollute user-created notes.

---

## 2) Replay

Replay captures file state before write/edit/insert operations so you can recover.

What it does:

- Creates checkpoints during mutating file tools
- Lets you inspect and rewind prior file states
- Supports focused rollback without nuking the whole repo

Primary commands:

- `/checkpoints`
- `/rewind <id>`
- `/diff <id>`
- `/undo [path]`

---

## 3) Lens

Lens creates structural views of files (instead of full raw text) to improve context efficiency.

What it does:

- Builds skeleton-style projections for code and structured text
- Helps summarization/indexing avoid token blowups
- Improves quality when large files must be reasoned about repeatedly

You usually don't call Lens directly; it works behind the scenes and in synergy with Vault/Replay.

---

## How the three work together

- **Lens → Vault**: stores compressed structural memory instead of giant blobs
- **Replay → Vault**: failed/aborted branches can still become searchable knowledge
- **Lens + Replay**: diffs and recovery stay actionable even in large files
- **Turn summaries → Vault**: every tool-using turn is automatically logged, making the agent self-aware of its own history

This is the core differentiator of Idle Hands vs simple "chat + tools" shells.

---

## Configuration

### CLI flags

```bash
--no-trifecta
--no-vault
--no-lens
--no-replay
--vault-mode active|passive|off
```

### Config file (`~/.config/idlehands/config.json`)

```json
{
  "trifecta": {
    "enabled": true,
    "vault": { "enabled": true, "mode": "active" },
    "lens": { "enabled": true },
    "replay": { "enabled": true }
  }
}
```

---

## Vault modes

- `active`: Vault tools are available to the model directly.
- `passive`: Vault injects relevant memory automatically when useful.
- `off`: Vault disabled entirely.

Recommended defaults:

- Daily coding workflow: `active`
- Conservative/low-noise workflow: `passive`
- Minimal footprint runs: `off`

---

## Operational notes

- Trifecta is designed to degrade gracefully: if one subsystem fails, session execution continues.
- Disable subsystems selectively for debugging (`--no-vault`, `--no-lens`, `--no-replay`).
- For CI/headless runs, keep Replay on when you care about deterministic rollback trails.
