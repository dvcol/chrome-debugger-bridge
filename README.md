# CDB: Chrome Debugger Bridge

CDB is a transport-neutral debugger protocol library. It exposes Chrome DevTools Protocol
operations as agent tools while keeping authorization, target generations, leases, cancellation,
and event subscriptions independent from Chrome extension APIs.

An embedding host composes CDB as a library. CDB does not discover browser tabs, start application
servers, or own an application's MCP lifecycle.

## Place in a browser-control stack

```text
agent MCP client
    | application-owned transport
embedding host and principal registry
    | CDB client and broker adapters
CDB target broker
    | authenticated provider transport
browser-extension provider
    | chrome.debugger
authorized Chrome target
```

The responsibilities are intentionally split:

- The embedding host owns agent principals, user-facing access requests, aggregate state, provider
  registration, policy, and tool routing.
- The provider host owns target selection, approval UI, debugger attachment, and final command
  enforcement.
- CDB owns the reusable target protocol, target generations, grant enforcement, shared and exclusive
  leases, command execution, cancellation, and subscriptions.
- Application frontends may render host state, but they do not mint CDB authority or bypass the
  provider.

One provider identity represents one grant-provider installation/profile and may publish many
targets. It is not created per browser tab or window. Trusted diagnostic UIs can show provider IDs,
stable instance IDs, tab IDs, target IDs, and generations; pairing and authority secrets stay out of
aggregate state.

Navigation scope is intentionally above CDB. An embedding host may authorize principals with
different navigation policies against one stable target. The provider renews the target generation
when its platform policy requires it. CDB only fences generations and applies the per-principal
authority it receives.

Each authenticated MCP principal owns one `createCdbToolSession`. The session projects authorized
targets as short `tN` references that survive document renewal, target-generation replacement, and a
logical-session resume. Rebinding a resumed client drops disposable `eN` references and all in-flight
work. Manual authority revocation or logical-session termination removes the stable target reference.
Raw target IDs and generations remain available only through the diagnostic listing and trusted host
UI.

Agents do not need to infer page structure from screenshots. `browser.snapshot` defaults to a compact
interactive accessibility tree and returns monotonic disposable `eN` element references. Complete
bounded accessibility and diagnostic DOM modes are available explicitly. `browser.find` and semantic
actions accept serializable Playwright-style locators for roles, names, text, labels, placeholders,
alt text, titles, test IDs, CSS, frames, descendants, and filters. Locator actions re-resolve before
input, traverse author shadow roots, wait for actionability, and never replay after input might have
been dispatched. Coordinate-only controls are named with an `_at` suffix. `browser.evaluate` is a
debug-level escape hatch: it bypasses locator guarantees and visible pointer feedback. Set
`enableRawCdp: true` to expose evaluation, artifact diagnostics, and the raw CDP catalogue. The default
catalogue keeps these tools out of agent discovery. See the [native MVP guide](./docs/native-mvp.md)
for batches, snapshot limits, and recorded browser measurements.

The native semantic implementation remains the default. An embedding broker can explicitly select
one registered automation provider for an authenticated extension-provider connection. The
experimental `@dvcol/cdb-automation-playwright` package adapts Playwright's maintained in-process
extension relay to CDB's authorized target executor: Playwright neither opens another debugger
attachment nor receives a browser-wide CDP endpoint. Provider initialization or execution failure is
reported as a structured failure; it never silently falls back to native semantics.

Extension hosts can opt into `@dvcol/cdb-extension/presentation`. It renders an isolated pointer and
temporary control favicon from sanitized successful input events. The host still owns installation,
current grant state, navigation reinjection, approval UI, and Chrome policy. See the
[browser-control parity matrix](./docs/browser-control-parity.md) for supported and intentionally
excluded behavior.

Authority bindings and leases have different lifetimes. The embedding host owns consent policy and
creates exact target-generation bindings in an injected `AuthorityStore`. CDB observes those records
reactively, fails closed when the store is unavailable, and owns short-lived lease coordination.
Semantic tools acquire, use, and release their temporary leases in one operation. Tools that
deliberately return an artifact retain that lease until the caller reads and releases the artifact.

