# CDB architecture

## Scope

CDB is a debugger protocol library. It does not decide which tab a user intended, host a registry
UI, start an agent, or own Chrome extension permissions. Its API begins after a grant provider has
identified a target and ends before a provider-specific debugger command reaches Chrome.

This boundary lets DevKit aggregate any future browser-control provider without putting Chrome IDs,
extension lifecycles, or `chrome.debugger` behavior into the generic registry.

## Components

### Broker and target directory

The broker accepts authenticated agent and client principals. A target is published under a stable
target identity and a monotonically increasing generation. Every target-scoped operation carries
both values. A command addressed to a stale generation is rejected instead of being delivered to a
new page or a recovered debugger attachment by accident.

The directory keeps authorization per agent principal. Listing and reconciling targets therefore
cannot leak one agent's grant into another agent session.

### Agent target connection

The grant provider opens the agent-side transport and publishes targets it can execute against. It
answers commands, cancellations, subscription changes, and authority renewal. The authenticated
agent identity is the provider's stable instance identity, not a caller-provided display label.

### Client target connection

An agent-facing client sees only targets granted to its authenticated principal. It can acquire a
lease, execute debugger tools, subscribe to events, and release the lease. Disconnecting the client
revokes the live authority owned by that principal.

### Extension helpers

`@dvcol/cdb-extension` provides publication and recovery mechanics that remain useful to a browser
extension but do not import Chrome APIs. QA Helper supplies the Chrome adapter and the user approval
policy. The separate `presentation` entry is an opt-in content-script helper. It translates
successful CDP pointer commands into sanitized visual events and renders an isolated pointer plus a
temporary favicon. The host owns installation, messaging, current grant state, and navigation
reinjection.

### MCP definitions

`@dvcol/cdb-mcp` exports `createCdbToolDefinitions`. It maps an already-authorized CDB client to MCP
tools without creating a server or choosing a transport. DevKit installs these definitions in its
existing MCP aggregation surface, preserving the DevKit RPC session as the agent principal.

The semantic catalogue includes structural DOM inspection through `browser.snapshot`, which uses
`DOMSnapshot.captureSnapshot`; it is not a screenshot fallback. The tool consumes an externalized
snapshot internally, releases its artifact and temporary lease, and returns a bounded text tree with
backend node IDs. Out-of-process frame sections carry opaque public child-session IDs. Node actions
resolve, scroll, measure, and hit-test those references immediately before input, so a prior
coordinate is never reused after layout changes. The semantic catalogue also owns pointer actions,
bounded navigation and history waits, and JavaScript dialog handling. Inline `script`, `style`, and
`noscript` bodies are omitted from the default snapshot; the raw catalogue remains the explicit
lossless path. Other large command results are returned as artifacts. Their temporary lease stays
live until the caller reads and releases the artifact, and artifact reads count as lease activity in
the embedding broker.

The broker owns lifecycle activation for catalogue domains with an `enable` command. A lease declares
the command and event methods it needs; on first use CDB acquires the corresponding domain demand from
the target executor and releases that demand with the last lease. Callers must not put domain
`enable`/`disable` commands in their lease or depend on a previous agent having enabled a domain.

An embedding host may also expose the generated raw CDP catalogue. That catalogue covers
`chrome.debugger.sendCommand` protocol methods subject to access-level and lease checks. The Chrome
extension lifecycle API itself is intentionally not agent-facing: attach, detach, target discovery,
and debugger event ownership remain grant-provider responsibilities.

## Identity and authority

There are four distinct identifiers:

| Identifier           | Meaning                                               | Lifetime                                |
| -------------------- | ----------------------------------------------------- | --------------------------------------- |
| broker ID            | Identity of one persisted DevKit broker installation  | Across DevKit restarts                  |
| provider instance ID | Stable identity of one provider installation/profile  | Across service-worker restarts          |
| target ID            | Stable identity of the browser target being recovered | While the provider can prove continuity |
| target generation    | Authority epoch for one publication                   | Changes on republish or recovery        |

Display names, tab IDs, target IDs, and generations are diagnostic metadata and may be shown to
trusted localhost UIs. Pairing credentials, bearer material, and grant tokens are never projected
into aggregate state.

One provider instance may publish many targets across tabs and windows. Multiple installed browser
profiles therefore appear as separate providers even when their display name and version match.
Diagnostic UIs should show provider and stable instance IDs so operators can distinguish them.

