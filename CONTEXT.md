# CDB domain glossary

## Authority Binding

A revocable permission connecting one logical session and principal to one exact target generation,
access level, and allowed-method set. Avoid: grant snapshot, tab permission.

## Authority Store

The broker-side source of logical-session authority and hashed resume credentials. It is reactive and
fail-closed. Avoid: credential store, settings store.

## Credential Store

The client-side store for raw opaque resume credentials below model-facing tools. Avoid: authority
store, resume credential store.

## Logical Session

A principal-scoped tool session that can outlive and fence individual transport connections. It owns
stable target references but not in-flight operations. Avoid: socket session, MCP process.

## Connection Generation

A monotonically increasing fencing epoch for replacement logical-session or provider connections.
Avoid: target generation, reconnect count.

## Target Generation

The authority epoch for one publication of a stable target. Every target operation must match it
exactly. Avoid: page revision, DOM generation.

## Stable Target Reference

An agent-facing `tN` identifier for one authorized target within a logical session. It may survive a
target-generation change or session resume. Avoid: target ID, element reference.

## Element Reference

A disposable `eN` identifier bound to one snapshot, target generation, frame, and backend node. Avoid:
locator, stable target reference.

## Lease

Short-lived coordination for commands already permitted by authority. A lease never creates or
extends authority. Avoid: grant, lock queue.

## Provider Recovery

A bounded host-owned interval in which a disconnected provider may prove continuity and republish a
target under a higher generation. Avoid: session resume, silent fallback.
