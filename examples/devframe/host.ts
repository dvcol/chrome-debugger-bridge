import { join } from 'node:path';
import { styleText } from 'node:util';

import { createFileBrokerIdentityStore, defineBroker } from '@dvcol/cdb-broker';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createDevServer } from 'devframe/adapters/dev';
import { getTempAuthCode } from 'devframe/node/auth';

import { createDevframeExample } from './devframe.ts';

async function main(): Promise<void> {
  const example = createDevframeExample(defineBroker({
    identityStore: await createFileBrokerIdentityStore(join(import.meta.dirname, 'dist', 'identity')),
    navigation: { default: 'same-origin', allowed: ['same-origin', 'follow-tab'] },
  }));
  const extensionOrigin = process.env.CDB_EXTENSION_ORIGIN;
  const server = await createDevServer(example.definition, {
    host: '127.0.0.1',
    port: Number(process.env.CDB_EXAMPLE_PORT ?? 58920),
    mcp: false,
    openBrowser: false,
    ...(extensionOrigin === undefined ? {} : { allowedOrigins: [extensionOrigin] }),
    onPeerConnect: (connection, session) => {
      example.service.onPeerConnect(connection, session);
      console.error(styleText('yellow', '🔑 [cdb-example]'), 'Devframe authentication code:', getTempAuthCode());
    },
    onPeerDisconnect: (connection) => {
      void example.service.onPeerDisconnect(connection);
    },
  }).catch(async (error) => {
    await example.dispose();
    throw error;
  });
  const broker = example.service.broker;
  const agent = { id: 'example-stdio-agent', label: 'Example MCP agent' };
  const mcp = new Server({ name: 'cdb-devframe-example', version: example.definition.version }, { capabilities: { tools: {} } });
  mcp.setRequestHandler('tools/list', async () => ({ tools: broker.tools.map(tool => ({ ...tool, inputSchema: { ...tool.inputSchema, type: 'object' as const } })) }));
  mcp.setRequestHandler('tools/call', async (request, context) => {
    try {
      const value = await broker.invoke(agent, request.params.name, request.params.arguments, { signal: context.mcpReq.signal });
      return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ ...(error as object), message: error instanceof Error ? error.message : String(error) }) }] };
    }
  });
  let closing = false;
  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    await example.dispose();
    await server.close();
    await mcp.close();
  }
  mcp.onclose = () => {
    void close();
  };
  process.once('SIGINT', () => {
    void close();
  });
  process.once('SIGTERM', () => {
    void close();
  });
  await mcp.connect(new StdioServerTransport()).catch(async (error) => {
    await close();
    throw error;
  });
  console.error(styleText('cyan', '🌐 [cdb-example]'), `Panel and provider RPC: http://127.0.0.1:${server.port}/`);
}

void main();
