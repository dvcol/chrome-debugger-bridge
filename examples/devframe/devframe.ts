import type { BrokerDefinition } from '@dvcol/cdb-broker';
import type { CdbDevframeService } from '@dvcol/cdb-devframe';
import type { DevframeDefinition } from 'devframe';

import { createCdbPanel, createCdbService, getCdbService } from '@dvcol/cdb-devframe';

/** The example owns service lifecycle; mounting its panel does not create another broker. */
export function createDevframeExample(broker: BrokerDefinition = {}): { readonly definition: DevframeDefinition; readonly service: CdbDevframeService; dispose: () => Promise<void> } {
  let service: CdbDevframeService | undefined;
  const panel = createCdbPanel({ client() {
    if (service === undefined) throw new Error('The example broker is not ready.');
    const runtime = service.broker;
    return { ...runtime, watch(listener) {
      listener(runtime.snapshot());
      return runtime.subscribe(listener);
    } };
  } });
  return {
    definition: {
      ...panel.definition,
      services: [createCdbService({ broker })],
      async setup(context) {
        service = getCdbService(context);
        await panel.definition.setup(context);
      },
    },
    get service(): CdbDevframeService {
      if (service === undefined) throw new Error('The example broker is not ready.');
      return service;
    },
    async dispose() {
      panel.dispose();
      await service?.dispose();
    },
  };
}
