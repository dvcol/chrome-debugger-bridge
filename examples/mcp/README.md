# MCP host

This private example embeds the broker and its in-process client in an application-owned Node host, then mounts the public MCP adapter as Streamable HTTP. MCP authentication and process lifecycle remain application responsibilities; pairing credentials and Chrome identifiers never become MCP data.

Its `smoke` program uses the official MCP SDK v2 client against the declared `2026-07-28` protocol. It proves target discovery, an inspect read, navigation, request cancellation, artifact retrieval, and the absence of `browser.raw_cdp` unless a trusted host explicitly opts in. It also starts and closes the optional stdio adapter separately from the HTTP and debugger lifecycles.

Run `pnpm --filter @chrome-debugger-bridge-example/mcp smoke`. The packed-package verifier repeats this command with tarball dependencies rather than workspace aliases.
