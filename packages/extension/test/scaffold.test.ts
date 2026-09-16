import { expect, it } from 'vitest';

import * as bootstrapModule from '../src/bootstrap.js';
import * as indexModule from '../src/index.js';
import * as testingModule from '../src/testing.js';

it('keeps the extension public entries importable', () => {
  expect.assertions(3);
  expect(Object.keys(indexModule)).toEqual(['sendAgentHeartbeat', 'defineRecovery', 'createAgentRecovery', 'defineApproval', 'defineApprovalSender', 'createApprovalChannel', 'createExtensionApprovalSenderValidator', 'defineBootstrap', 'defineOfferRelay', 'createBirpcAgentBootstrap', 'createBirpcOfferContentRelay', 'installBirpcOfferRuntimeHandler', 'parseBirpcConnectionOffer', 'createBrokerTabAssignment', 'createChildSessionRouter', 'definePairingStore', 'createIndexedDbPairingStore', 'defineSelectedTab', 'createSelectedTabLifecycle', 'definePublisher', 'createSelectedTabPublisher', 'defineTabLifecycle', 'createTabScopeLifecycle', 'defineTabScope', 'createTabScopeManager', 'matchesTabScope', 'parseTabScopeSelector', 'definePageRequest', 'createPageRequestBridge']);
  expect(Object.keys(bootstrapModule)).toEqual(['parseBirpcConnectionOffer', 'createBirpcOfferContentRelay', 'createBirpcAgentBootstrap', 'installBirpcOfferRuntimeHandler', 'defineBootstrap', 'defineOfferRelay']);
  expect(Object.keys(testingModule)).toEqual([]);
});
