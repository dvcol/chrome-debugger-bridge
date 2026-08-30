# ADR-0004: Bind authority to target generations

## Context

A stable target ID can refer to a recovered debugger attachment or a navigated document. Target-only
permission could authorize work against a replacement that the principal never received.

## Decision

Every authority binding names an exact target ID and target generation. A generation change fences
old bindings immediately. Accepted continuity creates replacement bindings with new binding IDs.
Overlapping bindings resolve to the maximum level and canonical sorted method union.

## Consequences

- Every target operation must carry and validate the exact generation.
- Individual revocation deterministically recalculates remaining authority.
- Stable agent-facing `tN` references can survive renewal without weakening broker checks.
