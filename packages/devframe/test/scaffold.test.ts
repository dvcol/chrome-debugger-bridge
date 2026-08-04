import { expect, it } from 'vitest';

import * as clientModule from '../src/client.js';
import * as nodeModule from '../src/node.js';

it('keeps the Devframe scaffold importable', () => {
  expect.assertions(2);
  expect(Object.keys(clientModule)).toEqual(['createDevframeBridgeClient']);
  expect(Object.keys(nodeModule)).toEqual([]);
});
