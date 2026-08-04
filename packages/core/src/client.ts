import type { PublishedTarget } from './protocol.js';

export interface TargetDirectory {
  listTargets: () => readonly PublishedTarget[] | Promise<readonly PublishedTarget[]>;
}

export interface ChromeDebuggerBridgeClient {
  listTargets: () => Promise<readonly PublishedTarget[]>;
}

/** Creates a transport-neutral client facade; Node and browser adapters supply the directory. */
export function createChromeDebuggerBridgeClient(directory: TargetDirectory): ChromeDebuggerBridgeClient {
  return {
    async listTargets() {
      return directory.listTargets();
    },
  };
}
