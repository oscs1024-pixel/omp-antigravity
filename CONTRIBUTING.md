# Contributing

Thanks for improving `omp-antigravity`.

## Before opening an issue

- Search existing issues first.
- Do not report security vulnerabilities in public issues; follow [SECURITY.md](SECURITY.md).
- Include the OMP version (`omp --version`), plugin version, operating system, selected model, and sanitized `/antigravity.doctor` output when reporting a bug.

## Development setup

```bash
bun install
bun run check
```

This repo uses [Bun](https://bun.sh). `bun run check` runs TypeScript, ESLint, Prettier, the repository security checks, and the test scripts. Run it before opening a pull request.

The test scripts run on a plain Bun host rather than inside OMP, so they resolve OMP-only host symbols (such as the legacy `calculateCost` shim) defensively and skip those assertions when the symbol is absent. Prefer that pattern over importing an OMP-only symbol by name: a named import of a shim-only export fails the whole module outside OMP.

## Pull requests

1. Fork the repository and create a focused branch.
2. Keep changes small and explain their user impact.
3. Add or update tests when behavior changes.
4. Update documentation when commands, authentication, configuration, or models change.
5. Ensure `bun run check` passes.

Do not include credentials, access tokens, refresh tokens, OAuth client secrets, or private account data in commits, issues, pull requests, or logs.

## Releases

Maintainers publish releases by pushing a version tag (`vX.Y.Z`). Contributors must not publish the package or modify release credentials.
