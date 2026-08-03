import { expect, it } from 'vitest';

import * as indexModule from '../src/index.js';

it('keeps the MCP scaffold importable', () => {
  expect.assertions(1);
  expect(Object.keys(indexModule)).toEqual([]);
});
