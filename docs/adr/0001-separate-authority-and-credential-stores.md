# ADR-0001: Separate authority and credential stores

## Context

Logical-session recovery needs broker-side authority and a client-side raw resume credential. Putting
both in one store would collapse two trust boundaries and make it easy to expose bearer material with
diagnostic authority state.

## Decision

Expose `AuthorityStore` from `@dvcol/cdb/authority` and `CredentialStore` from
`@dvcol/cdb/session`. The authority record contains only the credential hash. The raw credential stays
below model-facing tools.

## Consequences

- The contracts share asynchronous Store conventions but remain independently injectable.
- A consumer may implement both over the same storage technology without combining their records.
- Resume coordination must update both sides after credential rotation.
