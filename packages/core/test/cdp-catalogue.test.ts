import { describe, expect, it } from 'vitest';

import {
  cdpCapabilityCatalogue,
  cdpCatalogueMetadata,
  cdpKernelOwnedNames,
} from '../src/cdp-catalogue.js';

describe('generated CDP capability catalogue', () => {
  it('classifies representative commands and events by their direct purpose', () => {
    expect.assertions(10);

    expect(cdpCapabilityCatalogue['Inspector.detached']).toEqual({ kind: 'event', level: 'observe' });
    expect(cdpCapabilityCatalogue['DOM.getDocument']).toEqual({ kind: 'command', level: 'inspect' });
    expect(cdpCapabilityCatalogue['Network.responseReceived']).toEqual({ kind: 'event', level: 'inspect' });
    expect(cdpCapabilityCatalogue['Page.navigate']).toEqual({ kind: 'command', level: 'interact' });
    expect(cdpCapabilityCatalogue['Runtime.evaluate']).toEqual({ kind: 'command', level: 'interact' });
    expect(cdpCapabilityCatalogue['Debugger.pause']).toEqual({ kind: 'command', level: 'debug' });
    expect(cdpCapabilityCatalogue['Fetch.requestPaused']).toEqual({ kind: 'event', level: 'debug' });
    expect(cdpCapabilityCatalogue['Page.crash']).toEqual({ kind: 'command', level: 'unsafe' });
    expect(cdpCapabilityCatalogue['Page.setDownloadBehavior']).toEqual({ kind: 'command', level: 'unsafe' });
    expect(Object.keys(cdpCapabilityCatalogue).length).toBeGreaterThan(500);
  });

  it('keeps target management and coordinated activation outside the client catalogue', () => {
    expect.assertions(5);

    expect(cdpCapabilityCatalogue).not.toHaveProperty('Target.attachToTarget');
    expect(cdpCapabilityCatalogue).not.toHaveProperty('Network.enable');
    expect(cdpCapabilityCatalogue).not.toHaveProperty('Network.disable');
    expect(cdpKernelOwnedNames).toContain('Target.attachToTarget');
    expect(cdpKernelOwnedNames).toContain('Network.enable');
  });

  it('records the pinned source and Chrome debugger domain scope', () => {
    expect.assertions(4);

    expect(cdpCatalogueMetadata.devtoolsProtocolVersion).toBe('0.0.1672245');
    expect(cdpCatalogueMetadata.protocolVersion).toBe('1.3');
    expect(cdpCatalogueMetadata.supportedDomains).toContain('Target');
    expect(cdpCatalogueMetadata.absentSupportedDomains).toEqual(['Database']);
  });
});
