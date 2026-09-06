import type { TabScopeSelector } from './tab-scope.js';

import { parseTabScopeSelector } from './tab-scope.js';

const requestIdentifierPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ApprovalChannelOptions<Sender> {
  /** Authenticate browser/host-supplied sender metadata. Page payloads, DOM markers and event.isTrusted are not approval credentials. */
  readonly isTrustedSender: (sender: Sender) => boolean;
  /** The host claims the pending request and grants its original level/principal to the validated selection. */
  readonly onApprove: (requestId: string, selector: TabScopeSelector, sender: Sender) => Promise<void> | void;
  readonly onDeny: (requestId: string, sender: Sender) => Promise<void> | void;
  /** Presentation intent only. This callback must never create authority or register an auto-grant. */
  readonly onRequest: (requestId: string, sender: Sender) => Promise<void> | void;
}

export type ApprovalChannelResult = { readonly ok: true } | { readonly code: 'APPROVAL_MESSAGE_INVALID' | 'APPROVAL_SOURCE_UNTRUSTED'; readonly ok: false };

export interface ApprovalChannel<Sender> {
  receive: (message: unknown, sender: Sender) => Promise<ApprovalChannelResult>;
}

export interface ExtensionApprovalSender {
  readonly id?: string;
  readonly origin?: string;
  readonly tab?: unknown;
  readonly url?: string;
}

export interface ExtensionApprovalSenderValidatorOptions {
  readonly allowedDocumentUrls: readonly string[];
  readonly extensionId: string;
}

/** Trusts explicitly listed extension-owned views outside tabs, using runtime MessageSender metadata supplied by the host. */
export function createExtensionApprovalSenderValidator(options: ExtensionApprovalSenderValidatorOptions): (sender: ExtensionApprovalSender) => boolean {
  const documents = new Map(options.allowedDocumentUrls.map((value) => {
    const url = new URL(value);
    if (!['chrome-extension:', 'moz-extension:'].includes(url.protocol) || url.username || url.password)
      throw new TypeError('Approval documents must be extension URLs.');
    return [url.href, `${url.protocol}//${url.host}`];
  }));
  if (options.extensionId.length === 0 || documents.size === 0) throw new TypeError('Approval requires an extension identity and at least one document URL.');
  return sender => sender.id === options.extensionId
    && sender.tab === undefined
    && sender.url !== undefined
    && documents.has(sender.url)
    && (sender.origin === undefined || sender.origin === documents.get(sender.url));
}

/** Validates request-only page intents and separately authenticates authority-bearing host UI decisions. */
export function createApprovalChannel<Sender>(options: ApprovalChannelOptions<Sender>): ApprovalChannel<Sender> {
  return {
    async receive(message, sender) {
      if (message === null || typeof message !== 'object' || Array.isArray(message)) return { code: 'APPROVAL_MESSAGE_INVALID', ok: false };
      const input = message as Record<string, unknown>;
      if (typeof input.requestId !== 'string' || !requestIdentifierPattern.test(input.requestId))
        return { code: 'APPROVAL_MESSAGE_INVALID', ok: false };
      if (!['cdb.approval.request', 'cdb.approval.approve', 'cdb.approval.deny'].includes(input.kind as string)
        || Object.keys(input).some(key => !['kind', 'requestId', ...(input.kind === 'cdb.approval.approve' ? ['selector'] : [])].includes(key)))
        return { code: 'APPROVAL_MESSAGE_INVALID', ok: false };
      if (input.kind === 'cdb.approval.request') {
        await options.onRequest(input.requestId, sender);
        return { ok: true };
      }
      if (!options.isTrustedSender(sender)) return { code: 'APPROVAL_SOURCE_UNTRUSTED', ok: false };
      if (input.kind === 'cdb.approval.deny') {
        await options.onDeny(input.requestId, sender);
        return { ok: true };
      }
      const selector = parseTabScopeSelector(input.selector);
      if (selector === undefined) return { code: 'APPROVAL_MESSAGE_INVALID', ok: false };
      await options.onApprove(input.requestId, selector, sender);
      return { ok: true };
    },
  };
}
