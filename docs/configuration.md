# Defining adapter configuration

Each configurable adapter exports a `define…` helper beside its factory. Helpers return the original
object, preserve callback types and literal values, and check configuration without opening
connections, installing listeners, reading stores, or starting timers. Factories still accept plain
options and apply the same checks when the helper is omitted.

```ts
import { createChromeProvider, defineProvider } from '@dvcol/cdb-extension/chrome';

const definition = defineProvider({
  maximumLevel: 'interact',
  connect: connectProvider,
  authorizeApproval,
});

const provider = createChromeProvider(definition);
provider.start();
```

`connectProvider` and `authorizeApproval` remain host callbacks. Defining configuration never calls
them. Mutable runtime dependencies, regular expressions, and callback closures are retained by
reference. Helpers do not serialize options or allocate default resources. Environment-dependent
checks, such as availability of Chrome, belong to runtime construction or connection.

| Entry | Helpers |
| --- | --- |
| Core | `defineTargetBroker`, `defineEmbeddedBridge`, `defineAgentConnection`, `defineClientConnection`, `defineGrantRequests`, `defineLogicalSession` |
| Broker | `defineBroker` |
| Extension `/chrome` | `defineProvider` |
| Extension | `definePublisher`, `defineSelectedTab`, `defineTabLifecycle`, `defineTabScope`, `defineApproval`, `defineApprovalSender`, `defineRecovery`, `defineBootstrap`, `defineOfferRelay`, `definePairingStore`, `definePageRequest` |
| Extension `/notifications` | `defineNotifications`, `defineNotificationRenderer` |
| WebSocket `/browser` | `defineAgentWebSocket`, `defineClientWebSocket`, `defineBrowserClient` |
| WebSocket `/node` | `defineWebSocketBridge`, `defineStandaloneWebSocket`, `defineClientWebSocket`, `defineNodeClient`, `defineStandaloneHost`, `defineArtifactEndpoint`, `defineArtifactReader`, `defineArtifactStore` |
| Birpc `/node` | `defineBridge` |
| Devframe | `defineService`, `definePanel` |
| Devframe `/connection` | `defineConnection` |
| Devframe `/client` | `defineClientSession`, `defineProvider` |
| Devframe `/panel`, `/page-script` | `definePanelMount`, `definePage` respectively |
| MCP | `defineTools`, `defineHttp`, `defineStdio` |
| Playwright automation | `defineProvider` |

Import aliases distinguish similarly named helpers when composing several adapters. Functions that
only wrap a live connection or platform object do not need a configuration helper.
