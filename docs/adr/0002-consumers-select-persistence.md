# ADR-0002: Consumers select persistence

## Context

Filesystem, database, and browser storage choices have different latency, durability, deployment, and
security costs. A library setting would introduce storage-specific branches and I/O into the default
path.

## Decision

Both public stores default to in-memory implementations. Persistence is supplied only by dependency
injection through the same contracts; CDB does not select or configure a persistence technology.

## Consequences

- The default has no storage I/O.
- Consumers own persistence performance and restart-recovery tradeoffs.
- Persistent recovery still starts a fresh authenticated connection generation and never restores
  in-flight resources.
