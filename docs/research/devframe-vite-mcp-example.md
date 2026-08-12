# Devframe Vite MCP example research

## Decision

Do not add a Devframe MCP wrapper to the current release-critical example set.
Create a separate, explicitly experimental follow-up only if we want to prove a
hosted Vite/Devframe composition. It should be an application-level example,
not another bridge adapter and not a replacement for `@dvcol/chrome-debugger-bridge-mcp`.

## What Devframe provides

Devframe has an experimental agent-native surface. A Devframe definition opts
individual RPC functions into agent use with `agent`; plugins can separately
register tools and readable resources. Its MCP adapter projects that Devframe
agent host to MCP. Functions remain private unless explicitly opted in, and
Devframe maps its read/action/destructive safety classification to MCP tool
annotations. [Agent-Native Devframe](https://devfra.me/guide/agent-native)

There are two relevant delivery modes:

- `createMcpServer(definition, { transport: 'stdio' })` provides a stdio MCP
  server, and the `devframe mcp` CLI invokes that mode. The documented peer is
  `@modelcontextprotocol/sdk`. [Devframe MCP adapter](https://devfra.me/adapters/mcp)
- A Devframe development server can expose the same agent surface by enabling
  `cli.mcp`. It serves Streamable HTTP at `/__mcp` relative to the Devframe
  base path, gives each client session its own server, and defaults to a
  loopback origin policy. [Devframe MCP adapter](https://devfra.me/adapters/mcp)

Vite is a separate host integration: `createPluginFromDevframe` from
`@vitejs/devtools-kit/node` turns a definition into a Vite DevTools dock plugin.
Devframe deliberately does not depend on Vite or the Vite DevTools kit.
[Devframe Vite adapter](https://devfra.me/adapters/vite)

## Fit with this repository

The existing application-owned custom birpc adapter is intentionally
transport-neutral: it accepts an existing HTTP server plus a `birpc`-shaped
channel, then mounts authenticated direct agent/client WebSocket endpoints.
It does not create a Devframe definition or own a Vite listener. See
[`packages/birpc/src/node.ts`](../../packages/birpc/src/node.ts) and
[`examples/birpc/README.md`](../../examples/birpc/README.md).

The existing MCP package is a different composition. It supplies the bridge's
lease- and capability-governed CDP tools over MCP SDK v2 Streamable HTTP or an
optional stdio transport; the application still owns authentication and
lifecycle. See [`packages/mcp/src/index.ts`](../../packages/mcp/src/index.ts)
and [`examples/mcp/README.md`](../../examples/mcp/README.md).

Consequently, Devframe's adapter cannot wrap the bridge MCP adapter. It would
create a second MCP server for Devframe's own selected tools/resources. A
useful combined example must instead mount both surfaces in one application
and deliberately expose a small, safe Devframe-facing bridge feature (for
example, diagnostics or target summaries) through Devframe's agent host.

## Compatibility and risk

This workspace uses the MCP SDK v2 split packages (`@modelcontextprotocol/server`,
`@modelcontextprotocol/node`, and `@modelcontextprotocol/client`) at 2.0.0.
Devframe's published adapter documentation names the monolithic
`@modelcontextprotocol/sdk` peer; its source package manifest likewise
declares that optional peer. [Devframe package manifest](https://github.com/devframes/devframe/blob/main/packages/devframe/package.json)

That does not prove the two can never coexist, but it does make a dependency
resolution and runtime compatibility spike a prerequisite. The Devframe
agent-native and MCP features are also explicitly experimental and may change
without a major version bump. [Agent-Native Devframe](https://devfra.me/guide/agent-native)

Adding the example now would introduce external Devframe and Vite DevTools-kit
dependencies, a second MCP endpoint/authority model, and potentially two SDK
package families. None is needed to validate the public bridge custom-birpc or
MCP adapters already in the release map.

## Candidate follow-up issue

**Title:** Prove an experimental Vite Devframe agent-native MCP composition

**Scope:** Build one private, packed-package example that starts an actual Vite
DevTools host and enables a separate Devframe agent-native MCP surface. Compose
directly with the bridge's lower-level broker/client contracts; never import,
mount, wrap, or proxy the bridge MCP package or `@dvcol/cdb-birpc`. Use a
dedicated endpoint and prove that it does not expose pairing credentials, raw
target identifiers, or raw CDP by default. Validate HTTP session/origin
isolation, shutdown of both MCP servers, and dependency compatibility with this
repository's MCP SDK v2.

**Explicit non-goals:** Do not replace the bridge MCP adapter, reimplement its
semantic tools in Devframe, make Devframe/Vite dependencies public runtime
dependencies of bridge packages, or alter the release-critical package/export
contract.

**Suggested blocker:** a dependency-resolution and runtime-compatibility spike,
because the Devframe adapter currently declares the monolithic MCP SDK peer.
Keep it outside the critical path unless a real Vite consumer requires it.
