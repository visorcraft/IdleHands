# Headless / CI Usage

Use one-shot mode when you need deterministic automation.

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

## Recommended CI flags

- `--fail-on-error`
- `--diff-only` (emit patch and restore clean tree)
- `--approval-mode yolo` (or `--no-confirm`) for fully non-interactive runs
- `--offline` when internet checks are undesirable in CI

## Example CI-style command

```bash
idlehands --one-shot \
  --output-format json \
  --fail-on-error \
  --approval-mode yolo \
  -p "run npm test and fix straightforward failures"
```

::: tip
Prefer machine-readable outputs (`json` / `stream-json`) and assert on structured fields instead of parsing plain text.
:::