`@dvcol/cdb/session` uses opaque rotating resume credentials to keep a logical session across
transport replacement. Only the broker-side hash is stored with authority. A separate
`CredentialStore` keeps the raw client credential below the model-facing layer. Both stores default
to asynchronous memory implementations. Persistence is dependency injection, not a CDB setting, so
consumers choose their own I/O and restart-recovery tradeoff.

CDB owns lifecycle activation for leased CDP domains. Callers request the commands and events they
need, not `*.enable` or `*.disable`; the broker activates a managed domain before first use and
reference-counts it across leases.

Artifact externalization happens after the raw debugger result reaches the broker. Hosts that enable
large DOM snapshots, screenshots, or response bodies must configure the authenticated WebSocket
message bound above the generic 16 KiB default; transport overflow closes the provider connection
rather than representing lease or grant expiry.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the protocol and failure model. See
[AGENTS.md](./AGENTS.md) before changing an invariant.

## Workspace packages

| Package                | Role                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `@dvcol/cdb`           | Broker, client facade, protocol types, target authorization, leases, and command routing |
| `@dvcol/cdb-birpc`     | RPC transport adapter                                                                    |
| `@dvcol/cdb-extension` | Browser-extension helpers for publication, recovery, and opt-in control presentation |
| `@dvcol/cdb-mcp`       | Principal-scoped semantic and raw MCP tool sessions over a CDB client                    |
| `@dvcol/cdb-automation-playwright` | Experimental Playwright semantic provider over a broker-authorized CDB executor |
| `@dvcol/cdb-websocket` | Authenticated browser and Node WebSocket transports                                      |

## Store and timing composition

The zero-I/O composition uses the memory stores:

```ts
import { createMemoryAuthorityStore } from '@dvcol/cdb/authority';
import { createLogicalSessionManager, createMemoryCredentialStore } from '@dvcol/cdb/session';

const authorityStore = createMemoryAuthorityStore();
const credentialStore = createMemoryCredentialStore();
const logicalSessions = createLogicalSessionManager({
  authorityStore,
  timing: { resumeWindowMilliseconds: 15 * 60_000 },
});
```

A consumer may implement the two contracts over the same database while keeping the records and
trust boundaries separate:

```ts
import type { AuthorityStore } from '@dvcol/cdb/authority';
import type { CredentialStore } from '@dvcol/cdb/session';

declare const persistentAuthorityStore: AuthorityStore;
declare const persistentCredentialStore: CredentialStore;
```

All CDB-owned deadlines are constructor policy. Positive milliseconds schedule expiry, `0` expires
immediately, and `null` disables the deadline:

```ts
import { createTargetBroker } from '@dvcol/cdb/broker';

const broker = createTargetBroker({
  timing: {
    commandTimeoutMilliseconds: 30_000,
    leaseMaximumDurationMilliseconds: 60_000,
    leaseMaximumLifetimeMilliseconds: 15 * 60_000,
    reconnectGraceMilliseconds: 0,
  },
});
```

## Local linking

Applications can link source packages directly while developing an adapter. Nothing needs to be
published first.

```json
{
  "dependencies": {
    "@dvcol/cdb": "link:../chrome-debugger-bridge/packages/core",
    "@dvcol/cdb-extension": "link:../chrome-debugger-bridge/packages/extension",
    "@dvcol/cdb-websocket": "link:../chrome-debugger-bridge/packages/websocket"
  }
}
```

Build linked packages after changing their public types because downstream workspaces may resolve
their generated declarations:

```sh
pnpm build
```

## Development validation

```sh
pnpm verify
```

`pnpm verify` includes workspace and generated-catalog checks, lint, typecheck, unit and integration
tests, builds, Chromium tests, extension E2E, browser runtime-boundary checks, publint, tarball
construction, package consumers, and packed example smoke commands. Loopback permission is required
because the HTTP and WebSocket suites bind `127.0.0.1`.

Consumer applications own their policy, UI, and platform-specific end-to-end checks. CDB's own
validation proves the public packages, authenticated transports, extension helpers, and example
compositions without importing a consumer application.
