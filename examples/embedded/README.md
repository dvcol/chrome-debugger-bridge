# Embedded bridge

This private package is a network-free application composition. It uses the public packed-package entry point only:

```ts
import {
  createDiagnosticTraceStore,
  createEmbeddedChromeDebuggerBridge,
  createMemoryArtifactStore,
} from '@dvcol/chrome-debugger-bridge';

const now = () => Date.now();
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

// The application publishes opaque targets, supplies its executor, and disposes at shutdown.
bridge.dispose();
```
