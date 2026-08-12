import { defineDevframe } from 'devframe/types';

/** Creates an experimental Devframe surface over safe bridge target summaries only. */
export function createDevframeDefinition(bridge) {
  return defineDevframe({
    description: 'Experimental Devframe target-summary integration for CDB.',
    icon: 'ph:bug-duotone',
    id: 'cdb-devframe',
    name: 'CDB Devframe',
    packageName: '@chrome-debugger-bridge-example/devframe',
    setup(context) {
      context.agent.registerTool({
        description: 'Summarize the number of currently available Chrome Debugger Bridge targets without exposing target identifiers.',
        handler: async () => {
          const targets = await bridge.client.listTargets();
          return {
            markdown: `Available targets: ${targets.filter(target => target.availability === 'available').length}.`,
          };
        },
        id: 'cdb-devframe:target-summary',
        safety: 'read',
      });
    },
    version: '0.0.0',
  });
}
