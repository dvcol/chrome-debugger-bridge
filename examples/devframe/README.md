# Experimental Devframe MCP architecture

This private example uses upstream Devframe, its Vite integration, and its route-based MCP server as an alternative MCP architecture. It composes directly with `@dvcol/cdb` broker/client primitives; it does not import `@dvcol/cdb-mcp` or `@dvcol/cdb-birpc`.

The only agent-enabled capability is a read-only target count. It deliberately omits pairing credentials, raw target identifiers, and raw CDP access. Its smoke flow starts Vite, discovers Devframe's side-car MCP endpoint from `__connection.json`, establishes an MCP session with a loopback Origin, calls the safe summary tool, and closes the Vite and broker lifecycles.

Run `pnpm --filter @chrome-debugger-bridge-example/devframe smoke`. This is experimental because Devframe's agent-native MCP surface is upstream experimental.
