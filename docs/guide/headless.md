# Headless / CI Usage

Use one-shot prompts with machine-readable output formats.

## JSON output

```bash
idlehands -p "run tests and fix failures" --output-format json > result.json
jq -e '.[-1].ok' result.json
```

## NDJSON stream output

```bash
idlehands -p "fix lint" --output-format stream-json
```

## Stdin prompt input

```bash
cat src/file.ts | idlehands -p "review this" --output-format json
```

## Useful flags

- `--fail-on-error`
- `--diff-only`
- `--approval-mode yolo` (or `--no-confirm`)

::: tip CI pattern
Use `--fail-on-error` and parse JSON/stream-json output for deterministic CI gating.
:::
