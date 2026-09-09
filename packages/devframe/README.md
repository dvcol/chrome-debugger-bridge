# @dvcol/cdb-devframe

CDB service, provider transport and browser-control panel for Devframe 0.9.10 and Node 24. The DevTools example retains DevTools Kit 0.6.1 and Vite 8.1.5.

Install `createCdbService({ broker: defineBroker(...) })` in a definition's `services` array. During `setup`, obtain its handle through `getCdbService(context)`. Forward the host's `onPeerConnect(connection, session)` and `onPeerDisconnect(connection)` callbacks to that handle. Call `dispose()` on startup failure and shutdown. Installation lasts for the Devframe context; no live service removal is required.

```ts
import { createCdbClient } from '@dvcol/cdb-devframe/client';

const browser = createCdbClient(existingAuthenticatedDevframeClient);
const provider = await browser.connectProvider({
  registration,
  pairingStore,
  pairingKey: existingPairingKey,
  confirmPairing,
});
```

This reuses the supplied peer. CDB pairing still verifies the provider's persistent implementation identity with a fresh, peer-bound proof. Browser operations send explicit cancellation messages. Closing a provider channel or disposing CDB does not close the host's connection. Forward transport loss to `browser.disconnected()`; reuse the handle for that context, or create a new one when the host replaces its Devframe client.

Use `createCdbClientSession({ credentialKey, credentialStore, metadata })` to retain an agent principal across replacement peers. Call `session.connect(browser)` after each connection and `session.terminate(browser)` on shutdown. CDB rotates the stored credential on resume and starts a new session when the previous one has ended. Connection and storage failures remain errors; they do not silently replace the principal.

`authorizePeer(session, operation)` adds application policy after Devframe authenticates the actual calling peer. Restrict management operations to the host's intended UI/provider roles. Agent tool contributions and invocation are available on the service's `broker`; this package does not install an MCP server or publish tools to WebMCP. Registry aggregation, owner selection and routing remain in the host.

For an existing tool catalogue, wrap the client call in `browser.withCancellation(signal, operationId => callRegisteredTool({ name, arguments, operationId }))`. After the host selects the registered browser contribution, invoke `service.invoke(actualPeerSession, { name, arguments, operationId })`. This shares CDB's operation tracking and cancellation while preserving the host's routing. Return structured error codes and details through the host's result contract; RPC exception serializers may preserve only an error's message.

The IndexedDB pairing store can locate an existing credential by broker and installation identity when its transport endpoint changes. It retains the original stored key and verifies the broker's proof before establishing the replacement channel.

## Panel

`createCdbPanel({ client: () => existingBrokerClient })` returns a Devframe `definition` and an explicit `dispose()` hook. Standalone mode serves Devframe's first-party `@devframes/json-render-ui` SPA. The shared JSON view contains summary cards, Requests/Access/Providers/Activity tabs, and expandable connection details. Mount the definition with `createEmbedded` or `createPluginFromDevframe`, or run it with `createDevServer`. Its client supplies only management state and actions; mounting it never creates a broker.

Mounted hubs can select an already registered JSON renderer and override component types or properties. This keeps the view and broker actions in CDB while the host supplies its design system:

```ts
const panel = createCdbPanel({
  client: () => existingBrokerClient,
  renderer: {
    type: 'host-json-render',
    components: { Card: { props: { interactive: true } } },
  },
  dock: { category: 'settings', defaultOrder: 1_000 },
});
```

The renderer must support Devframe's JSON view and action contracts. Component overrides apply only to that mounted renderer; the standalone SPA uses the reference catalogue. Dock ordering follows the host's categories and saved preferences. The page script remains available through `dock.clientScript` for host notifications and review intents.

For an existing application container, import `mountBrowserControlPanel` from `@dvcol/cdb-devframe/panel` and pass a `client`, `container`, optional branding/CSS and an `onReview` callback. Unmounting releases the panel subscription without disposing that client.

The page script emits `cdb:review-request` with `{ requestId }` to request the embedding application's final approval UI. This is an untrusted presentation intent. It never grants authority or proves a human decision. The extension must authenticate final approval from its trusted popup or other host-approved channel.

Hosts with a direct approval channel can set `approvalAction: 'accept'` on `createCdbPanel`. The page script then labels its action **Accept** and emits `cdb:accept-request`; the embedding application authenticates and handles the final approval. The default remains **Review request** and `cdb:review-request`.

See the [runnable example](../../examples/devframe/README.md).
