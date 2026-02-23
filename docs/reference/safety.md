# Safety Architecture

Idle Hands separates **approval policy** from **hard safety enforcement**.

- Approval mode controls when the agent asks before acting.
- Safety tiers control what is always blocked vs. conditionally allowed.

## Approval modes

| Mode | Reads | File edits | Shell commands | Typical use |
|---|---|---|---|---|
| `plan` | auto | blocked (planned only) | blocked (planned only) | Planning/review |
| `reject` | auto | blocked | blocked | Non-interactive safe mode |
| `default` | auto | confirm | confirm | Conservative daily use |
| `auto-edit` | auto | auto | confirm | Normal coding workflow |
| `yolo` | auto | auto | auto | Trusted automation |

Controls:

- CLI: `--plan`, `--step`, `--approval-mode`, `--no-confirm` / `--yolo`, `--lockdown`
- Session: `/approval`, `/plan`, `/step`
- TTY shortcut: `Shift+Tab` cycles approval mode

## Safety tiers

- **Forbidden**: always blocked (including in `yolo`)
- **Cautious**: requires confirmation unless mode auto-approves
- **Free**: executes normally

`--lockdown` promotes cautious operations to forbidden.

## Policy sources

- built-in rules: `src/safety.ts`
- local overrides: `~/.config/idlehands/safety.json`

## Practical guidance

- Use `default` or `auto-edit` for most interactive development.
- Use `reject` for CI/headless validation pipelines.
- Use `yolo` only in trusted repos/environments.

::: warning
`yolo` does **not** bypass forbidden safety patterns.
:::
