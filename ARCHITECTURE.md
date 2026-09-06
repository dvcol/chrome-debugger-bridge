# CDB architecture

## Scope

CDB is a debugger protocol library. It does not decide which tab a user intended, host a registry
UI, start an agent, or own Chrome extension permissions. It coordinates principal-bound access
requests and enforces grants for targets supplied by authenticated providers. Hosts decide which
targets the user approved and how provider-specific commands reach the browser.

This lets an embedding host aggregate browser-control providers without putting Chrome IDs,
extension lifecycles, or `chrome.debugger` behavior into CDB's broker.

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
cancels its operations and subscriptions, then releases its leases after the broker's configured
reconnect grace period. A store-backed connection reads bindings reactively from `AuthorityStore`;
revocation, expiry, generation replacement, session fencing, and store failure refresh authority and
abort work that is no longer authorized.

### Logical sessions and stable references

`@dvcol/cdb/session` separates a logical session from any one transport connection. The broker stores
only a hash of the opaque resume credential in the session's `AuthorityRecord`. Successful resume
rotates the credential, increments the connection generation, and makes the newest connection the
only active one. The previous connection is fenced even if its transport is half open. The raw
credential belongs below model-facing tool definitions and may be kept through a `CredentialStore`.

A connected logical session has no inactivity expiry. On final transport loss, the host disconnects
the CDB client so commands, subscriptions, automation operations, listeners, artifacts, and leases
are released according to their module policies. The authority record and stable `tN` mapping may be
retained for the configured resume window. Resume restores authority and those stable target
references; it does not restore in-flight work or disposable `eN` references. Explicit termination
or resume-window expiry deletes the authority record and ends the logical session.

Session `metadata` is optional JSON-compatible data. CDB validates and stores it but never interprets
it as identity, authority, or policy.

### Grant request coordinator

`createGrantRequestCoordinator` stores the authenticated logical session, principal, requested
capabilities, and expiry before approval begins. A current authenticated provider claims the request
and completes it once with exact target IDs and generations. The host supplies its real target
directory; completion validates ownership and atomically installs bindings in `AuthorityStore`.
Cancellation and live-scope reconciliation change only bindings owned by that request.

Hosts authenticate the final approval source. Page notifications may request presentation but do not
authorize access. The extension approval channel separates those intents from trusted popup or side
panel decisions, while the tab-scope manager shares publishers across overlapping live scopes.
Chrome and URL policy stay in the host. See [grant requests and trusted approval](docs/grant-requests.md)
for the contract and runnable public example.

### Extension helpers

`@dvcol/cdb-extension` provides publication and recovery mechanics that remain useful to a browser
extension but do not import Chrome APIs. The extension host supplies the Chrome adapter and user
approval policy. The separate `presentation` entry is an opt-in content-script helper. It translates
successful CDP pointer commands into sanitized visual events and renders an isolated pointer plus a
temporary favicon. The host owns installation, messaging, current grant state, and navigation
reinjection.

### Automation providers

The core automation contract normalizes snapshot, find, inspect, and semantic action requests. An
embedding broker may register exactly one automation provider for each authenticated extension
provider connection. Registration does not create authority: every operation still resolves the
calling principal's exact grant, generation, and lease before the provider runs.

The provider receives only an operation-scoped CDP executor. CDB projects each internal CDP command
onto that already-validated operation and sends it through the existing target executor. The
provider cannot attach or create targets, contact the extension directly, open a browser-wide CDP
endpoint, or turn its implementation commands into agent-supplied raw authority. Provider element
handles are bound to principal, provider identity, target, generation, and snapshot; replacement,
revocation, generation renewal, and principal disposal invalidate them.

`@dvcol/cdb-automation-playwright` is an experimental implementation. It adapts Playwright's
maintained in-process extension relay and target model over the scoped executor, so the provider host
remains the sole `chrome.debugger` owner. Native CDB semantics remain the default. A host must select the
registered provider explicitly, and a missing or failed provider produces a structured error rather
than native fallback. CDB records total, provider, transport, Chrome, and CDP-command metrics for each
automation operation.

### MCP definitions

`@dvcol/cdb-mcp` exports `createCdbToolSession`. A host creates one session for each authenticated
logical session and disposes it when that session terminates. It can rebind the session to a resumed
client connection without reallocating target references. The session owns tool definitions plus a private
projection from broker targets to short `tN` references. A reference survives generation renewal for
the same authorized target but disappears on target revocation or disposal. The compatibility
`createCdbToolDefinitions` export has no stable cross-request projection and is not suitable for a
long-lived MCP principal.

