export type TimeoutMilliseconds = number | null;

/** Validates a configurable timeout. Zero expires immediately and null disables the timer. */
export function validateTimeoutMilliseconds(value: TimeoutMilliseconds, name: string): TimeoutMilliseconds {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`${name} must be a non-negative safe integer or null.`);
  }
  return value;
}

/** Schedules a configurable timeout. A disabled timeout has no handle to clean up. */
export function scheduleTimeout(
  callback: () => void,
  timeoutMilliseconds: TimeoutMilliseconds,
): ReturnType<typeof setTimeout> | undefined {
  return timeoutMilliseconds === null ? undefined : setTimeout(callback, timeoutMilliseconds);
}
