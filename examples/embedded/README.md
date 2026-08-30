# Embedded bridge

This private package is a network-free application composition. The embedding application owns the in-process listener, authorization adapter, diagnostics, identifier, clock, and artifact store. It deliberately exposes no HTTP or WebSocket client endpoint. It uses the public packed-package entry point only:

```ts
import {
  connectStoreBackedClientTargetBroker,
  createAgentSession,
  createDiagnosticTraceStore,
  createEmbeddedChromeDebuggerBridge,
  createLogicalSessionManager,
  createMemoryArtifactStore,
  createMemoryAuthorityStore,
  createMemoryCredentialStore,
} from '@dvcol/cdb';

const now = () => Date.now();
const authorityStore = createMemoryAuthorityStore();
const credentialStore = createMemoryCredentialStore();
const logicalSessions = createLogicalSessionManager({ authorityStore });
const agentSession = createAgentSession();
const bridge = createEmbeddedChromeDebuggerBridge({
  artifactStore: createMemoryArtifactStore(1_048_576, now),
  authorization: {
    authorize(command) {
      return command.method === 'Runtime.evaluate';
    },
  },
  diagnostics: createDiagnosticTraceStore(100, now),
  generateId: () => crypto.randomUUID(),
  now,
});

// A host can bind a broker client reactively with connectStoreBackedClientTargetBroker after
// creating a logical session. The credential store remains on the resuming client side.
void connectStoreBackedClientTargetBroker;
void credentialStore;

// The application publishes opaque targets, supplies its executor, and disposes at shutdown.
agentSession.dispose();
logicalSessions.dispose();
bridge.dispose();
```

Run `pnpm --filter @chrome-debugger-bridge-example/embedded smoke` to verify the packed public import.
