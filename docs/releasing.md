# Releasing CDB packages

CDB publishes its six public packages on one synchronized version. A manually dispatched GitHub workflow creates the version commit and tag, publishes the immutable tagged commit, and then creates one GitHub Release.

## Responsibilities

- `release.yml` validates the requested version, runs Bumpp, verifies the complete repository, pushes the generated commit and annotated tag, dispatches `publish.yml`, and waits for it before creating the GitHub Release.
- `publish.yml` runs as a standalone workflow, checks out that exact tag, and publishes every public package with npm trusted publishing and provenance. Keeping it standalone ensures npm validates `publish.yml` as the trusted workflow identity.
- `bootstrap-publish.yml` exists only to create the initially unpublished package names. Remove it after trusted publishing is configured.
- pnpm transforms `workspace:` and `catalog:` dependency specifiers in packed and published manifests. The packed-consumer verification rejects either protocol if it escapes.

## Repository setup checkpoint

Before running a release, create two protected GitHub environments in [the repository settings](https://github.com/dvcol/chrome-debugger-bridge/settings/environments):

1. Create a short-lived fine-grained GitHub personal access token owned by `dvcol`, restricted to `chrome-debugger-bridge`, with `Contents: Read and write`, and save it as the repository Actions secret `CI_TOKEN`.
2. Create the `github` environment and restrict it to `main` so release commit and GitHub Release jobs remain protected.
3. Create the `npm` environment, restrict it to `main`, and add reviewers if required. This environment has no permanent npm token.

`CI_TOKEN` only pushes the release commit and tag. npm publication authenticates independently through GitHub OIDC.

## Initial npm bootstrap

[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) can only be configured after a package exists. For the initial `0.0.0` publication:

1. Create a granular npm token restricted to the `@dvcol` scope, with read/write package access, CI-compatible 2FA bypass, and approximately one-day expiry.
2. Save it temporarily as `NPM_BOOTSTRAP_TOKEN` in the GitHub `npm` environment.
3. Manually run `bootstrap-publish.yml` from `main` with the confirmation value requested by the workflow. It verifies the repository and publishes all six packages under the `bootstrap` dist-tag with provenance.
4. For each package, open **Package Settings → Trusted Publisher**, select **GitHub Actions**, and configure:
   - Organization or user: `dvcol`
   - Repository: `chrome-debugger-bridge`
   - Workflow filename: `publish.yml`
   - Environment: `npm`
5. Revoke the npm bootstrap token, delete `NPM_BOOTSTRAP_TOKEN`, and remove `bootstrap-publish.yml` in a follow-up commit.

## Normal release

Manually run `release.yml` from `main` and enter an explicit semantic version. The first release is `0.1.0`. The workflow rejects stale `main`, non-increasing versions, conflicting tags, unexpected release-commit changes, and incomplete validation.

If npm publication fails after the release commit and tag were pushed, rerun `publish.yml` with the exact tag and commit. Recursive pnpm publication skips package versions already present and continues the incomplete release. GitHub Release creation occurs only after publication succeeds.
