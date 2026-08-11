# MCP host

This composition combines the bridge with an application-owned MCP server. Configure the MCP server to authenticate its callers, then compose its tool handlers with the bridge's public exports. The application owns MCP authorization and process lifecycle; the bridge keeps extension pairing and CDP authority separate, so MCP callers never receive pairing credentials.

Run `pnpm --filter @chrome-debugger-bridge-example/mcp smoke` to verify its packed public import.
