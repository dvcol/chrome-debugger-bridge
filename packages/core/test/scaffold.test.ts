import { expect, it } from 'vitest';

import * as brokerModule from '../src/broker.js';
import * as clientModule from '../src/client.js';
import * as indexModule from '../src/index.js';
import * as protocolModule from '../src/protocol.js';
import * as testingModule from '../src/testing.js';

it('keeps the core scaffold importable', () => {
  expect.assertions(5);
  expect(Object.keys(indexModule)).toEqual(expect.arrayContaining(Object.keys(protocolModule)));
  expect(Object.keys(brokerModule)).toEqual([]);
  expect(Object.keys(clientModule)).toEqual([]);
  expect(Object.keys(protocolModule)).not.toEqual([]);
  expect(Object.keys(testingModule)).toEqual([]);
});