An authenticated WebSocket connection validates the implementation instance ID against the stored
pairing. The connection exposes a broker-issued connection generation. QA Helper uses that
generation for hello and heartbeat messages so an older connection cannot resume authority after a
newer connection has taken over.

The authenticated WebSocket's `maximumMessageBytes` bound is enforced before the target broker can
externalize a large CDP result. The transport keeps a conservative 16 KiB generic default; an
embedding host that permits multi-megabyte artifacts must explicitly raise the authenticated message
bound enough for the raw response envelope, while retaining its separate artifact-size limit. A
message above the transport bound closes the connection with code `1009`; it is never truncated.

## Grants and access levels

The supported levels, from least to most powerful, are:

1. `observe`
2. `inspect`
3. `interact`
4. `debug`
5. `unsafe`

The requested level is selected by the agent and displayed without modification to the user. Accept
grants exactly that level. A refusal does not silently downgrade the request. The agent can make a
new lower-level request.

Several principals may hold grants for the same target. This matches the fact that Chrome shows QA
Helper as the debugger controller even when several agents are authorized behind it.

## Leases

CDB separates durable permission from short-lived command coordination:

- A grant says that one principal may access one exact target at a maximum level.
- A shared-read lease allows compatible observation and inspection by several principals.
- An exclusive-control lease serializes actions that require one controller.

A grant has no lease inactivity timeout. A semantic tool normally acquires and releases a temporary
lease around one operation; an explicit lease remains available for a sequence of raw commands until
it is released, reaches the embedding broker's configured inactivity or maximum lifetime, loses its
generation, or its grant/principal is revoked.

There is no lease queue and no preemption. An incompatible acquire fails with `LEASE_CONFLICT` and a
retry hint. The agent decides whether and when to retry. Lease inactivity expiry is configurable.

## Recovery and navigation

CDB does not interpret URLs or navigation policies. A provider may renew one stable target under a
new generation when it proves that the underlying tab continues. Commands carrying the previous
generation remain fenced regardless of why authority was renewed.

The embedding broker scopes grants. DevKit currently supports `same-origin` and `follow-tab` grants
on the same CDB target: a cross-origin renewal makes only the former unavailable, while the latter
continues. CDB receives the resulting per-principal target authority and remains unaware of Chrome
origins.

When the provider transport drops, targets and grants enter recovery for a configurable bounded
window. A matching provider identity can reconnect, reconcile its exact targets, and continue under
new generations. Once the window expires, state is revoked. Recovery state remains visible so a user
can revoke it manually.

DevKit daemon death and MCP bridge death are different hard boundaries:

- DevKit daemon death kills all live grants and leases. Persisted pairing does not imply trust in a
  new daemon process.
- MCP bridge death disconnects that agent principal and revokes only its live grants and leases.

## Persistence

CDB itself does not choose a filesystem location. The embedding DevKit broker persists only broker
identity and provider pairing credentials under its configurable state directory, defaulting to
`~/.devkit/broker`.

Requests, grants, leases, principals, targets, generations, and recovery timers are memory-only.
Starting a new DevKit daemon therefore starts with no live authority.

## Structured failures

Browser-control failures carry a stable code, a human-readable message, and, when useful, a
`retryAfterMilliseconds` hint. Important cases include denied or expired requests, insufficient
grant level, missing or stale targets, provider recovery, lease conflict, stale DOM references,
obscured nodes, navigation timeouts, and child-session replacement. Agents should branch on the code,
not parse the message.

## Security invariants

- A provider cannot register the same stable instance under two provider IDs.
- A provider ID cannot silently rotate to a different stable instance.
- Target commands require an exact granted principal, target ID, and target generation.
- A generation superseded by recovery cannot execute commands.
- The grant provider remains authoritative even if DevKit state is stale.
- Browser input never supplies the tab ID used for acceptance. QA Helper derives it from the
  extension message sender.
- Credentials are bounded, stored outside aggregate state, and never rendered in registry UIs.

## Validation boundary

Unit tests cover protocol behavior and the DevKit linked integration test covers the complete
provider path over a real authenticated WebSocket. The final local gate additionally loads QA Helper
in Chromium, accepts from the intended tab, and executes debugger operations through the DevKit MCP
surface.
