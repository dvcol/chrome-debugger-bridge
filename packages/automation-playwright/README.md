# `@dvcol/cdb-automation-playwright`

Experimental Node 24+ Playwright automation provider for Chrome Debugger Bridge embedding brokers.

```sh
pnpm add @dvcol/cdb-automation-playwright
```

```ts
import { createPlaywrightAutomationProvider } from '@dvcol/cdb-automation-playwright';
```

This adapter is experimental. Its API may change before CDB reaches a stable release. It uses the broker-authorized target executor and does not own Chrome-wide target selection or approval policy.
