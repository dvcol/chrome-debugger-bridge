# Releasing CDB packages

CDB publishes its eight public packages on one synchronized version. A manually dispatched GitHub workflow creates the version commit and tag, publishes the immutable tagged commit, and then creates one GitHub Release.

## Responsibilities

- `release.yml` runs Bumpp, verifies the complete repository, pushes the generated commit and annotated tag, calls `publish.yml`, and creates the GitHub Release only after publication succeeds.
- `publish.yml` is called by `release.yml`. It checks out the exact tag and publishes every public package with npm trusted publishing and provenance.
- pnpm transforms `workspace:` and `catalog:` dependency specifiers in packed and published manifests.

Turbo owns the validation dependency graph, including package builds required by root browser and packaging checks. `pnpm run pack` asks Turbo to build and pack each public package. Each package runs `pnpm pack --out artifacts/package.tgz` against its `tsdown` output in `dist/`. The fixed, ignored tarball path avoids a cleanup script and lets Turbo restore each package's archive from cache.

## Validation commands

| Command | Purpose |
| --- | --- |
| `pnpm check` | Public package boundaries, generated CDP catalogue freshness, lint, Knip, type checks, and unit tests. |
| `pnpm check:boundaries` | Runs `turbo boundaries` on `packages/*` to check declared imports and package isolation. |
| `pnpm verify` | Everything in `check`, browser tests, extension E2E, and publint. |
| `pnpm check:package` | Builds packages and checks their metadata and exports with publint. Used before publication. |

The root `check`, `typecheck`, and `verify` wrappers each invoke one dependency-only `//#…:all` target in `turbo.json`. These targets have no shell command. Their names differ from the wrappers to avoid invoking Turbo recursively. Package tasks declare their own dependencies: `pack` and `check:package` wait for `build`. pnpm owns packing and publishing; publint checks CDB package metadata and exports.

ESLint owns catalogue rules and rejects Node imports in browser code, including dynamic imports and imports of CDB's Node adapters. Turbo checks isolation of the public packages. Runnable examples may compose each other's source; the package-boundary command is scoped to `packages/*`.

## Repository setup checkpoint

Before running a release, create two protected GitHub environments in [the repository settings](https://github.com/dvcol/chrome-debugger-bridge/settings/environments):

1. Create a short-lived fine-grained GitHub personal access token owned by `dvcol`, restricted to `chrome-debugger-bridge`, with `Contents: Read and write`, and save it as the repository Actions secret `CI_TOKEN`.
2. Create the `github` environment and restrict it to `main` so release commit and GitHub Release jobs remain protected.
3. Create the `npm` environment, restrict it to `main`, and add reviewers if required. This environment has no permanent npm token.

`CI_TOKEN` only pushes the release commit and tag. npm publication authenticates independently through GitHub OIDC. Each npm package trusts `release.yml` in `dvcol/chrome-debugger-bridge`, restricted to the `npm` environment. npm matches the calling workflow when it invokes a reusable publishing workflow.

## Normal release

Manually run `release.yml` from `main` and enter an explicit semantic version. The first release is `0.1.0`. Bumpp updates the configured manifests, runs `pnpm verify`, and creates the commit and tag. Git rejects existing tags and an outdated push to `main`; the commit and tag are pushed atomically. Maintainers choose the next version.

If npm publication fails after the release commit and tag were pushed, use GitHub Actions **Re-run failed jobs** on the release run. Recursive pnpm publication skips package versions already present and continues the incomplete release. The dependent GitHub Release job runs only after publication succeeds.
