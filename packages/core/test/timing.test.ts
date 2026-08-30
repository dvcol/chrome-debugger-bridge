import { afterEach, describe, expect, it, vi } from 'vitest';

import { scheduleTimeout, validateTimeoutMilliseconds } from '../src/timing.js';

afterEach(() => vi.useRealTimers());

describe('configurable timeouts', () => {
  it('accepts finite, immediate, and disabled deadlines', () => {
    expect.assertions(3);
    expect(validateTimeoutMilliseconds(10, 'timeout')).toBe(10);
    expect(validateTimeoutMilliseconds(0, 'timeout')).toBe(0);
    expect(validateTimeoutMilliseconds(null, 'timeout')).toBeNull();
  });

  it('does not schedule a disabled deadline', () => {
    expect.assertions(2);
    vi.useFakeTimers();
    const callback = vi.fn();

    expect(scheduleTimeout(callback, null)).toBeUndefined();
    vi.runAllTimers();
    expect(callback).not.toHaveBeenCalled();
  });
});
