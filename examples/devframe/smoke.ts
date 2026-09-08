import assert from 'node:assert/strict';

import { createDevServer } from 'devframe/adapters/dev';

import { createDevframeExample } from './devframe.ts';

const panelTitlePattern = /Browser control/u;
const pageScriptPattern = /cdb:review-request/u;

async function main(): Promise<void> {
  const example = createDevframeExample();
  try {
    const server = await createDevServer(example.definition, {
      port: 0,
      host: '127.0.0.1',
      auth: false,
      mcp: false,
      openBrowser: false,
      onPeerConnect: (connection, session) => example.service.onPeerConnect(connection, session),
      onPeerDisconnect: (connection) => {
        void example.service.onPeerDisconnect(connection);
      },
    });
    try {
      const page = await fetch(`http://127.0.0.1:${server.port}/`);
      assert.equal(page.ok, true);
      assert.match(await page.text(), panelTitlePattern);
      const script = await fetch(`http://127.0.0.1:${server.port}/page-script.js`);
      assert.equal(script.ok, true);
      assert.match(await script.text(), pageScriptPattern);
      assert.ok(example.service.broker.tools.some(tool => tool.name === 'browser.batch'));
      assert.deepEqual(example.service.broker.snapshot().providers, []);
    } finally {
      await server.close();
    }
  } finally {
    await example.dispose();
  }
}

void main();
