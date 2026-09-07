# `@dvcol/cdb-mcp`

Node 24+ Model Context Protocol adapter for principal-scoped Chrome Debugger Bridge tools.

```sh
pnpm add @dvcol/cdb-mcp
```

```ts
import { createCdbToolSession } from '@dvcol/cdb-mcp';
```

Create one tool session per authenticated principal and dispose it with that principal. See the [repository documentation](https://github.com/dvcol/chrome-debugger-bridge#readme) for the authorization model.
