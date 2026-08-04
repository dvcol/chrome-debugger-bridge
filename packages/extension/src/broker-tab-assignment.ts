import type { PublishedTarget } from '@dvcol/chrome-debugger-bridge/protocol';

import type { SelectedTab } from './selected-tab-publisher.js';

/** The per-broker boundary keeps pairing credentials and connection ownership outside tab arbitration. */
export interface BrokerTabPublisher {
  readonly brokerId: string;
  publish: (tab: SelectedTab) => Promise<PublishedTarget>;
  revoke: () => Promise<void>;
}

export interface BrokerTabAssignment {
  assign: (broker: BrokerTabPublisher, tab: SelectedTab) => Promise<PublishedTarget>;
  revoke: (tabId: number) => Promise<void>;
}

/** Gives a root tab one authoritative broker by revoking its old publication before reassignment. */
export function createBrokerTabAssignment(): BrokerTabAssignment {
  const assignments = new Map<number, BrokerTabPublisher>();
  const pendingAssignments = new Map<number, Promise<void>>();

  async function serialize<Value>(tabId: number, operation: () => Promise<Value>): Promise<Value> {
    const previousOperation = pendingAssignments.get(tabId) ?? Promise.resolve();
    let releaseOperation: () => void;
    const currentOperation = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const queuedOperation = previousOperation.then(async () => currentOperation);
    pendingAssignments.set(tabId, queuedOperation);
    await previousOperation;
    try {
      return await operation();
    } finally {
      releaseOperation!();
      if (pendingAssignments.get(tabId) === queuedOperation) pendingAssignments.delete(tabId);
    }
  }

  return {
    async assign(broker, tab) {
      return serialize(tab.tabId, async () => {
        const previousBroker = assignments.get(tab.tabId);
        if (previousBroker?.brokerId === broker.brokerId) return broker.publish(tab);
        if (previousBroker !== undefined) {
          assignments.delete(tab.tabId);
          await previousBroker.revoke();
        }
        const target = await broker.publish(tab);
        assignments.set(tab.tabId, broker);
        return target;
      });
    },
    async revoke(tabId) {
      return serialize(tabId, async () => {
        const broker = assignments.get(tabId);
        if (broker === undefined) return;
        assignments.delete(tabId);
        await broker.revoke();
      });
    },
  };
}
