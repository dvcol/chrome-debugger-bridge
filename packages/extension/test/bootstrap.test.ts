import type { DevframeConnectionOffer } from '../src/bootstrap.js';

import { expect, it, vi } from 'vitest';

import {
  createDevframeAgentBootstrap,
  createDevframeOfferContentRelay,
  installDevframeOfferRuntimeHandler,
  parseDevframeConnectionOffer,
} from '../src/bootstrap.js';

const offer = {
  brokerId: '43450636-2b75-4133-a137-c9907dde3c44',
  display: { title: 'Devframe bridge' },
  endpoint: 'wss://bridge.example.test/devframe-agent',
  expiresAt: '2030-01-01T00:01:00.000Z',
  nonce: '4b5380d0-c30b-42c1-8990-8250c5e6a6fa',
  protocolVersions: { maximum: 1, minimum: 1 },
} satisfies DevframeConnectionOffer;

it('validates a non-secret connection offer and rejects reusable authority fields', () => {
  expect.assertions(3);
  expect(parseDevframeConnectionOffer(offer)).toEqual(offer);
  expect(parseDevframeConnectionOffer({ ...offer, endpoint: 'wss://token@bridge.example.test/agent' })).toBeUndefined();
  expect(parseDevframeConnectionOffer({ ...offer, credential: 'secret' })).toBeUndefined();
});

it('removes the service-worker runtime listener after bootstrap disposal', async () => {
  expect.assertions(4);
  let listener: ((message: unknown) => void) | undefined;
  const bootstrap = createDevframeAgentBootstrap({
    async connect() {
      return { connected: true };
    },
    locator: { async locate(candidate) {
      return candidate;
    } },
    pairingPolicy: { async approve() {
      return true;
    } },
  });
  const handler = installDevframeOfferRuntimeHandler({
    addListener(candidate) {
      listener = candidate;
    },
    removeListener(candidate) {
      expect(candidate).toBe(listener);
      listener = undefined;
    },
  }, bootstrap);
  expect(listener).toBeDefined();
  listener?.({ kind: 'chrome-debugger-bridge.devframe-offer', offer, origin: 'https://devframe.example.test' });
  await Promise.resolve();
  handler.dispose();
  expect(listener).toBeUndefined();
  handler.dispose();
  expect(listener).toBeUndefined();
});

it('relays one valid page offer from its configured origin and source only', async () => {
  expect.assertions(5);
  const pageWindow = {} as MessageEventSource;
  const removedListeners: Array<(event: MessageEvent<unknown>) => void> = [];
  const postRuntimeMessage = vi.fn(async () => {});
  const relay = createDevframeOfferContentRelay({
    allowedOrigin: 'https://devframe.example.test',
    postRuntimeMessage,
    removeWindowMessageListener(listener) {
      removedListeners.push(listener);
    },
    windowSource: pageWindow,
  });

  relay.receive({ data: offer, origin: 'https://other.example.test', source: pageWindow } as MessageEvent<unknown>);
  relay.receive({ data: offer, origin: 'https://devframe.example.test', source: {} as MessageEventSource } as MessageEvent<unknown>);
  expect(postRuntimeMessage).not.toHaveBeenCalled();
  relay.receive({ data: { malformed: true }, origin: 'https://devframe.example.test', source: pageWindow } as MessageEvent<unknown>);
  expect(postRuntimeMessage).not.toHaveBeenCalled();
  relay.receive({ data: offer, origin: 'https://devframe.example.test', source: pageWindow } as MessageEvent<unknown>);
  await Promise.resolve();
  expect(postRuntimeMessage).toHaveBeenCalledWith({ kind: 'chrome-debugger-bridge.devframe-offer', offer, origin: 'https://devframe.example.test' });
  expect(removedListeners).toEqual([relay.receive]);
  relay.receive({ data: offer, origin: 'https://devframe.example.test', source: pageWindow } as MessageEvent<unknown>);
  expect(postRuntimeMessage).toHaveBeenCalledTimes(1);
});

it('rejects malformed, expired, replayed, and unapproved offers before opening direct transport', async () => {
  expect.assertions(9);
  const locator = { locate: vi.fn(async (candidate: DevframeConnectionOffer) => candidate) };
  const pairingPolicy = { approve: vi.fn(async () => true) };
  const connect = vi.fn(async () => ({ connected: true }));
  const bootstrap = createDevframeAgentBootstrap({ connect, locator, now: () => Date.parse('2030-01-01T00:00:00.000Z'), pairingPolicy });
  expect(await bootstrap.accept({ kind: 'chrome-debugger-bridge.devframe-offer', offer: { malformed: true }, origin: 'https://devframe.example.test' })).toBeUndefined();
  expect(locator.locate).not.toHaveBeenCalled();
  expect(await bootstrap.accept({ kind: 'chrome-debugger-bridge.devframe-offer', offer: { ...offer, expiresAt: '2029-12-31T23:59:59.000Z', nonce: '0111e50c-7f21-4f88-83fe-75e70850a1a4' }, origin: 'https://devframe.example.test' })).toBeUndefined();
  expect(await bootstrap.accept({ kind: 'chrome-debugger-bridge.devframe-offer', offer, origin: 'https://devframe.example.test' })).toEqual({ connected: true });
  expect(connect).toHaveBeenCalledWith(offer);
  expect(await bootstrap.accept({ kind: 'chrome-debugger-bridge.devframe-offer', offer, origin: 'https://devframe.example.test' })).toBeUndefined();
  expect(connect).toHaveBeenCalledTimes(1);
  bootstrap.dispose();
  expect(await bootstrap.accept({ kind: 'chrome-debugger-bridge.devframe-offer', offer: { ...offer, nonce: 'b3ebf798-90e3-45e8-9665-3a9939c74883' }, origin: 'https://devframe.example.test' })).toBeUndefined();
  expect(pairingPolicy.approve).toHaveBeenCalledWith(offer, 'https://devframe.example.test');
});
