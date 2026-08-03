# Publishing research: Lerna, Lerna-Lite, and Changesets

**Prepared:** 2026-08-03
**Scope:** pnpm workspace, Turbo task orchestration, fixed-version packages, mandatory `catalog:` and `workspace:` dependency protocols, npm trusted publishing.

## Recommendation

Use **Lerna-Lite's modular version/publish flow** and keep Turbo as the only task graph/orchestration layer.

Install only `@lerna-lite/cli` and `@lerna-lite/publish`; the publish package supplies the version command dependency. Do not install Lerna-Lite's run/watch/exec commands. Turbo remains solely responsible for tasks and caching.

This corrects the earlier Lerna-only conclusion. Full Lerna still overlaps with Turbo through Nx and documents that it always publishes through npm. Lerna-Lite is modular, has no Nx dependency, and implements its own publication-manifest transformation for both named `catalog:` and `workspace:` protocols before calling npm's publishing API. It also supports fixed mode, Conventional Commits changelogs, GitHub releases, dry runs, provenance, and OIDC trusted publishing.

Lerna-Lite also matches the existing dvcol release style more closely: release intent is derived from Conventional Commits rather than requiring a new changeset file in every release-bearing pull request. Changesets remains a valid alternative if reviewed per-PR release intent and an automated release PR become more important than alignment with that workflow.

## Decision matrix

| Criterion | Lerna 10 | Lerna-Lite publish/version | Changesets |
|---|---|---|---|
| Fixed release train | Supported; keeping every package synchronized requires force-publishing unchanged packages. | Supported; use fixed mode plus `--force-publish "*"` so all five manifests and registry packages remain synchronized. | Supported by listing the five exact public package names in one `fixed` group. |
| pnpm workspace discovery | Supported through `pnpm-workspace.yaml`. | Supported with `npmClient: "pnpm"` and explicit publishable package globs. | Supported; release planning understands workspace packages and internal dependency ranges. |
| `catalog:` publishing | Always uses npm and does not document Lerna-Lite's catalog transformation. | Explicitly reads default/named pnpm catalogs and replaces references in the temporary publication manifest. | Strong fit on Changesets 3, which detects pnpm and invokes `pnpm pack` / `pnpm publish`; that line is currently prerelease. |
| `workspace:` publishing | Supported. | Explicitly converts `workspace:*`, `workspace:~`, and `workspace:^` using the target workspace version. | Supported; pnpm performs the publication transformation on Changesets 3. |
| Turbo overlap | High because modern Lerna includes Nx. | None when only CLI and publish are installed; do not install run/watch/exec. | None. |
| Release input | Version selection or Conventional Commits. | Conventional Commits or explicit version selection. | Explicit changeset files committed with pull requests. |
| Changelogs/releases | Conventional Commits and release integration. | Conventional Commits, per-package/root changelogs, GitHub/GitLab releases, and dry runs. | Changelogs from reviewed changeset summaries and a first-party release-PR action. |
| Trusted publishing | Supported through npm. | OIDC trusted publishing and provenance are documented and tested by the project. | Documented first-party workflow. |
| Adoption risk | Adds the full Nx-backed tool. | Stable modular packages; verify its custom manifest transformation locally. | Native pnpm publish currently depends on Changesets 3/action 2 prereleases. |

## Required publication transformation

The repository requires:

- External dependencies in all workspace manifests to use `catalog:` (or a named `catalog:<name>`).
- Internal workspace dependencies to use `workspace:` ranges.

The publication path must replace both protocols with ordinary registry-compatible semver ranges. Native `pnpm pack`/`pnpm publish` is one correct implementation. Lerna-Lite provides another: it reads pnpm's catalogs, resolves workspace targets, creates a temporary transformed manifest/tarball, and then publishes through npm's API.

Therefore, using npm internally is not itself disqualifying. The acceptance condition is the resulting tarball, not the executable name. CI must validate both `pnpm pack` output and an end-to-end Lerna-Lite publication against a local registry, proving that no `catalog:` or `workspace:` reference escapes.

## Proposed Lerna-Lite setup

Install only the modular release packages, with their versions declared in the workspace's release-tooling catalog:

```json
{
  "devDependencies": {
    "@lerna-lite/cli": "catalog:release",
    "@lerna-lite/publish": "catalog:release",
    "conventional-changelog-conventionalcommits": "catalog:release"
  }
}
```

Use fixed mode and exclude private applications by selecting only `packages/*`:

