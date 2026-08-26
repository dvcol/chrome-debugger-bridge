# CDB: Chrome Debugger Bridge

CDB is the transport-neutral debugger core used by DevKit browser control. It exposes Chrome
DevTools Protocol operations as agent tools while keeping authorization, target generations,
leases, cancellation, and event subscriptions independent from Chrome extension APIs.

In the local integration, CDB is a library dependency. It is not an MCP server per Vite process and
it does not discover browser tabs on its own.

## Place in the local browser-control stack

```text
agent MCP client
    | stdio
DevKit MCP bridge
    | authenticated DevKit RPC session
DevKit registry and browser broker (11112)
    | authenticated CDB provider transport (11113)
QA Helper service worker
    | chrome.debugger
granted Chrome tab
```

The responsibilities are intentionally split:

- DevKit owns agent principals, access requests, aggregate state, provider registration, and tool
  routing.
- QA Helper owns the user grant, the selected Chrome tab, debugger attachment, and final command
  enforcement.
- CDB owns the reusable target protocol, target generations, grants, shared and exclusive leases,
  command execution, cancellation, and subscriptions.
- DevTools and QA Helper render the same DevKit state. They do not mint grants or bypass CDB.

One provider identity represents one grant-provider installation/profile and may publish many
targets. It is not created per browser tab or window. Trusted diagnostic UIs can show provider IDs,
stable instance IDs, tab IDs, target IDs, and generations; pairing and authority secrets stay out of
aggregate state.

Navigation scope is intentionally above CDB. DevKit can authorize `same-origin` and `follow-tab`
principals independently against one stable target; QA Helper renews that target generation as the
tab crosses HTTP(S) origins. CDB only fences generations and applies the per-principal authority it
receives.

Agents do not need to infer page structure from screenshots. `browser.snapshot` captures a
structural DOM snapshot and returns a bounded text tree with backend node IDs and opaque child-session
references. Semantic tools resolve those references immediately before click, hover, focus, or text
entry. Coordinate pointer tools cover move, multi-button click, wheel scrolling, and drag. Navigation
tools cover URL navigation, history, reload, bounded load milestones, and JavaScript dialogs. It
consumes any broker artifact internally and omits inline `script`, `style`, and `noscript` bodies from
this default agent-readable view. Hosts can expose the generated raw CDP command catalogue when an
authorized agent needs the lossless response or another protocol operation.

Extension hosts can opt into `@dvcol/cdb-extension/presentation`. It renders an isolated pointer and
temporary control favicon from sanitized successful input events. The host still owns installation,
current grant state, navigation reinjection, approval UI, and Chrome policy. See the
[browser-control parity matrix](./docs/browser-control-parity.md) for supported and intentionally
excluded behavior.

Grants and leases have different lifetimes. A grant is durable authority owned by the embedding
broker; a lease is short-lived command coordination. Semantic tools acquire, use, and release their
temporary leases in one operation. Tools that deliberately return an artifact retain that lease until
the caller reads and releases the artifact.

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
| `@dvcol/cdb-mcp`       | Transport-neutral MCP tool definitions over a CDB client                                 |
| `@dvcol/cdb-websocket` | Authenticated browser and Node WebSocket transports                                      |

## Local linking

The proof of concept links source packages directly. Nothing needs to be published.

```json
{
  "dependencies": {
    "@dvcol/cdb": "link:../../../private/chrome-debugger-bridge/packages/core",
    "@dvcol/cdb-extension": "link:../../../private/chrome-debugger-bridge/packages/extension",
    "@dvcol/cdb-websocket": "link:../../../private/chrome-debugger-bridge/packages/websocket"
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

The cross-package proof additionally links these packages into DevKit and QA Helper, loads the
extension in Chromium, and launches an agent from DevTools. The validated agent requested DEBUG,
acquired exclusive control, set a breakpoint, observed `21` in the paused call frame, resumed to
`42`, removed the breakpoint, reloaded the page, and released its lease. The same run proves that CDB
is tool and transport infrastructure inside the single DevKit MCP surface, not another MCP host.
