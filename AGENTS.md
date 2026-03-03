# Repository Guidelines

## Project Structure & Module Organization

Core runtime code lives in `src/` (agents, gateway, channels, CLI, providers, and shared infra). Channel/plugin packages are under `extensions/*` and ship as workspace packages with their own `package.json`. The Control UI is in `ui/` (Vite + Vitest). Shared tests, fixtures, and helper scripts are in `test/`. Documentation is in `docs/`, including localized trees (`docs/ja-JP`, `docs/zh-CN`). Automation and release utilities live in `scripts/`. Build output is generated in `dist/`.

## Build, Test, and Development Commands

- `pnpm install`: install workspace dependencies (pnpm 10.x).
- `pnpm dev`: run the main Node runtime in dev mode.
- `pnpm gateway:dev`: run gateway-only dev flow (channels skipped).
- `pnpm ui:dev`: start the Control UI dev server.
- `pnpm build`: compile TypeScript and generate distributable artifacts.
- `pnpm test` or `pnpm test:fast`: run full parallel tests or fast unit-focused tests.
- `pnpm test:e2e` / `pnpm test:live`: run e2e or live-environment suites.
- `pnpm check`: run formatter, linter, and policy checks used in CI.

## Coding Style & Naming Conventions

TypeScript is `strict` (`tsconfig.json`) and uses NodeNext modules. Formatting is enforced by `oxfmt` (`2` spaces, no tabs, sorted imports). Linting is enforced by `oxlint --type-aware`; `typescript/no-explicit-any` is an error. Use:

- `camelCase` for variables/functions
- `PascalCase` for classes/types
- descriptive kebab/dot-style filenames (for example `gateway.multi.e2e.test.ts`)

Run `pnpm format` and `pnpm lint` before opening a PR.

## Testing Guidelines

Vitest is the primary framework (`vitest*.config.ts`). Default test files use `*.test.ts`; specialized suites use `*.e2e.test.ts` and `*.live.test.ts`. Coverage is tracked with V8 (`pnpm test:coverage`) and currently targets: lines/functions/statements `70%`, branches `55%` for covered core `src/**` files. Keep fixtures in `test/fixtures` and colocate unit tests with source files when practical.

## Commit & Pull Request Guidelines

Recent history follows conventional prefixes such as `feat(anton): ...`, `fix(reply): ...`, `docs: ...`, and `chore(release): ...`. Use imperative, scoped subjects when helpful. For PRs, include:

- a concise problem/solution summary
- linked issue(s) or task IDs
- exact verification commands run (for example `pnpm check && pnpm test:ci:pr`)
- screenshots/video for `ui/` changes

## Security & Configuration Tips

Start from `.env.example`; never commit real secrets. Secret scanning is enforced with `detect-secrets` and pre-commit hooks. Prefer `pnpm audit --prod --audit-level=high` when updating dependencies.
