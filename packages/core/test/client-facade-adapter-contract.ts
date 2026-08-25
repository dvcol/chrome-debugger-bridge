import { createTargetBroker } from '../src/broker.js';
import { createChromeDebuggerBridgeClient, createClientFacadeAdapter } from '../src/client.js';

const broker = createTargetBroker();

createChromeDebuggerBridgeClient(createClientFacadeAdapter({
  listTargets: () => broker.listTargets(),
}));

// @ts-expect-error TargetBroker is authority-bearing and must not be a public facade adapter.
createChromeDebuggerBridgeClient(broker);
