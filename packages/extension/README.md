# `@dvcol/cdb-extension`

Manifest V3 helpers for publishing approved Chrome targets, recovering connections, and presenting browser control.

```sh
pnpm add @dvcol/cdb-extension
```

```ts
import { createBirpcAgentBootstrap } from '@dvcol/cdb-extension/bootstrap';
```

The embedding extension owns Chrome selection policy and approval UI. See the [repository documentation](https://github.com/dvcol/chrome-debugger-bridge#readme) for the provider trust boundary.
