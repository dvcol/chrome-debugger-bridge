import { styleText } from 'node:util';

import { createCdbToolSession } from '@dvcol/cdb-mcp';
import { createNodeChromeDebuggerBridgeClient } from '@dvcol/cdb-websocket/node';

async function main(): Promise<void> {
  const endpoint = process.argv[2];
  const authorization = process.env.CDB_EXAMPLE_CLIENT_AUTHORIZATION;
  if (endpoint === undefined || authorization === undefined)
    throw new Error('Pass the client WebSocket endpoint and set CDB_EXAMPLE_CLIENT_AUTHORIZATION from the host terminal.');
  const artifactEndpoint = new URL('/cdb/artifacts/', endpoint.replace('ws:', 'http:').replace('wss:', 'https:')).href;
  const client = await createNodeChromeDebuggerBridgeClient({ artifactEndpoint, authorization, endpoint });
  const session = createCdbToolSession({ client });
  console.info(styleText('cyan', '🚀 [grant-example]'), 'Waiting for approval in the extension toolbar.');
  let targets = await client.listTargets();
  if (targets.length === 0) {
    for await (const change of client.watchTargets()) {
      if (change.kind === 'snapshot') targets = change.targets;
      else if (change.kind === 'published' || change.kind === 'updated') targets = [change.target];
      if (targets.length > 0) break;
    }
  }
  if (targets[0] === undefined) throw new Error('The client disconnected before approval.');
  const targetRef = session.projectTarget(targets[0])?.targetRef;
  if (targetRef === undefined) throw new Error('The approved target disappeared.');
  const snapshot = session.definitions.find(definition => definition.name === 'browser.snapshot');
  if (snapshot === undefined) throw new Error('The semantic snapshot tool is unavailable.');
  const result = await snapshot.invoke({ targetRef });
  console.info(styleText('cyan', '🚀 [grant-example]'), 'Approved snapshot:', result);
  console.info(styleText('cyan', '🚀 [grant-example]'), 'Keep this client running to retain access. Ctrl-C revokes its session.');
  process.once('SIGINT', () => {
    session.dispose();
    client.dispose();
  });
}

void main().catch((error) => {
  console.error(styleText('red', '❌ [grant-example]'), error);
  process.exitCode = 1;
});
