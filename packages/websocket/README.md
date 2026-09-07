# `@dvcol/cdb-websocket`

Authenticated browser and Node WebSocket transports for Chrome Debugger Bridge.

```sh
pnpm add @dvcol/cdb-websocket
```

Use the runtime-specific entry:

```ts
import { createBrowserChromeDebuggerBridgeClient } from '@dvcol/cdb-websocket/browser';
```

Browser and Node entry points remain separate. See the [repository documentation](https://github.com/dvcol/chrome-debugger-bridge#readme) for authentication and transport limits.
