# ADR-0003: Focused transport-neutral adapters

## Context

Embedding the generic broker wiring repeatedly in each consumer creates drift, while moving process,
platform, consent, or UI policy into CDB would make the public primitive product-specific.

## Decision

CDB owns focused adapters for client connections, provider connections, logical sessions, agent tool
sessions, leases, and automation execution. Consumers retain process lifecycle, authenticated
principal creation, platform APIs, consent and navigation policy, UI, and auditing.

## Consequences

- Consumers need one narrow integration facade instead of custom protocol wiring.
- CDB remains independent of application processes and browser-platform policy.
- New transports compose against the same authority and lifecycle contracts.
