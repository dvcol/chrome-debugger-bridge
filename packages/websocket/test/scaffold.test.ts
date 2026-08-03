import { expect, it } from 'vitest';

import * as browserModule from '../src/browser.js';
import * as nodeModule from '../src/node.js';
import * as testingModule from '../src/testing.js';

it('keeps the WebSocket scaffold importable', () => {
  expect.assertions(3);
  expect(Object.keys(browserModule)).toEqual([]);
  expect(Object.keys(nodeModule)).toEqual([]);
  expect(Object.keys(testingModule)).toEqual([]);
});
