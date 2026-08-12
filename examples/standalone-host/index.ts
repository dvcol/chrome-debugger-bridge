import { styleText } from 'node:util';

import { createStandaloneChromeDebuggerBridgeHost } from '@dvcol/cdb-websocket/node';

async function main(): Promise<void> {
  const host = await createStandaloneChromeDebuggerBridgeHost({
    clientAuthentication: {
      async authenticate(input) {
        return input.authorization === process.env.CHROME_DEBUGGER_BRIDGE_CLIENT_TOKEN
          ? { id: 'local-development-client', role: 'client' as const }
          : undefined;
      },
    },
    onPairingPresentation(presentation) {
      console.info(styleText('cyan', '🚀 [standalone-host]'), 'pair the extension before this code expires', presentation);
    },
  });

  process.once('SIGINT', () => {
    void host.dispose().finally(() => process.exit(0));
  });
}

void main();