```json
{
  "$schema": "node_modules/@lerna-lite/cli/schemas/lerna-schema.json",
  "version": "0.0.0",
  "npmClient": "pnpm",
  "packages": ["packages/*"],
  "changelogPreset": "conventionalcommits",
  "command": {
    "version": {
      "allowBranch": "main",
      "conventionalCommits": true,
      "message": "chore(release): %s"
    }
  }
}
```

Run version/publish with `--force-publish "*"`; fixed mode alone uses one global version for changed packages but does not necessarily republish an unchanged package. For a literal single version train, every public package must be bumped and published together.

Keep command flags visible in root scripts rather than hiding critical release behavior:

```json
{
  "scripts": {
    "release:preview": "lerna version --dry-run --force-publish \"*\" --yes",
    "release": "lerna publish --force-publish \"*\" --create-release github --yes",
    "release:retry": "lerna publish from-git --yes"
  }
}
```

The concrete CI command should also enable the chosen Conventional Commits preset through `lerna.json`, run only after the full Turbo/package verification graph, and receive the minimum GitHub/npm permissions needed for tagging, release creation, and OIDC publication.

## Dependency protocol enforcement

Use `pnpm-workspace.yaml` as the only dependency-version authority:

```yaml
packages:
  - packages/*
  - examples/*

catalogMode: strict
cleanupUnusedCatalogs: true
saveWorkspaceProtocol: true
disallowWorkspaceCycles: true

catalogs:
  build: {}
  devtools: {}
  protocol: {}
  runtime: {}
  release: {}
  testing: {}
  types: {}
```

Manifest policy:

- External `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies` use named `catalog:<name>` references.
- Published internal runtime, peer, and optional dependencies use `workspace:^`.
- Internal development-only dependencies use `workspace:*`.
- Literal dependency ranges in workspace `package.json` files are rejected.
- The root `packageManager`, `engines`, and package `version` fields are exempt because dependency protocols are not valid there.

Enable the pnpm integration exposed by `@dvcol/eslint-config` (through `@antfu/eslint-config`) with catalog detection forced on. Its `eslint-plugin-pnpm` rules provide the primary manifest-policy gate:

- `pnpm/json-enforce-catalog` rejects literal external versions and accepts `workspace:` for internal dependencies. Override its `fields` option so it checks `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies`, rather than only its first two default fields.
- `pnpm/json-valid-catalog` rejects missing or invalid catalog references.
- `pnpm/json-prefer-workspace-settings` keeps pnpm configuration out of `package.json`.
- `pnpm/yaml-no-duplicate-catalog-item` and `pnpm/yaml-no-unused-catalog-item` keep the catalog clean.

These rules do not distinguish an internal package from an external package or enforce this repository's `workspace:^` versus `workspace:*` convention. Keep a small, focused workspace-reference check for that remaining policy only, and run both ESLint and the focused check through Turbo. `catalogMode: strict` remains a pnpm-side guard for dependency additions, not the sole validation mechanism.

## Turbo and pnpm responsibilities

- **pnpm:** workspace membership, dependency installation, catalogs, workspace linking, and independent pack verification.
- **Turbo:** build, lint, workspace-policy, typecheck, test, end-to-end test, and package-verification task ordering/caching.
- **Lerna-Lite publish/version:** Conventional Commits release calculation, synchronized versioning, changelogs, tags, GitHub release creation, publication-manifest transformation, and registry publication.

Avoid full Lerna, `@lerna-lite/run`, Nx, or another parallel task graph.

## CI and release outline

### Pull requests

1. Install with `pnpm install --frozen-lockfile`.
2. Run `@dvcol/eslint-config` with its pnpm rules plus the focused internal-workspace reference check.
3. Run `turbo run lint typecheck test build`.
4. Pack every publishable package with pnpm.
5. Inspect tarball manifests to prove no `catalog:` or `workspace:` specifiers escaped.
6. Validate Conventional Commit messages used for release calculation.

### Main branch

1. Run the complete verification pipeline against `main`.
2. The release job receives `contents: write` and `id-token: write`; no test/build job receives publication authority.
3. Run the fixed-mode Lerna-Lite release with Conventional Commits and `--force-publish "*"`.
4. Lerna-Lite updates all public manifests/changelogs, creates the release commit/tag, transforms catalog/workspace references in temporary package manifests, and publishes in topological order.
5. Create the GitHub release and provenance, then verify every expected package/version from the registry.
6. Use `lerna publish from-git` or `from-package` for an idempotent retry after a partial registry/network failure.

Pin Actions to immutable commit SHAs in the final implementation, following the current dvcol workflow style where applicable.

## Monorepo setup baseline

