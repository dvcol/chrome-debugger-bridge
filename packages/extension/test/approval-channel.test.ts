import type { TabScopeSelector } from '../src/tab-scope.js';

import { expect, it } from 'vitest';

import { createApprovalChannel, createExtensionApprovalSenderValidator } from '../src/approval-channel.js';

const requestId = '10000000-0000-4000-8000-000000000001';

it('lets page callers request presentation without accepting their approval decisions', async () => {
  expect.assertions(4);
  const delivered: string[] = [];
  const channel = createApprovalChannel({
    isTrustedSender: createExtensionApprovalSenderValidator({ extensionId: 'extension-id', allowedDocumentUrls: ['chrome-extension://extension-id/approval.html'] }),
    onApprove() {
      delivered.push('approved');
    },
    onDeny() {
      delivered.push('denied');
    },
    onRequest() {
      delivered.push('requested');
    },
  });
  const pageSender = { id: 'extension-id', tab: { id: 42 }, url: 'https://example.com/' };
  expect(await channel.receive({ kind: 'cdb.approval.request', requestId }, pageSender)).toEqual({ ok: true });
  expect(await channel.receive({ kind: 'cdb.approval.approve', requestId, selector: { kind: 'explicit-tabs', tabIds: [42] } }, pageSender)).toEqual({ code: 'APPROVAL_SOURCE_UNTRUSTED', ok: false });
  expect(await channel.receive({ kind: 'cdb.approval.deny', requestId }, pageSender)).toEqual({ code: 'APPROVAL_SOURCE_UNTRUSTED', ok: false });
  expect(delivered).toEqual(['requested']);
});

it('accepts a validated selection from an explicitly trusted extension view', async () => {
  expect.assertions(4);
  const approved: { requestId: string; selector: TabScopeSelector }[] = [];
  const denied: string[] = [];
  const channel = createApprovalChannel({
    isTrustedSender: createExtensionApprovalSenderValidator({ extensionId: 'extension-id', allowedDocumentUrls: ['chrome-extension://extension-id/approval.html'] }),
    onApprove(id, selector) {
      approved.push({ requestId: id, selector });
    },
    onDeny(id) {
      denied.push(id);
    },
    onRequest() {},
  });
  const sender = { id: 'extension-id', origin: 'chrome-extension://extension-id', url: 'chrome-extension://extension-id/approval.html' };
  expect(await channel.receive({ kind: 'cdb.approval.approve', requestId, selector: { groupId: 3, kind: 'group' } }, sender)).toEqual({ ok: true });
  expect(approved).toEqual([{ requestId, selector: { groupId: 3, kind: 'group' } }]);
  expect(await channel.receive({ kind: 'cdb.approval.deny', requestId }, sender)).toEqual({ ok: true });
  expect(denied).toEqual([requestId]);
});

it('rejects malformed authority fields and extension views embedded in a controlled tab', async () => {
  expect.assertions(7);
  const approved: string[] = [];
  const channel = createApprovalChannel({
    isTrustedSender: createExtensionApprovalSenderValidator({ extensionId: 'extension-id', allowedDocumentUrls: ['chrome-extension://extension-id/approval.html'] }),
    onApprove(id) {
      approved.push(id);
    },
    onDeny() {},
    onRequest() {},
  });
  const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/approval.html' };
  const decision = { kind: 'cdb.approval.approve', requestId, selector: { kind: 'explicit-tabs', tabIds: [42] } };
  expect(await channel.receive({ ...decision, principalId: 'supplied-principal' }, sender)).toEqual({ code: 'APPROVAL_MESSAGE_INVALID', ok: false });
  expect(await channel.receive({ ...decision, selector: { kind: 'explicit-tabs', tabIds: [-1] } }, sender)).toEqual({ code: 'APPROVAL_MESSAGE_INVALID', ok: false });
  expect(await channel.receive({ ...decision, requestId: 'unknown' }, sender)).toEqual({ code: 'APPROVAL_MESSAGE_INVALID', ok: false });
  expect(await channel.receive(decision, { ...sender, tab: { id: 42 } })).toEqual({ code: 'APPROVAL_SOURCE_UNTRUSTED', ok: false });
  expect(await channel.receive(decision, { ...sender, id: 'another-extension' })).toEqual({ code: 'APPROVAL_SOURCE_UNTRUSTED', ok: false });
  expect(await channel.receive(decision, { ...sender, url: `${sender.url}?page-controlled` })).toEqual({ code: 'APPROVAL_SOURCE_UNTRUSTED', ok: false });
  expect(approved).toEqual([]);
});
