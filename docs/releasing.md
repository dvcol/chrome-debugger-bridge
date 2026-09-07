# Releasing CDB packages

CDB publishes its six public packages on one synchronized version. A manually dispatched GitHub workflow creates the version commit and tag, publishes the immutable tagged commit, and then creates one GitHub Release.

## Responsibilities

- `release.yml` validates the requested version, runs Bumpp, verifies the complete repository, pushes the generated commit and annotated tag, calls `publish.yml`, and creates the GitHub Release only after publication succeeds.
- `publish.yml` is both reusable and manually dispatchable. It checks out the exact tag and publishes every public package with npm trusted publishing and provenance.
- pnpm transforms `workspace:` and `catalog:` dependency specifiers in packed and published manifests. The packed-consumer verification rejects either protocol if it escapes.

Turbo owns the validation dependency graph, including package builds required by root browser and packaging checks. `tsdown` produces each package's `dist/` output. `pnpm pack` then verifies the separate npm artifact boundary: exports, included files, rewritten dependency protocols, licenses, READMEs, and installation by fresh consumers.

## Repository setup checkpoint

Before running a release, create two protected GitHub environments in [the repository settings](https://github.com/dvcol/chrome-debugger-bridge/settings/environments):

1. Create a short-lived fine-grained GitHub personal access token owned by `dvcol`, restricted to `chrome-debugger-bridge`, with `Contents: Read and write`, and save it as the repository Actions secret `CI_TOKEN`.
2. Create the `github` environment and restrict it to `main` so release commit and GitHub Release jobs remain protected.
3. Create the `npm` environment, restrict it to `main`, and add reviewers if required. This environment has no permanent npm token.

`CI_TOKEN` only pushes the release commit and tag. npm publication authenticates independently through GitHub OIDC.

## Normal release

Manually run `release.yml` from `main` and enter an explicit semantic version. The first release is `0.1.0`. The workflow rejects stale `main`, non-increasing versions, conflicting tags, unexpected release-commit changes, and incomplete validation.

If npm publication fails after the release commit and tag were pushed, rerun `publish.yml` with the exact tag and commit. Recursive pnpm publication skips package versions already present and continues the incomplete release. GitHub Release creation occurs only after publication succeeds.
