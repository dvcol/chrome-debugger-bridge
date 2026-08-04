import { expect, it } from 'vitest';

import * as bootstrapModule from '../src/bootstrap.js';
import * as indexModule from '../src/index.js';
import * as testingModule from '../src/testing.js';

it('keeps the extension scaffold importable', () => {
  expect.assertions(3);
  expect(Object.keys(indexModule)).toEqual(['createIndexedDbPairingStore', 'createSelectedTabPublisher']);
  expect(Object.keys(bootstrapModule)).toEqual([]);
  expect(Object.keys(testingModule)).toEqual([]);
});
