# WebMCP validation handoff

Work for [issue 70](https://github.com/dvcol/chrome-debugger-bridge/issues/70) is staged in two local
CDB branches: `dvcol/define-adapters` from `main`, then `dvcol/webmcp`. The adapter configuration layer
is commit `76b9b99`. Downstream branches are both named `dvcol/cdb-webmcp`: app-frontends starts at
`88518587946` on `dvcol/cdb`, and QA Helper starts at `b86e151c` on `dvcol/cdb`.

## Current boundary

Another session owns the live downstream TNR. Do not start this change's live servers, Chromium
fixtures, extension reloads, downstream installs/builds, or full TNR until the user explicitly gives
the go-ahead. PR submission is also held because CDB PR CI starts full verification.

CDB checks performed before that boundary use the in-memory Chrome command port, broker, client
facade and MCP session. They cover main-document selection, empty/unsupported discovery, filtering,
callback failure and mutation isolation, generation/document references, exclusive invocation,
principal isolation, artifacts, cancellation and late responses. Package-scoped TypeScript checks,
lint and builds validate the public entrypoints. These are not live Chromium proof.

The dedicated app-frontends and QA Helper worktrees contain source, test and documentation changes
only. Their dependency manifests and installed packages have not been changed. They still reference
CDB 0.2.0, which does not export these new helpers. Consequently those downstream branches are not
ready for CI or release until dependency alignment is completed. No downstream tests have been run.

## Recorded pre-live checks

On 2026-09-14, 164 focused CDB tests passed: 78 core catalogue/authority/target-directory/scaffold
checks and 86 extension/MCP controller, publisher, session and semantic-tool checks. The latter
include 23 dedicated WebMCP cases. Type checks passed for core, extension, MCP, broker, Devframe,
WebSocket and Birpc, plus a scoped compilation of the new tests and native fixture. Core,
extension and MCP packages built successfully, changed TypeScript sources passed lint, and the
CDP catalogue regeneration check passed. Downstream checks and live fixtures remain unrun.

## Resume after the user's go-ahead

1. Re-read the branches and working-tree state. Confirm the other TNR has released its servers,
   browser profile, extension and package outputs before touching them.
2. Build and pack the CDB stack in dependency order. For local proof, install those tarballs only in
   the dedicated downstream worktrees and keep overrides local. Do not commit absolute filesystem
   paths or invent a published version. Before downstream PR submission, update manifests, both
   app-frontends catalogue definitions and lockfiles to the actual CDB release containing the stack.
3. Run the scoped DevKit/DevTools and QA Helper type, lint, format, quality and affected unit-test
   scripts required by their guides. Validate the QA Helper discovery exclusion for DevKit's exported
   `WEBMCP_TOOL_PREFIX`. Preserve installation identity, pairing database and storage keys.
4. Run the authored CDB native fixture:

   ```sh
   pnpm exec vitest run --project extension-e2e tests/e2e/native-webmcp.test.ts
   ```

   It uses an isolated Chromium profile, enables experimental web platform features, and registers
   a real tool on a trustworthy loopback page. It exercises the public MCP/client/broker/extension
   path, confirms iframe exclusion and a visible native side effect, then checks stale references
   and an empty catalogue after reload. It has only been statically checked so far. A missing native
   `document.modelContext` fails the test explicitly; record the Chrome version and flags.
5. Through DevKit MCP in the intended Chrome environment, request inspect access and list page tools.
   Verify QA Helper and application tools appear while `dev_square_` tools are hidden. Invocation at
   inspect must fail. At interact, invoke a known page tool and verify its visible effect. Check
   direct invocation of a hidden name, cancellation, navigation, authority renewal, another
   principal's isolation, and an artifact-sized result. Never replay an unknown invocation outcome.
6. Run the full CDB validation gates and downstream TNR inventories, including the public Devframe
   path, local shell and staging. When full local CDB gates are explicitly authorized, constrain
   Turbo and Vitest concurrency to one and use `NODE_OPTIONS=--max-old-space-size=4096`. Keep latency
   measurements separate from builds or other browser runs. Do not use DevKit's default registry
   port for temporary fixtures.
7. Review the diffs, submit the configuration/WebMCP PR stack, then submit downstream PRs against
   their intended CDB branches. Include actual test evidence and remaining browser limitations;
   do not label the live behavior verified until the preceding steps pass.
