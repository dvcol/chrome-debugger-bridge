# CDB — Chrome Debugger Bridge

**CDB** is the public abbreviation for Chrome Debugger Bridge: a capability-scoped authorization layer over the Chrome debugger API. It exposes opaque targets and leased operations while keeping pairing credentials and Chrome identifiers inside the extension/host boundary.

Public packages use the `@dvcol/cdb` family. Runtime-specific functionality stays in explicit subpaths or companion packages, so browser, Node, extension, custom birpc, and MCP consumers import only the surface they need.

Default host endpoints are namespaced under `/cdb/` and remain configurable: `/cdb/agent`, `/cdb/client`, `/cdb/artifacts/`, and `/cdb/mcp`.

See [the implementation plan](./implementation-plan.md) for the architecture and [the examples](./examples/README.md) for supported compositions.