`browser.snapshot` defaults to a compact actionable accessibility tree. Its `accessibility` mode is
a complete bounded accessibility tree, while `dom` is the diagnostic structural snapshot. Every
snapshot allocates fresh monotonic `eN` references bound to the principal, target, current generation,
frame, snapshot, and backend node. A reference from an earlier document fails as stale; it is never
silently rebound.

Locators are the durable semantic address. The serializable model covers roles and accessible names,
text, labels, placeholders, alt text, titles, test IDs, CSS, descendants, frame chains, `has`, text,
visibility, exclusion, and `nth` filters with bounded text matching. Resolution uses CDP
Accessibility and DOM data, traverses open and closed author shadow roots while excluding user-agent
roots, and supports same-process and out-of-process frames. Actions re-resolve immediately, require a
strict match, and retry visibility, stable geometry, enabled/editable state, scrolling, and hit-target
checks for a bounded deadline. A generation renewal may be retried before pointer or keyboard input;
after input may have been dispatched CDB returns `MCP_ACTION_OUTCOME_UNKNOWN` and does not replay.

The native resolver also supports structured XPath through `DOM.performSearch`. XPath follows
Chromium XPath semantics and therefore does not pierce shadow-root boundaries; portable structured
locators remain the preferred address. Interactive snapshots include named table/grid cells and row
and column headers, and `browser.find` may return references for named non-interactive accessibility
nodes.

The semantic catalogue also owns navigation and history waits, dialogs, console/network inspection,
and artifacts. Arbitrary JavaScript execution through `browser.evaluate`, `Runtime.evaluate`,
`Runtime.callFunctionOn`, or `Runtime.runScript` requires `debug`; it bypasses locator actionability
and pointer presentation. Other large command results are returned as artifacts. Their temporary
lease stays live until the caller reads and releases the artifact, and artifact reads count as lease
activity in the embedding broker.

The broker owns lifecycle activation for catalogue domains with an `enable` command. A lease declares
the command and event methods it needs; on first use CDB acquires the corresponding domain demand from
the target executor and releases that demand with the last lease. Callers must not put domain
`enable`/`disable` commands in their lease or depend on a previous agent having enabled a domain.

An embedding host may also expose the generated raw CDP catalogue. That catalogue covers
`chrome.debugger.sendCommand` protocol methods subject to access-level and lease checks. The Chrome
extension lifecycle API itself is intentionally not agent-facing: attach, detach, target discovery,
and debugger event ownership remain grant-provider responsibilities.

## Identity and authority

There are seven distinct identifiers:

| Identifier            | Meaning                                                   | Lifetime                                |
| --------------------- | --------------------------------------------------------- | --------------------------------------- |
| broker ID             | Identity of one persisted broker installation             | Across broker restarts                  |
| provider instance ID  | Stable identity of one provider installation/profile     | Across provider-process restarts        |
| principal ID          | Authenticated actor to which authority belongs             | Host-defined                            |
| logical session ID    | Resumable principal-scoped tool session                    | Until termination or resume expiry      |
| connection generation | Fencing epoch for one logical-session or provider transport | Increments on successful takeover       |
| target ID             | Stable identity of the target being recovered              | While the provider proves continuity    |
| target generation     | Authority epoch for one target publication                 | Changes on republish or recovery        |

Display names, tab IDs, target IDs, and generations are diagnostic metadata and may be shown to
trusted localhost UIs. Pairing credentials, bearer material, and grant tokens are never projected
into aggregate state.

Generation is an internal authority epoch, not a render counter, DOM revision, snapshot version, or
action counter. Semantic agent tools address `tN` references and resolve the current generation at
operation start. Exact target IDs and generations remain mandatory on broker, lease, raw CDP, and
provider interfaces.

One provider instance may publish many targets across tabs and windows. Multiple installed browser
profiles therefore appear as separate providers even when their display name and version match.
Diagnostic UIs should show provider and stable instance IDs so operators can distinguish them.

An authenticated WebSocket connection validates the implementation instance ID against the stored
pairing. The connection exposes a broker-issued connection generation. The provider uses that
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

The embedding host owns consent policy and decides when to create or revoke authority. CDB represents
the result as generation-bound `AuthorityBinding` records. A binding has its own ID and belongs to the
principal and logical session in its containing `AuthorityRecord`; it names an exact target ID,
target generation, access level, allowed-method set, and optional expiry.

