# `@dvcol/cdb-mcp`

Node 24+ Model Context Protocol adapter for principal-scoped Chrome Debugger Bridge tools.

```sh
pnpm add @dvcol/cdb-mcp
```

```ts
import { createCdbToolSession } from '@dvcol/cdb-mcp';
```

Create one tool session per authenticated principal and dispose it with that principal. See the [repository documentation](https://github.com/dvcol/chrome-debugger-bridge#readme) for the authorization model.

Opt-in Node diagnostic channels keep execution details outside agent responses. `cdb.mcp.action` reports action phases, CDP command outcomes and dispatch boundaries. `cdb.mcp.snapshot` separates frame discovery, command round trips, artifact reads and formatting; command round trips include provider and transport time. `cdb.mcp.hit-test` reports element and ancestor-frame geometry and hit nodes for diagnosing coordinate mismatches. Treat hit-test records as private page diagnostics.
