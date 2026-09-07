# `@dvcol/cdb`

Transport-neutral broker, protocol, authority, session, and client primitives for Chrome Debugger Bridge.

```sh
pnpm add @dvcol/cdb
```

Import the smallest public entry for the capability you need:

```ts
import { createTargetBroker } from '@dvcol/cdb/broker';
import { createMemoryAuthorityStore } from '@dvcol/cdb/authority';
```

CDB does not discover Chrome tabs or own an application's approval UI, process lifecycle, or MCP server. See the [repository documentation](https://github.com/dvcol/chrome-debugger-bridge#readme) for the architecture and security model.
