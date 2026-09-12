import type { DevframeHubContext } from '@devframes/hub';
import type { JsonRenderView } from '@devframes/json-render';
import type { DevframeDefinition, DevframeNodeContext, DevframeScopedNodeRpc } from 'devframe';

import type { BrowserControlPanelComponents } from './panel-view.js';
import type { BrowserControlPanelClient } from './panel.js';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { jsonRenderSpaDir } from '@devframes/json-render-ui/spa';
import { toJsonRenderDockEntry } from '@devframes/json-render/hub';
import { createJsonRenderView } from '@devframes/json-render/node';

import packageManifest from '../package.json' with { type: 'json' };
import { buildBrowserControlPanelView } from './panel-view.js';

/** Hosts may augment their RPC catalogue without exporting those declarations to CDB. */
interface PanelContext {
  rpc: { sharedState: Pick<DevframeNodeContext['rpc']['sharedState'], 'get'> };
  scope: (namespace: string) => { readonly rpc: Pick<DevframeScopedNodeRpc, 'sharedState'> & {
    register: (definition: Pick<Parameters<DevframeScopedNodeRpc['register']>[0], 'name' | 'type' | 'handler'>) => unknown;
  }; };
}

export type CdbPanelDefinition = Pick<DevframeDefinition, 'id' | 'name' | 'version' | 'packageName' | 'importMetaUrl' | 'homepage' | 'description' | 'icon' | 'capabilities' | 'clientAssets' | 'dock'> & {
  setup: (context: PanelContext) => Promise<void>;
};

export interface CdbPanelOptions {
  readonly client: () => BrowserControlPanelClient;
  readonly name?: string;
  /** Match the notification action to the embedding application's approval channel. */
  readonly approvalAction?: 'review' | 'accept';
  /** A mounted host may use its own JSON renderer and component properties. */
  readonly renderer?: { readonly type: string; readonly components?: BrowserControlPanelComponents };
  readonly dock?: { readonly category?: string; readonly defaultOrder?: number };
}

export interface CdbPanel {
  readonly definition: CdbPanelDefinition;
  dispose: () => void;
}

/** Serves Devframe's reference SPA; mounted hosts can select their own renderer. */
export function createCdbPanel(options: CdbPanelOptions): CdbPanel {
  const directory = dirname(fileURLToPath(import.meta.url));
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  let view: JsonRenderView | undefined;
  return {
    definition: {
      id: 'cdb-browser-control',
      name: options.name ?? 'Browser control',
      version: packageManifest.version,
      packageName: packageManifest.name,
      importMetaUrl: import.meta.url,
      homepage: packageManifest.homepage,
      description: 'Manage browser providers and approved access.',
      icon: 'ph:browser-duotone',
      capabilities: { build: false },
      clientAssets: jsonRenderSpaDir,
      dock: { defaultOrder: 1_000, ...options.dock, clientScript: { importFrom: join(directory, 'view/page-script.js'), ...(options.approvalAction === 'accept' ? { importName: 'setupBrowserControlAcceptPage' } : {}) } },
      async setup(context) {
        if (disposed) throw new Error('The CDB panel was disposed.');
        const client = options.client();
        const renderer = 'docks' in context ? options.renderer : undefined;
        const rpc = context.scope('cdb:panel').rpc;
        const initial = await client.snapshot();
        const state = await rpc.sharedState('state', { initialValue: { broker: initial } });
        view = createJsonRenderView(context as DevframeNodeContext, {
          id: 'browser-control',
          title: options.name ?? 'Browser control',
          spec: buildBrowserControlPanelView(initial, renderer?.components),
          ...(renderer === undefined ? {} : { schema: false as const }),
        });
        const stop = await client.watch((broker) => {
          state.mutate((value) => {
            value.broker = broker;
          });
          view?.update(buildBrowserControlPanelView(broker, renderer?.components));
        });
        if (disposed) {
          stop();
          view?.dispose();
          return;
        }
        unsubscribe = stop;
        rpc.register({ name: 'state', type: 'query', handler: async () => client.snapshot() });
        rpc.register({ name: 'revoke-scope', type: 'action', handler: async (requestId: string) => client.revokeScope(requestId) });
        rpc.register({ name: 'revoke-grant', type: 'action', handler: async (grantId: string) => client.revokeGrant(grantId) });
        rpc.register({ name: 'disconnect-provider', type: 'action', handler: async (providerId: string, forgetPairing: boolean) => client.disconnectProvider(providerId, forgetPairing) });
        rpc.register({ name: 'revoke-target', type: 'action', handler: async ({ grantId }: { grantId: string }) => client.revokeGrant(grantId) });
        rpc.register({ name: 'disconnect', type: 'action', handler: async ({ providerId }: { providerId: string }) => client.disconnectProvider(providerId) });
        rpc.register({ name: 'forget', type: 'action', handler: async ({ providerId }: { providerId: string }) => client.disconnectProvider(providerId, true) });
        if ('docks' in context) {
          const hub = context as unknown as DevframeHubContext;
          const entry = hub.docks.views.get('cdb-browser-control');
          if (entry === undefined) throw new Error('Install the CDB panel before selecting its renderer.');
          const dock = toJsonRenderDockEntry(view, entry);
          /** Host renderer names use the same JSON view contract as the reference renderer. */
          hub.docks.update({ ...dock, type: (options.renderer?.type ?? 'json-render') as typeof dock.type });
        }
      },
    },
    dispose() {
      disposed = true;
      unsubscribe?.();
      unsubscribe = undefined;
      view?.dispose();
      view = undefined;
    },
  };
}
