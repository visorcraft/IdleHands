# Safety Architecture

Safety and approval are separate controls.

## Approval modes

| Mode | Reads | File edits | Shell commands | Typical use |
|---|---|---|---|---|
| `plan` | auto | blocked (recorded as plan) | blocked (recorded) | Planning/review |
| `default` | auto | confirm | confirm | Safe default |
| `auto-edit` | auto | auto | confirm | Daily coding |
| `yolo` | auto | auto | auto | Trusted automation/CI |

Controls:
- CLI: `--plan`, `--step`, `--no-confirm`/`--yolo`, `--approval-mode`
- Session: `/approval`, `/plan`, `/step`
- Keyboard (TTY): `Shift+Tab` cycles approval mode

## Safety tiers

- **Forbidden**: always blocked (including `yolo`)
- **Cautious**: requires confirmation unless mode auto-approves
- **Free**: normal execution

`--lockdown` promotes cautious operations to forbidden.

## Policy sources

- Built-ins: `src/safety.ts`
- User overrides: `~/.config/idlehands/safety.json`

::: warning
`yolo` does not bypass forbidden safety patterns.
:::
