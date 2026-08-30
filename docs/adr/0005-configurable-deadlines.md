# ADR-0005: Configure deadlines at module construction

## Context

Embedding environments have different security windows and long-running workloads. Hard-coded
deadlines make the primitive brittle; hidden global settings make compositions difficult to reason
about.

## Decision

Each module exposes a typed policy for the timers it owns and immutable defaults. Deadline values use
milliseconds: positive numbers schedule expiry, `0` expires immediately, and `null` disables expiry.
Overrides are validated when the module is constructed.

## Consequences

- Long-running connected sessions do not expire from inactivity.
- Consumers may deliberately disable security expiries and accept the resulting risk.
- Tests can exercise finite, immediate, and disabled behavior without global clock settings.
