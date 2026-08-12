import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';

import { createEmbeddedChromeDebuggerBridge } from '@dvcol/cdb';
import { createPluginFromDevframe } from '@vitejs/devtools-kit/node';
import { viteDevBridge } from 'devframe/helpers/vite';
import { createServer } from 'vite';

import { createDevframeDefinition } from './devframe.mjs';

const targetSummaryPattern = /Available targets: 1/u;
const target = {
  availability: 'available',
  capabilities: { level: 'inspect' },
  generation: 1,
  id: 'e5f7a25e-810e-41a7-97d0-ae4636c5e4e5',
  scopeId: '76f667f1-cf48-4664-9c41-ffab0ed11b55',
  type: 'page',
};

async function postMcp(endpoint, request, sessionId) {
  const response = await fetch(endpoint, {
    body: JSON.stringify(request),
    headers: {
      'Accept': 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'Origin': 'http://127.0.0.1',
      ...(sessionId === undefined ? {} : { 'Mcp-Session-Id': sessionId }),
    },
    method: 'POST',
  });
  assert.equal(response.ok, true);
  const responseText = await response.text();
  const data = responseText.split('\n').find(line => line.startsWith('data: '));
  if (data === undefined) throw new Error(`Expected an MCP JSON response, received ${responseText}.`);
  const body = JSON.parse(data.slice('data: '.length));
  return { body, sessionId: response.headers.get('Mcp-Session-Id') };
}

async function reserveLoopbackPort() {
  const server = createHttpServer();
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected reserved TCP address.');
  await new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)));
  return address.port;
}

async function main() {
  const bridge = createEmbeddedChromeDebuggerBridge();
  bridge.broker.publishTarget(target);
  const devframe = createDevframeDefinition(bridge);
  const devframePort = await reserveLoopbackPort();
  const viteServer = await createServer({
    configFile: false,
    plugins: [
      createPluginFromDevframe(devframe),
      viteDevBridge(devframe, {
        auth: false,
        base: '/__cdb-devframe/',
        devMiddleware: { host: '127.0.0.1', port: devframePort },
        mcp: true,
      }),
    ],
    server: { host: '127.0.0.1', port: 0 },
  });

  try {
    await viteServer.listen();
    const viteAddress = viteServer.httpServer?.address();
    if (viteAddress === null || viteAddress === undefined || typeof viteAddress === 'string') throw new Error('Expected Vite TCP address.');
    const connectionResponse = await fetch(`http://127.0.0.1:${viteAddress.port}/__cdb-devframe/__connection.json`);
    assert.equal(connectionResponse.ok, true);
    const connection = await connectionResponse.json();
    assert.equal(typeof connection.mcp?.port, 'number');
    assert.equal(typeof connection.mcp?.path, 'string');

    const endpoint = `http://127.0.0.1:${connection.mcp.port}${connection.mcp.path}`;
    let initialized;
    try {
      initialized = await postMcp(endpoint, {
        id: 1,
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          capabilities: {},
          clientInfo: { name: 'cdb-devframe-example', version: '0.0.0' },
          protocolVersion: '2026-07-28',
        },
      });
    } catch (error) {
      throw new Error(`Unable to initialize Devframe MCP endpoint ${endpoint}.`, { cause: error });
    }
    assert.equal(typeof initialized.sessionId, 'string');
    const tools = await postMcp(endpoint, { id: 2, jsonrpc: '2.0', method: 'tools/list', params: {} }, initialized.sessionId);
    const summaryTool = tools.body.result.tools.find(tool => tool.name.includes('target-summary'));
    assert.equal(summaryTool.annotations.readOnlyHint, true);
    assert.equal(tools.body.result.tools.some(tool => tool.name.includes('cdp') || tool.name.includes('pair')), false);
    const summary = await postMcp(endpoint, { id: 3, jsonrpc: '2.0', method: 'tools/call', params: { arguments: {}, name: summaryTool.name } }, initialized.sessionId);
    assert.match(summary.body.result.content[0].text, targetSummaryPattern);
  } finally {
    await viteServer.close();
    bridge.dispose();
  }
}

void main();
