import { expect, it } from 'vitest';

import * as bootstrapModule from '../src/bootstrap.js';
import * as indexModule from '../src/index.js';
import * as testingModule from '../src/testing.js';

it('keeps the extension public entries importable', () => {
  expect.assertions(3);
  expect(Object.keys(indexModule)).toEqual(['sendAgentHeartbeat', 'createAgentRecovery', 'createApprovalChannel', 'createExtensionApprovalSenderValidator', 'createBirpcAgentBootstrap', 'createBirpcOfferContentRelay', 'installBirpcOfferRuntimeHandler', 'parseBirpcConnectionOffer', 'createBrokerTabAssignment', 'createChildSessionRouter', 'createIndexedDbPairingStore', 'createSelectedTabLifecycle', 'createSelectedTabPublisher', 'createTabScopeLifecycle', 'createTabScopeManager', 'matchesTabScope', 'parseTabScopeSelector']);
  expect(Object.keys(bootstrapModule)).toEqual(['parseBirpcConnectionOffer', 'createBirpcOfferContentRelay', 'createBirpcAgentBootstrap', 'installBirpcOfferRuntimeHandler']);
  expect(Object.keys(testingModule)).toEqual([]);
});