`AuthorityStore` is asynchronous, supports atomic update and deletion, and publishes changes. The
store-backed client adapter resolves it reactively instead of retaining a connection-time grant
snapshot. Store read or subscription failure fails closed: affected authority becomes unavailable,
matching work is aborted, and no cached binding remains usable. CDB also intersects active bindings
with the provider target's capabilities before listing, leasing, or executing against it.

Several principals may hold grants for the same target. Chrome still sees one provider as the
debugger controller while CDB authorizes several principals behind it.

When bindings overlap, authorization combines the maximum level and a canonical sorted union of
allowed methods. Revoking one binding recalculates the result from the survivors, independently of
insertion order. A target generation change fences every old binding immediately; a host that accepts
continuity creates replacement bindings for the new generation rather than mutating the old binding
identity.

## Leases

CDB separates durable permission from short-lived command coordination:

- A grant says that one principal may access one exact target at a maximum level.
- A shared-read lease allows compatible observation and inspection by several principals.
- An exclusive-control lease serializes actions that require one controller.

A binding has no lease inactivity timeout. A semantic tool normally acquires and releases a temporary
lease around one operation; an explicit lease remains available for a sequence of raw commands until
it is released, reaches the broker's configured duration or maximum lifetime, loses its generation,
or its binding, logical session, or principal is revoked. Explicit leases are renewable; CDB does not
renew them in the background.

There is no lease queue and no preemption. An incompatible acquire fails with `LEASE_CONFLICT` and a
retry hint. The agent decides whether and when to retry. Lease inactivity expiry is configurable.

## Recovery and navigation

CDB does not interpret URLs or navigation policies. A provider may renew one stable target under a
new generation when it proves that the underlying tab continues. Commands carrying the previous
generation remain fenced regardless of why authority was renewed.

The embedding broker scopes grants. It may apply different navigation policies to principals on the
same CDB target. CDB receives the resulting per-principal target authority and remains unaware of
URLs and origins.

When the provider transport drops, the host removes the dead executor and exposes retryable target
unavailability for a configurable bounded recovery window. A matching provider identity can
reconnect, reconcile its exact targets, and continue under higher generations. A newer provider
connection generation fences its predecessor. Once the window expires, the host revokes recovery
state; CDB never delivers work to the dead executor.

Broker-process death and client-session death are different authority boundaries:

- Broker-process death kills all live grants and leases. Persisted pairing does not imply trust in a
  replacement process.
- Logical-session termination revokes only that principal's bindings, references, and live resources.
- A resumable transport loss releases live resources but may retain bindings and `tN` references for
  the configured resume window.

## Stores and persistence

CDB exposes two separate store contracts:

- `AuthorityStore` holds broker-side logical-session records, hashed resume credentials, and
  generation-bound bindings.
- `CredentialStore` holds the raw credential on the resuming client side, below model-facing tools.

Both default to asynchronous in-memory implementations with no I/O. CDB does not select a filesystem,
database, storage API, or persistence setting. A consumer injects a compatible persistent
implementation when it accepts that implementation's I/O, consistency, and recovery tradeoffs. Both
contracts may share one storage technology without becoming one trust boundary.

Persistent stores can recover authority after process restart only through a fresh authenticated
connection generation. In-flight commands, leases, subscriptions, automation handles, listeners,
artifacts, and timers are never recovered.

## Timing policies

Each module owns a typed timing policy and immutable defaults for the timers it creates. A deadline is
expressed in milliseconds as `number | null`: a positive value schedules expiry, `0` expires
immediately, and `null` disables that deadline as an explicit consumer-owned tradeoff. Construction
validates overrides before work starts.

The core defaults are a 15-minute logical-session resume window, at most 60 seconds for lease
acquisition or renewal, a 15-minute explicit-lease lifetime, no connected-session inactivity expiry,
and the existing transport handshake, heartbeat, retry, command, artifact, and cleanup intervals.
Provider recovery belongs to the embedding host because it owns the provider process and continuity
policy. Disabling a security expiry can keep authority indefinitely and must be chosen deliberately.

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
- Only the newest logical-session and provider connection generations may execute work.
- Resume credentials are opaque, hashed broker-side, rotated after use, and excluded from model input.
- The grant provider remains authoritative even if embedding-host state is stale.
- A browser-extension adapter derives accepted target identity from a trusted platform source, not
  from page or agent input.
- Credentials are bounded, stored outside aggregate state, and never rendered in registry UIs.

## Validation boundary

Unit tests cover protocol behavior. Repository integration tests cover authenticated transports,
browser clients, extension helpers, package consumers, and example compositions. Embedding hosts
remain responsible for end-to-end validation of their approval policy and platform adapter.
