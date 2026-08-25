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

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the protocol and failure model. See
[AGENTS.md](./AGENTS.md) before changing an invariant.

## Workspace packages

| Package                | Role                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `@dvcol/cdb`           | Broker, client facade, protocol types, target authorization, leases, and command routing |
| `@dvcol/cdb-birpc`     | RPC transport adapter                                                                    |
| `@dvcol/cdb-extension` | Browser-extension helpers for publication, heartbeat, and recovery                       |
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
