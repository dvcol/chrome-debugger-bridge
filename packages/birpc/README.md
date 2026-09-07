# `@dvcol/cdb-birpc`

Application-owned birpc adapters for connecting Chrome Debugger Bridge clients and providers.

```sh
pnpm add @dvcol/cdb-birpc
```

Use the runtime-specific entry:

```ts
import { createBirpcBridgeClient } from '@dvcol/cdb-birpc/client';
```

Node and browser entry points remain separate so browser consumers do not receive Node-only code. See the [repository documentation](https://github.com/dvcol/chrome-debugger-bridge#readme) for composition examples.
