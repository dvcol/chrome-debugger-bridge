# CDB custom-birpc pre-release rename

Before the first public release, the custom `birpc` adapter was renamed to make
its scope explicit. It was never an implementation of upstream Devframe.

| Previous pre-release import | Replacement |
| --- | --- |
| `@dvcol/chrome-debugger-bridge-devframe/client` | `@dvcol/cdb-birpc/client` |
| `@dvcol/chrome-debugger-bridge-devframe/node` | `@dvcol/cdb-birpc/node` |

Rename `createDevframeBridgeClient` to `createBirpcBridgeClient` and
`mountDevframeChromeDebuggerBridge` to `mountBirpcChromeDebuggerBridge`.

No published production package requires a migration: this is a pre-release
workspace rename.
