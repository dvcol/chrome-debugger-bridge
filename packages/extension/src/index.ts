export { type HeartbeatAgentConnection, sendAgentHeartbeat } from './agent-heartbeat.js';
export { type AgentRecovery, type AgentRecoveryState, createAgentRecovery, type CreateAgentRecoveryOptions, type RecoverableAgentConnection } from './agent-recovery.js';
export {
  type ApprovalChannel,
  type ApprovalChannelOptions,
  type ApprovalChannelResult,
  createApprovalChannel,
  createExtensionApprovalSenderValidator,
  type ExtensionApprovalSender,
  type ExtensionApprovalSenderValidatorOptions,
} from './approval-channel.js';
export {
  type BirpcAgentBootstrap,
  type BirpcConnectionOffer,
  type BirpcOfferContentRelay,
  type BirpcOfferLocator,
  type BirpcOfferPairingPolicy,
  type BirpcOfferRuntimeMessage,
  type BirpcRuntimeMessagePort,
  createBirpcAgentBootstrap,
  type CreateBirpcAgentBootstrapOptions,
  createBirpcOfferContentRelay,
  type CreateBirpcOfferContentRelayOptions,
  installBirpcOfferRuntimeHandler,
  type InstalledBirpcOfferRuntimeHandler,
  parseBirpcConnectionOffer,
} from './bootstrap.js';
export { type BrokerTabAssignment, type BrokerTabPublisher, createBrokerTabAssignment } from './broker-tab-assignment.js';
export { type ChildSessionRouter, createChildSessionRouter, type PublicChildSession } from './child-session-router.js';
export {
  createIndexedDbPairingStore,
  type CreateIndexedDbPairingStoreOptions,
  type IndexedDbPairingStore,
  type StoredBrokerPairing,
} from './pairing-store.js';
export {
  type ChromeSelectedTabLifecyclePort,
  createSelectedTabLifecycle,
  type SelectedTabLifecycle,
  type SelectedTabLifecycleOptions,
} from './selected-tab-lifecycle.js';
export {
  type ChromeDebuggerPort,
  type CommandAuthorizationContext,
  type CommandAuthorizationPolicy,
  createSelectedTabPublisher,
  type SelectedTab,
  type SelectedTabPublisher,
  type SelectedTabPublisherOptions,
} from './selected-tab-publisher.js';
export {
  type ChromeTabScopeLifecyclePort,
  createTabScopeLifecycle,
  type TabScopeLifecycle,
  type TabScopeLifecycleOptions,
} from './tab-scope-lifecycle.js';
export { createTabScopeManager, type TabScopeManager, type TabScopeManagerOptions } from './tab-scope-manager.js';
export { matchesTabScope, parseTabScopeSelector, type TabScopeSelector } from './tab-scope.js';
