import type { GrantRequest } from '@dvcol/cdb';

import assert from 'node:assert/strict';
import { styleText } from 'node:util';

import { createNodeChromeDebuggerBridgeClient } from '@dvcol/cdb-websocket/node';

import { startGrantFlowHost } from './grant-flow.ts';

async function main(): Promise<void> {
  const host = await startGrantFlowHost();
  let client;
  try {
    const requestCreated = new Promise<GrantRequest>((resolveRequest) => {
      const unsubscribe = host.coordinator.subscribe(({ request }) => {
        if (request?.state !== 'pending') return;
        unsubscribe();
        resolveRequest(request);
      });
    });
    client = await createNodeChromeDebuggerBridgeClient({ artifactEndpoint: host.artifactEndpoint, authorization: host.clientAuthorization, endpoint: host.clientEndpoint });
    const request = await requestCreated;
    assert.equal(request.capabilities.level, 'interact');
    assert.deepEqual(await client.listTargets(), []);
    assert.equal((await fetch(`${host.endpoint}/control/state`)).status, 401);
    assert.ok((await fetch(host.endpoint).then(async response => response.text())).includes('CDB approval example'));
    client.dispose();
    await client.closed;
    await host.close();
    assert.equal(host.coordinator.getRequest(request.id), undefined);
  } catch (error) {
    client?.dispose();
    await host.close();
    throw error;
  }
}

void main().catch((error) => {
  console.error(styleText('red', '❌ [grant-example]'), error);
  process.exitCode = 1;
});