Use Vite DevTools as the closest structural reference, adapted to this repository rather than copied verbatim:

- pnpm 11 workspace with named catalogs grouped by concern (`build`, `testing`, `types`, and runtime groups).
- Turbo as the root build/watch graph, with package-level `build` scripts and explicit `dependsOn: ["^build"]` only where dependency order matters.
- tsdown package configurations split by runtime target: neutral/browser exports separate from Node exports, declarations enabled for published libraries, and an IIFE entry only for the injected bootstrap script.
- Latest stable Vitest projects split across Node, jsdom, Playwright-backed Browser Mode, MV3 Chromium end-to-end orchestration, and packed-package consumer tests.
- TypeScript project references for workspace typechecking.
- GitHub Actions pinned to immutable commit SHAs, while retaining direct `pnpm` commands rather than adopting Vite DevTools' `@antfu/ni` command aliases.

Do not copy Vite DevTools' exceptions that weaken enforcement (`strictPeerDependencies: false`, broad hoisting, or ignored package-manifest linting) unless a concrete dependency forces one and it is documented.

## Lerna-Lite publication guard

Before enabling real publication:

1. Pin compatible stable `@lerna-lite/cli` and `@lerna-lite/publish` versions together through the release catalog.
2. Run a local-registry end-to-end test using the actual Lerna-Lite version/publish flow, not only `pnpm pack`.
3. Assert all five package versions advance together because `--force-publish "*"` is present.
4. Inspect registry tarballs and assert normal semver ranges with no `catalog:` or `workspace:` values.
5. Install the published packages into a clean consumer and verify internal resolution and every export.
6. Exercise failure/retry behavior so a partial publish can be resumed safely.

## When Changesets would be preferable

Choose Changesets instead if the repository later requires a release PR that accumulates explicit, reviewer-authored release notes from each feature pull request. In that model, wait for stable Changesets 3/action 2 or pin and validate the prereleases, because native pnpm publication is the relevant safe path. This is a workflow tradeoff, not a package-compatibility requirement imposed by the bridge architecture.

## Primary sources

- [Lerna: Version and Publish](https://lerna.js.org/docs/features/version-and-publish)
- [Lerna: Using pnpm](https://lerna.js.org/docs/recipes/using-pnpm-with-lerna)
- [Lerna configuration](https://lerna.js.org/docs/api-reference/configuration)
- [Lerna-Lite modular commands and Turbo rationale](https://github.com/lerna-lite/lerna-lite#available-commands)
- [Lerna-Lite publish: catalog and workspace transformations](https://github.com/lerna-lite/lerna-lite/tree/main/packages/publish#catalog-protocol)
- [Lerna-Lite version and fixed mode](https://github.com/lerna-lite/lerna-lite/tree/main/packages/version)
- [Lerna-Lite OIDC trusted publishing](https://github.com/lerna-lite/lerna-lite/tree/main/packages/publish#oidc)
- [Changesets configuration, including fixed groups](https://github.com/changesets/changesets/blob/main/site/guide/config.md)
- [Changesets versioning and publishing](https://github.com/changesets/changesets/blob/main/site/guide/versioning-and-publishing.md)
- [Changesets automation and trusted publishing](https://github.com/changesets/changesets/blob/main/site/guide/automating.md)
- [Changesets pnpm publish implementation](https://github.com/changesets/changesets/blob/main/packages/cli/src/lib/pnpm.ts)
- [Changesets package-manager selection](https://github.com/changesets/changesets/blob/main/packages/cli/src/commands/publish/getPublishTool.ts)
- [dvcol ESLint configuration](https://github.com/dvcol/eslint-config)
- [Antfu pnpm ESLint integration](https://github.com/antfu/eslint-config/blob/main/src/configs/pnpm.ts)
- [eslint-plugin-pnpm catalog enforcement](https://github.com/antfu/pnpm-workspace-utils/blob/main/packages/eslint-plugin-pnpm/src/rules/json/json-enforce-catalog.ts)
- [Vite DevTools pnpm workspace](https://github.com/vitejs/devtools/blob/main/pnpm-workspace.yaml)
- [Vite DevTools Turbo graph](https://github.com/vitejs/devtools/blob/main/turbo.json)
- [Vite DevTools tsdown neutral/Node split](https://github.com/vitejs/devtools/blob/main/packages/kit/tsdown.config.ts)
- [pnpm catalogs and publish-time replacement](https://pnpm.io/catalogs#publishing)
- [pnpm workspace protocol and publish-time replacement](https://pnpm.io/workspaces#publishing-workspace-packages)
