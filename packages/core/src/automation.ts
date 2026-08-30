import type {
  CapabilityGrant,
  JsonObject,
  PublishedTarget,
} from './protocol.js';

export type AutomationSnapshotMode = 'accessibility' | 'dom' | 'interactive';

export interface AutomationTextMatcher {
  readonly exact?: boolean;
  readonly pattern?: string;
  readonly regex?: {
    readonly flags?: string;
    readonly source: string;
  };
}

export interface AutomationLocatorStrategy {
  readonly altText?: AutomationTextMatcher;
  readonly css?: string;
  readonly label?: AutomationTextMatcher;
  readonly name?: AutomationTextMatcher;
  readonly placeholder?: AutomationTextMatcher;
  readonly role?: string;
  readonly testId?: AutomationTextMatcher;
  readonly text?: AutomationTextMatcher;
  readonly title?: AutomationTextMatcher;
  readonly xpath?: string;
}

export interface AutomationLocator extends AutomationLocatorStrategy {
  readonly descendants?: readonly AutomationLocatorStrategy[];
  readonly exclude?: AutomationLocatorStrategy;
  readonly frameChain?: readonly AutomationLocatorStrategy[];
  readonly has?: AutomationLocatorStrategy;
  readonly hasNotText?: AutomationTextMatcher;
  readonly hasText?: AutomationTextMatcher;
  readonly nth?: number;
  readonly visible?: boolean;
}

export type AutomationActionName
  = | 'check'
    | 'click'
    | 'drag'
    | 'fill'
    | 'focus'
    | 'hover'
    | 'press'
    | 'scroll-into-view'
    | 'select-option'
    | 'type'
    | 'uncheck';

export type AutomationOperation
  = | {
    readonly kind: 'action';
    readonly action: AutomationActionName;
    readonly destinationElementHandleId?: string;
    readonly destinationLocator?: AutomationLocator;
    readonly elementHandleId?: string;
    readonly locator?: AutomationLocator;
    readonly options?: JsonObject;
  }
  | {
    readonly kind: 'find';
    readonly locator: AutomationLocator;
    readonly maximumMatches: number;
  }
  | {
    readonly kind: 'inspect';
    readonly elementHandleId?: string;
    readonly include: readonly ('accessibility' | 'attributes' | 'geometry')[];
    readonly locator?: AutomationLocator;
  }
  | {
    readonly kind: 'snapshot';
    readonly maximumDepth: number;
    readonly maximumNodes: number;
    readonly mode: AutomationSnapshotMode;
  };

export interface AutomationProviderCapabilities {
  readonly actions: readonly AutomationActionName[];
  readonly locatorDialects?: readonly string[];
  readonly operations: readonly AutomationOperation['kind'][];
  readonly snapshotModes: readonly AutomationSnapshotMode[];
}

export interface AutomationProviderDescriptor {
  readonly capabilities: AutomationProviderCapabilities;
  readonly id: string;
  readonly version: string;
}

export interface AutomationProviderElement {
  readonly handle: string;
  readonly metadata?: JsonObject;
}

export interface AutomationProviderResult {
  readonly elements?: readonly AutomationProviderElement[];
  readonly snapshotId?: string;
  readonly value: JsonObject;
}

export type AutomationProviderErrorCode
  = | 'AUTOMATION_ACTION_OUTCOME_UNKNOWN'
    | 'AUTOMATION_ELEMENT_COVERED'
    | 'AUTOMATION_ELEMENT_DETACHED'
    | 'AUTOMATION_ELEMENT_DISABLED'
    | 'AUTOMATION_ELEMENT_HIDDEN'
    | 'AUTOMATION_ELEMENT_NOT_EDITABLE'
    | 'AUTOMATION_ELEMENT_UNSTABLE'
    | 'AUTOMATION_LOCATOR_AMBIGUOUS'
    | 'AUTOMATION_LOCATOR_NOT_FOUND'
    | 'AUTOMATION_PROVIDER_FAILED';

export class AutomationProviderError extends Error {
  constructor(
    readonly code: AutomationProviderErrorCode,
    message: string,
    readonly details?: JsonObject,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface AutomationCdpEvent {
  readonly method: string;
  readonly parameters: JsonObject;
  readonly sessionId?: string;
}

export interface AutomationProviderExecutionContext {
  readonly abortSignal: AbortSignal;
  readonly principalId: string;
  readonly target: PublishedTarget;
  executeCdp: (
    method: string,
    parameters?: JsonObject,
    sessionId?: string,
  ) => Promise<JsonObject>;
  onCdpEvent: (listener: (event: AutomationCdpEvent) => void) => () => void;
  setDomainDemand: (
    domain: string,
    active: boolean,
    sessionId?: string,
  ) => Promise<void>;
}

export interface AutomationProviderRequest {
  readonly operation: AutomationOperation;
  readonly operationId: string;
}

export interface AutomationProvider {
  readonly descriptor: AutomationProviderDescriptor;
  dispose: () => void | Promise<void>;
  execute: (
    request: AutomationProviderRequest,
    context: AutomationProviderExecutionContext,
  ) => Promise<AutomationProviderResult>;
  invalidateTarget?: (
    target: Pick<PublishedTarget, 'generation' | 'id'>,
  ) => void | Promise<void>;
}

export interface AutomationExecutionRequest {
  readonly leaseId: string;
  readonly operation: AutomationOperation;
  readonly operationId: string;
  readonly targetGeneration: number;
  readonly targetId: string;
}

export interface AutomationElementHandle {
  readonly id: string;
  readonly metadata?: JsonObject;
}

export interface AutomationExecutionMetrics {
  readonly cdbTransportDurationMilliseconds: number;
  readonly cdpCommandCount: number;
  readonly chromeDurationMilliseconds: number;
  readonly providerDurationMilliseconds: number;
  readonly totalDurationMilliseconds: number;
}

export interface AutomationExecutionResult {
  readonly elements?: readonly AutomationElementHandle[];
  readonly metrics: AutomationExecutionMetrics;
  readonly operationId: string;
  readonly provider: AutomationProviderDescriptor;
  readonly snapshotId?: string;
  readonly value: JsonObject;
}

export function requiredAutomationLevel(
  operation: AutomationOperation,
): NonNullable<CapabilityGrant['level']> {
  if (operation.kind === 'action') return 'interact';
  if (operation.kind === 'inspect') return 'inspect';
  return 'observe';
}
