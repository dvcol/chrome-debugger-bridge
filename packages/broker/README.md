# @dvcol/cdb-broker

Browser-control orchestration for an embedding host. Requires Node 24. The host owns its processes, authenticated client identities, tool catalogue and MCP server.

```ts
import { createBroker, createFileBrokerIdentityStore, defineBroker } from '@dvcol/cdb-broker';

const definition = defineBroker({
  identityStore: await createFileBrokerIdentityStore('/host/chosen/identity-directory'),
  navigation: { default: 'same-origin', allowed: ['same-origin', 'follow-tab'] },
});
const broker = await createBroker(definition);

// Register these contributions in the host's existing catalogue.
const tools = broker.tools;
const result = await broker.invoke(authenticatedPeer, toolName, arguments_, { signal });

await broker.disconnectPeer(authenticatedPeer.id);
await broker.dispose();
```

`defineBroker` validates configuration without opening connections or starting processes. `createBroker` composes CDB authority stores, logical sessions, grant coordination, pairing and per-principal semantic tool sessions. `snapshot()` and `subscribe()` derive management state from those stores. The management interface must be restricted to the host's trusted operators and providers; it is not an agent tool.

Use `@dvcol/cdb-devframe` to carry providers on an existing Devframe connection. Other transports can use the runtime's registration, authentication, provider connection and claim methods directly.

Keep an existing identity directory when adopting this package. The file store reads the version-1 `identity.json` format and preserves broker IDs and pairing credentials. The host also preserves each extension's installation ID and pairing-store key. Resume credentials belong to the host, never to model-visible arguments.

Navigation requests must match a configured preset; disallowed requests fail without downgrading. Each grant binds its selected preset to the requesting principal and exact target. `same-origin` retains the approved origin; `follow-tab` permits subsequent HTTP(S) origins. An optional `navigation.authorize` callback adds host restrictions. Navigation renews target generations and invalidates document-bound element references.

Native automation is the default. To select the experimental Playwright provider, supply a lazy `automationProvider` factory that imports `@dvcol/cdb-automation-playwright` explicitly. It is not a dependency of this package.

See the [public Devframe example](../../examples/devframe/README.md) and [architecture](../../ARCHITECTURE.md).
