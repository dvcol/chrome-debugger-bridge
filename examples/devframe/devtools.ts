import type { BrowserControlPanelClient } from '@dvcol/cdb-devframe/panel';

import { createCdbPanel } from '@dvcol/cdb-devframe';
import { createPluginFromDevframe } from '@vitejs/devtools-kit/node';

/** The embedding application supplies its existing broker client and owns plugin teardown. */
export function createBrowserControlDevtoolsPlugin(client: BrowserControlPanelClient): {
  readonly plugin: ReturnType<typeof createPluginFromDevframe>;
  dispose: () => void;
} {
  const panel = createCdbPanel({ client: () => client });
  return { plugin: createPluginFromDevframe(panel.definition), dispose: panel.dispose };
}
