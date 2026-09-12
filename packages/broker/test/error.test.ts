import { expect, it } from 'vitest';

import { BrokerError, browserControlToolError, normalizeBrowserControlError } from '../src/error.js';

it('preserves arbitrary protocol codes, retry delays and uncertain dispatch details', () => {
  expect.assertions(2);
  const failure = { code: 'MCP_ACTION_OUTCOME_UNKNOWN', message: 'Input may have dispatched', retryable: false, details: { dispatched: true, outcome: 'uncertain' } };
  expect(normalizeBrowserControlError(Object.assign(new Error(failure.message), failure))).toEqual(failure);
  expect(normalizeBrowserControlError({ code: 'FUTURE_RECOVERABLE_ERROR', message: 'Try later', retryable: true, retryAfterMs: 10 })).toEqual({ code: 'FUTURE_RECOVERABLE_ERROR', message: 'Try later', retryable: true, retryAfterMilliseconds: 10 });
});

it('inspects semantic failures while leaving successful text payloads alone', () => {
  expect.assertions(4);
  const failure = { code: 'MCP_LOCATOR_NOT_FOUND', message: 'Not found', retryable: true };
  const content = [{ type: 'text', text: JSON.stringify(failure) }];
  expect(browserControlToolError({ content })).toBeUndefined();
  expect(browserControlToolError({ content, isError: true })).toEqual(failure);
  expect(browserControlToolError({ content: [{ type: 'text', text: 'Unstructured' }], isError: true })).toEqual({ code: 'CDB_OPERATION_FAILED', message: 'The browser tool failed.', retryable: false });
  expect(normalizeBrowserControlError('Failed')).toEqual({ code: 'CDB_OPERATION_FAILED', message: 'Failed', retryable: false });
});

it('retains the local exception cause while serializing only public error data', () => {
  expect.assertions(4);
  const cause = new Error('Private storage path and implementation detail');
  const error = new BrokerError('STORAGE_FAILED', 'Could not save the grant.', true, 20, { operation: 'save' }, { cause });
  expect(error).toBeInstanceOf(Error);
  expect(error.cause).toBe(cause);
  expect(normalizeBrowserControlError(error)).toEqual({ code: 'STORAGE_FAILED', message: 'Could not save the grant.', retryable: true, retryAfterMilliseconds: 20, details: { operation: 'save' } });
  expect(JSON.stringify(normalizeBrowserControlError(error))).not.toContain(cause.message);
});
