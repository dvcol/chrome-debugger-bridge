import { describe, expect, it, vi } from 'vitest';

import { defineApprovalSender } from '../src/approval-channel.js';
import { defineProvider } from '../src/chrome.js';
import { createSelectedTabPublisher, definePublisher } from '../src/selected-tab-publisher.js';

describe('configuration definitions', () => {
  it('preserves provider configuration and callback types without touching Chrome', () => {
    expect.assertions(4);
    const connect = vi.fn();
    const authorizeApproval = vi.fn((_request: unknown, _selector: unknown, context: { accepted: boolean }) => context.accepted);
    const configuration = { connect, authorizeApproval, maximumLevel: 'interact' as const };
    const definition = defineProvider<{ accepted: boolean }, typeof configuration>(configuration);
    expect(definition).toBe(configuration);
    expect(definition.maximumLevel).toBe('interact');
    expect(connect).not.toHaveBeenCalled();
    expect(authorizeApproval).not.toHaveBeenCalled();
  });

  it('rejects invalid bounds equally before the publisher touches its dependencies', () => {
    expect.assertions(2);
    const options = { maximumResultBytes: 0 } as Parameters<typeof createSelectedTabPublisher>[0];
    expect(() => definePublisher(options)).toThrow('maximumResultBytes must be a positive safe integer.');
    expect(() => createSelectedTabPublisher(options)).toThrow('maximumResultBytes must be a positive safe integer.');
  });

  it('preserves supported extension URL schemes and rejects web documents', () => {
    expect.assertions(3);
    for (const protocol of ['chrome-extension:', 'moz-extension:']) {
      const configuration = { extensionId: 'extension', allowedDocumentUrls: [`${protocol}//extension/popup.html`] };
      expect(defineApprovalSender(configuration)).toBe(configuration);
    }
    expect(() => defineApprovalSender({ extensionId: 'extension', allowedDocumentUrls: ['https://example.com'] })).toThrow('Approval documents must be extension URLs.');
  });
});
