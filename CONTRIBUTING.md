# Contributing

Thanks for your interest in Orchords Web Pilot.

## Workflow

1. Open an issue describing the change (unless it's an obvious typo).
2. Fork the repo, create a branch from `main`.
3. Make your change. Run `npm run lint && npm test`.
4. Open a PR. The CI will run on the `main-verification` runner for trusted
   branches and on `ubuntu-24.04` for fork PRs.

## Style

- TypeScript, strict mode, ES modules.
- Prettier + ESLint configs in the repo.
- File naming: `kebab-case.ts`.

## Commit messages

Conventional commits are encouraged:

```
feat(browser): add browser_tabs tool
fix(http): bind to 127.0.0.1 by default
docs(readme): document BROWSER_WS_ENDPOINT
```

## Adding a new tool

1. Add a Zod schema in `src/tools/<name>.ts`.
2. Register it in `src/server.ts`.
3. Add a README row in the tools table.
4. Add a smoke test in `test/`.
