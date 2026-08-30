# ADR-0006: Treat session metadata as generic JSON

## Context

Embedding hosts need to correlate a logical session with product-specific launch or audit context.
Giving CDB knowledge of those fields would couple the primitive to downstream policy and could turn
untrusted metadata into implicit authority.

## Decision

Logical-session creation accepts optional `JsonValue` metadata. CDB validates JSON compatibility,
stores the value, and never interprets it for authentication or authorization.

## Consequences

- Hosts can correlate sessions without extending the public protocol for each product.
- Trusted adapters must derive authority from their own authenticated or platform sources.
- Metadata remains diagnostic context, not a capability token.
