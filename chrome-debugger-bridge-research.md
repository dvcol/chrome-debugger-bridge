# Capability-Scoped Chrome Debugger Bridge

**Research and implementation handoff**
**Prepared:** 2026-08-03

## 1. Goal

Build a reusable, transport-neutral package that exposes selected tabs from a user's **existing Chrome profile** to arbitrary local consumers.

The bridge must support:

- Full tab control and debugging:
  - navigation
  - DOM inspection
  - clicks and keyboard input
  - JavaScript evaluation
  - screenshots
  - console logs
  - network events
  - response bodies
  - raw Chrome DevTools Protocol commands
- Explicit exposure boundaries:
  - one tab
  - an explicit set of tabs
  - a tab group
  - a window
  - potentially URL-pattern or active-tab policies
- The user's real browser profile:
  - existing cookies and authentication
  - installed extensions
  - current configuration
  - already-open tabs
- Multiple consumer types:
  - MCP servers
  - CLI agents such as Claude Code, Codex, OpenCode, and Pi
  - standard web applications
  - local desktop applications
  - custom automation systems
- No dependency on proprietary Claude or Codex browser extensions.
- No copied profile, separate automation profile, headless browser, or independently launched Playwright browser.

The reusable product is not primarily “a browser MCP server.” It is a **capability-scoped `chrome.debugger` broker** with optional protocol adapters.

---

## 2. Core conclusion

There are several open-source projects that implement parts of this system, but no clear project currently combines all of the following as a clean reusable primitive:

1. Existing browser profile.
2. Explicit per-target exposure.
3. Full Chrome Debugger / CDP access.
4. Multi-client multiplexing.
5. A transport-neutral client API.
6. Native Streamable HTTP MCP support.
7. Easy embedding into an arbitrary Chrome extension and arbitrary MCP server.

The recommended direction is therefore to build a new package, while borrowing proven design ideas from existing projects.

The architecture should be:

```text
chrome.debugger
      │
      ▼
capability-scoped MV3 extension bridge
      │
      │ WebSocket or Native Messaging
      ▼
local target/session/lease broker
      ├─ JSON-RPC WebSocket API
      ├─ optional HTTP blob API
      ├─ local application SDK
      └─ MCP Streamable HTTP adapter
```

Use **WebSocket for the live debugger bridge** and **Streamable HTTP for the MCP-facing adapter**.

---

## 3. Existing projects reviewed

### 3.1 `hangwin/mcp-chrome`

Repository:

- <https://github.com/hangwin/mcp-chrome>

What it provides:

- MV3 Chrome extension.
- Uses the current Chrome profile and tabs.
- Direct use of `chrome.debugger.attach()` and `chrome.debugger.sendCommand()`.
- Browser navigation and tab management.
- Screenshots.
- Script injection.
- Console inspection.
- Network capture and response bodies.
- Local MCP server.
- Streamable HTTP endpoint, normally:
  - `http://127.0.0.1:12306/mcp`
- Also supports legacy SSE and stdio-style integration.

Important implementation references:

- CDP session manager:
  - `app/chrome-extension/utils/cdp-session-manager.ts`
- HTTP MCP server:
  - `app/native-server/src/server/index.ts`
- Local server configuration:
  - `app/native-server/src/constant/index.ts`

Strengths:

- Closest turnkey implementation for “control a real Chrome profile through HTTP MCP.”
- Genuine MCP Streamable HTTP server.
- Broad Chrome API and CDP coverage.
- Good reference for an extension-to-native-host-to-MCP architecture.

Weaknesses:

- Browser-wide visibility.
- The extension can enumerate all windows and tabs.
- Exposure is not a strict user-selected per-tab capability boundary.
- Broad permissions:
  - `tabs`
  - `debugger`
  - `<all_urls>`
  - history
  - bookmarks
  - downloads
  - other browser APIs
- Loopback binding is useful, but localhost alone is not authentication.

Conclusion:

Use as a reference for the MCP HTTP adapter and native host, but not as the final security model.

---

### 3.2 `jobshimo/browser-link`

Repository:

- <https://github.com/jobshimo/browser-link>

Published package:

- `@jobshimo/browser-link`

What it provides:

- Existing Chrome profile.
- Explicit **Connect this tab** interaction.
- Only connected tabs are exposed.
- Uses `chrome.debugger`.
- Navigation.
- DOM snapshots and element lookup.
- Click, type, keypress, drag, JavaScript evaluation.
- Console buffer.
- Network buffer and response body retrieval.
- Screenshots.
- Per-tool permissions.
- Multi-agent support.
- Target claiming and release.
- Persistent UI maps.
- Loopback WebSocket bridge.

Relevant implementation reference:

- `packages/extension/src/background.ts`

Strengths:

- Best available reference for explicit per-tab authorization.
- Good user-facing security model.
- Good multi-agent concepts.
- Existing lease/claim semantics.
- Developer-focused rather than consumer automation focused.

Weaknesses:

- MCP transport is primarily stdio.
- Not a generic transport-neutral debugger primitive.
- High-level browser tools and broker concerns are coupled.
- Does not natively expose a standard Streamable HTTP MCP endpoint.

Conclusion:

Best source for target exposure, claims, event handling, and user consent.

---

### 3.3 Microsoft Playwright extension relay

Repository:

- <https://github.com/microsoft/playwright>

Relevant directory:

- `packages/extension`

Relevant source:

- `packages/extension/src/relayConnection.ts`

What it does:

- Uses `chrome.debugger`.
- Tracks an explicit set of attached tabs.
- Filters debugger events to attached tab IDs.
- Relays only an allowlist of Chrome APIs:
  - `chrome.debugger.attach`
  - `chrome.debugger.detach`
  - `chrome.debugger.sendCommand`
  - `chrome.tabs.create`
  - `chrome.tabs.remove`
- Maintains per-connection attached-tab bookkeeping.
- Converts extension-side debugger access into a CDP relay Playwright can consume.

Strengths:

- Very small and clean debugger relay.
- Strong reference for a minimal primitive.
- Good event filtering by attached target.
- Explicitly scoped tab attachment.

Weaknesses:

- `@playwright/extension` is private.
- Designed as internal Playwright infrastructure.
- Not published as a generic debugger bridge.
- Not directly an MCP package.

Conclusion:

Probably the best code-level reference for the lowest-level extension relay.

---

### 3.4 `BrowserMCP/mcp`

Repository:

- <https://github.com/BrowserMCP/mcp>

What it provides:

- MCP server plus Chrome extension.
- Uses the user's normal profile and logged-in sessions.
- User connects a tab through the extension.
- Local WebSocket communication.

Strengths:

- Existing-profile automation.
- Extension-mediated tab connection.
- MCP-agent compatibility.

Weaknesses:

- Repository states that it cannot currently be built independently because it depends on packages from its private monorepo.
- Less useful as a reusable package base.
- More product-oriented than primitive-oriented.

Conclusion:

Confirms demand, but is not the best implementation foundation.

---

### 3.5 `mcpland/webpage-mcp`

Repository:

- <https://github.com/mcpland/webpage-mcp>

NPM package:

- `webpage-mcp`

What it provides:

- Chrome extension plus local MCP server.
- Uses Native Messaging.
- Existing browser profile.
- Network, console, screenshots, DOM operations, history, bookmarks, workflows, semantic search, and visual editing.
- Current package exposes stdio MCP.
- Broad Chrome permissions, including `debugger`.

Strengths:

- Rich Chrome-native feature set.
- Good Native Messaging reference.
- Useful security and privacy documentation.
- Shows how browser-native workflows can sit above CDP.

Weaknesses:

- Much broader product surface than required.
- stdio-focused MCP interface.
- Not a minimal reusable debugger primitive.
- Broad browser access.

Conclusion:

Useful Native Messaging and packaging reference, but too product-heavy as the core.

---

### 3.6 Chrome DevTools MCP

Repository:

- <https://github.com/ChromeDevTools/chrome-devtools-mcp>

What it provides:

- Deep CDP-based inspection and browser control.
- Recent Chrome versions can connect to an actively running browser session.
- Supports current browser tabs, cookies, extensions, and state after user opt-in.

Strengths:

- Excellent CDP and debugging coverage.
- First-party Chrome tooling.
- No extension required for supported existing-session workflows.

Weaknesses:

- Access is generally profile-wide, not an explicit per-tab capability boundary.
- Primarily an MCP product rather than a reusable bridge.
- Current-profile attachment depends on Chrome's remote-debugging consent and browser-version behavior.
- Not suitable when an extension must own target-by-target authorization.

Conclusion:

Good no-extension option when profile-wide control is acceptable. Not the correct foundation for strict per-tab exposure.

---

### 3.7 Other projects

Other relevant implementations include:

- `AlienMcp`
  - scopes targets using a dedicated Chrome tab group
  - useful exposure UX
  - stdio-oriented
- RunBrowser
  - existing browser profile
  - explicit tab consent
  - persistent local HTTP/WS relay
  - MCP adapter is not the primary native protocol
- Browser Bridge
  - existing-profile DOM, console, network, and JavaScript access
  - stdio-focused

These projects support the conclusion that there is demand for a shared lower-level primitive.

---

## 4. Why the core should not be MCP-shaped

The Model Context Protocol is useful for exposing agent tools, but the debugger bridge has different requirements.

A live Chrome debugger session naturally involves:

- Long-lived target attachment.
- Command/response correlation.
- High-frequency unsolicited events.
- Console and network streams.
- Child targets and nested sessions.
- Backpressure.
- Subscription filtering.
- Binary artifacts.
- Multiple concurrent consumers.
- Mutable ownership and lease state.

The MCP `2026-07-28` specification intentionally moved the core protocol toward stateless HTTP request/response behavior.

Important changes:

- No mandatory initialization handshake.
- No protocol-level session.
- Each request is a separate HTTP POST.
- Each request carries its own protocol metadata.
- A response is:
  - one JSON object, or
  - a request-scoped SSE stream.
- Long-lived change notifications use `subscriptions/listen`.
- Server-to-client interactions use Multi Round-Trip Requests rather than permanent bidirectional request channels.
- Header-based routing uses fields such as:
  - `MCP-Protocol-Version`
  - `Mcp-Method`
  - `Mcp-Name`

Official references:

- MCP repository:
  - <https://github.com/modelcontextprotocol/modelcontextprotocol>
- Streamable HTTP:
  - <https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx>
- Transport overview:
  - <https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/index.mdx>
- 2026-07-28 release:
  - <https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/blog/content/posts/2026-07-28-spec-ga/index.md>
- HTTP header standardization:
  - <https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2243-http-standardization.md>

This makes Streamable HTTP a good **MCP boundary**, but not the ideal internal CDP event transport.

---

## 5. Recommended transport strategy

### 5.1 Extension to broker: WebSocket

Recommended default:

```text
ws://127.0.0.1:<port>/bridge
```

The extension initiates the connection.

Why WebSocket:

- Bidirectional.
- Persistent.
- Natural command/event multiplexing.
- Low per-message overhead.
- Works well for console and network events.
- Supports binary frames.
- Easier multi-client fan-out through the broker.
- Avoids polling.
- Suitable for service-worker reconnection.
- Chrome extension real-time communication guidance supports WebSocket use for frequent two-way communication.

Requirements:

- Bind only to loopback.
- Validate the WebSocket `Origin`.
- Require a pairing or installation token.
- Negotiate protocol versions.
- Heartbeats.
- Automatic reconnection.
- Explicit disconnect and revoke handling.
- Never treat `127.0.0.1` as sufficient authentication.

### 5.2 Optional extension transport: Native Messaging

Native Messaging is useful when stronger installation coupling is required.

Advantages:

- Chrome launches or connects to a registered native host.
- `allowed_origins` restricts which extension IDs may connect.
- No localhost port is required for the extension-host link.
- Bidirectional stdin/stdout protocol.

Disadvantages:

- OS-specific registration.
- Extension-ID coupling.
- More cumbersome developer setup.
- Harder for arbitrary applications to consume directly.
- Native host to extension messages have size constraints.
- Screenshots, traces, and large response bodies require special handling.
- Multi-client sharing still requires a broker above it.

Recommendation:

Support Native Messaging as an optional transport adapter. Do not make it the only architecture.

### 5.3 Broker to general clients: JSON-RPC over WebSocket

Expose a stable JSON-RPC protocol over WebSocket for:

- local applications
- browser-based development tools
- IDE plugins
- custom MCP servers
- automation frameworks

This protocol should be independent from Chrome extension internals and independent from MCP.

### 5.4 Large artifacts: HTTP blob endpoint or binary frames

Avoid base64-encoding every large result into JSON-RPC.

Use short-lived blob handles:

```json
{
  "blob": {
    "id": "blob_92af",
    "mimeType": "image/png",
    "size": 2849301,
    "expiresAt": "2026-08-03T18:00:00Z"
  }
}
```

Retrieve through:

```text
GET http://127.0.0.1:<port>/blobs/blob_92af
```

Alternatively, support WebSocket binary frames mapped to blob IDs.

### 5.5 MCP clients: Streamable HTTP

Expose the MCP adapter at:

```text
POST http://127.0.0.1:<port>/mcp
```

Use the current MCP Streamable HTTP specification.

For current MCP:

- One HTTP endpoint.
- POST for each JSON-RPC request.
- JSON or request-scoped SSE response.
- Validate `Origin`.
- Bind locally.
- Use authentication.
- Carry current protocol metadata and required headers.
- Do not build new code around the deprecated HTTP+SSE session design.

### 5.6 stdio-only consumers

Provide a small stdio proxy:

```text
stdio MCP client
      │
      ▼
thin stdio-to-HTTP adapter
      │
      ▼
local Streamable HTTP MCP endpoint
```

Do not duplicate browser control logic in the stdio process.

---

## 6. Security model

The extension must remain the final authority.

The local broker must not be able to select arbitrary Chrome tabs by raw tab ID.

### 6.1 Opaque public identifiers

Do not expose Chrome `tabId`, `windowId`, or `groupId` as durable capabilities.

Expose opaque IDs:

```ts
interface PublishedTarget {
  targetId: string;
  scopeId: string;
  title: string;
  url?: string;
  capabilities: CapabilitySet;
}
```

A stale Chrome tab ID must not grant control after revocation or reuse.

### 6.2 Exposure selectors

Internal extension selectors may include:

```ts
type ExposureSelector =
  | { type: "tab"; tabId: number }
  | { type: "explicit-set"; tabIds: number[] }
  | { type: "group"; groupId: number }
  | { type: "window"; windowId: number }
  | { type: "active-tab" }
  | { type: "url-pattern"; patterns: string[] };
```

The extension resolves these selectors and publishes only permitted targets.

When a tab:

- leaves an exposed group,
- moves out of an exposed window,
- navigates outside a URL policy,
- is manually disconnected,
- is closed,

the extension must immediately revoke it and invalidate active leases.

### 6.3 Capability sets

Scope and permission must be separate.

Example:

```ts
interface CapabilitySet {
  cdpDomains?: string[];
  cdpMethods?: string[];

  navigation?: boolean;
  input?: boolean;
  evaluation?: boolean;
  screenshots?: boolean;
  networkBodies?: boolean;
  downloads?: boolean;

  readOnly?: boolean;
}
```

Suggested presets:

- `observe`
  - DOM snapshots
  - console
  - network metadata
- `inspect`
  - runtime evaluation
  - response bodies
  - richer DOM inspection
- `interact`
  - click
  - keyboard
  - form input
  - navigation
- `debug`
  - debugger
  - tracing
  - performance
  - profiler
- `full`
  - every supported `chrome.debugger` domain and action

All commands must be checked in the extension, even if the broker already checked them.

### 6.4 Authentication

For local WebSocket and HTTP endpoints:

- Bind to `127.0.0.1` only.
- Validate `Origin`.
- Require a bearer or pairing token.
- Store tokens in user-private files.
- Rotate tokens.
- Support explicit revocation.
- Avoid secrets in URL query strings.
- Consider per-client credentials rather than one global token.
- Log target claims and high-impact actions.
- Do not expose the broker on `0.0.0.0` by default.

### 6.5 User-visible attachment

`chrome.debugger` may show Chrome's debugger infobar.

Do not attempt to hide it programmatically.

The visible debugger state is a useful security signal.

---

## 7. Multi-client ownership and leases

Only the extension should hold the actual `chrome.debugger` attachment.

Consumers share that attachment through the broker.

Suggested modes:

```ts
type LeaseMode =
  | "shared-read"
  | "shared"
  | "exclusive-control";
```

Recommended semantics:

- Multiple clients may observe console and network events.
- Mutating actions require a control lease.
- Only one client may hold `exclusive-control`.
- Read-only leases may coexist with one control lease.
- Exposure revocation invalidates all leases immediately.
- Leases have:
  - explicit owner
  - expiry
  - renewal
  - capability set
  - target binding
- Client disconnect triggers lease expiry or release.
- A manually configured grace period may allow reconnection.

Suggested lease methods:

```text
leases.acquire
leases.renew
leases.release
leases.list
leases.revoke
```

Do not rely only on an implicit WebSocket connection as the ownership boundary.

---

## 8. CDP domain management

Multiple clients may require the same domains.

The extension should maintain reference counts:

```text
Network.enable:
  client A subscribes -> count 1 -> send Network.enable
  client B subscribes -> count 2 -> no additional enable
  client A unsubscribes -> count 1 -> keep enabled
  client B unsubscribes -> count 0 -> optionally send Network.disable
```

This applies to:

- `Network`
- `Runtime`
- `Page`
- `DOM`
- `Log`
- `Debugger`
- `Performance`
- `Tracing`
- other stateful domains

Avoid letting clients independently enable and disable domains without coordination.

---

## 9. Proposed core protocol

Use JSON-RPC 2.0 over WebSocket.

### 9.1 Connection and discovery

```text
bridge.hello
bridge.info
bridge.ping
bridge.goodbye
```

`bridge.hello` should include:

```ts
interface BridgeHello {
  protocolVersion: string;
  client: {
    name: string;
    version: string;
    instanceId: string;
  };
  authentication: {
    token: string;
  };
  capabilities?: string[];
}
```

### 9.2 Target management

```text
targets.list
targets.get
targets.subscribe
```

Notifications:

```text
targets.published
targets.updated
targets.revoked
targets.closed
```

### 9.3 Exposure management

Exposure changes should normally be user-driven from the extension.

Potential administrative methods:

```text
scopes.list
scopes.get
scopes.subscribe
```

Avoid allowing untrusted external clients to publish arbitrary Chrome tabs.

A privileged local management client may optionally use:

```text
scopes.create
scopes.update
scopes.revoke
```

but the extension must require local user authorization.

### 9.4 Lease management

```text
leases.acquire
leases.renew
leases.release
leases.list
```

Example:

```json
{
  "jsonrpc": "2.0",
  "id": "lease-request-1",
  "method": "leases.acquire",
  "params": {
    "targetId": "target_93f",
    "mode": "exclusive-control",
    "capabilities": [
      "navigation",
      "input",
      "evaluation",
      "network"
    ],
    "ttlMs": 300000
  }
}
```

### 9.5 Raw CDP commands

```text
cdp.send
```

Example:

```json
{
  "jsonrpc": "2.0",
  "id": "req-42",
  "method": "cdp.send",
  "params": {
    "leaseId": "lease_f97d",
    "sessionId": "session_a1",
    "method": "Network.getResponseBody",
    "params": {
      "requestId": "3294.7"
    }
  }
}
```

### 9.6 Event subscriptions

```text
cdp.subscribe
cdp.unsubscribe
```

Subscription filters should support:

- target
- session
- domain
- exact method
- method prefix
- optional parameter predicates
- buffer size
- batch size

Notification:

```json
{
  "jsonrpc": "2.0",
  "method": "cdp.event",
  "params": {
    "subscriptionId": "sub_12",
    "targetId": "target_93f",
    "sessionId": "session_a1",
    "method": "Network.responseReceived",
    "params": {}
  }
}
```

### 9.7 Higher-level helpers

Keep raw CDP as the foundation.

Optional helper packages may expose:

```text
browser.navigate
browser.snapshot
browser.find
browser.click
browser.type
browser.press
browser.evaluate
browser.screenshot
browser.console
browser.network
browser.network_body
browser.wait_for
```

These helpers must be implemented above `cdp.send` and subscriptions.

---

## 10. Child targets and sessions

Modern Chrome pages include:

- out-of-process iframes
- dedicated workers
- shared workers
- service workers
- popup windows
- nested targets

The bridge must preserve CDP `sessionId`.

Recommended strategy:

1. Attach to the primary tab through `chrome.debugger`.
2. Configure target discovery and auto-attach where supported.
3. Use flattened sessions.
4. Forward child target attachment events.
5. Recursively configure newly attached child targets when necessary.
6. Maintain:
   - public target ID
   - Chrome tab ID
   - CDP target ID
   - CDP session ID
   - parent session
7. Apply the parent exposure and capability policy to children.
8. Optionally restrict specific target types.

Do not assume one Chrome tab equals one CDP session.

---

## 11. Lifecycle issues

### 11.1 DevTools conflict

Opening Chrome DevTools for an attached tab may detach the extension debugger.

Required behavior:

- Listen to `chrome.debugger.onDetach`.
- Emit a target-detached event.
- Invalidate associated sessions and leases.
- Do not silently reattach unless policy explicitly allows it.
- Surface the detach reason to consumers.

### 11.2 MV3 service worker restart

Persist:

- exposure policies
- user configuration
- pairing data

Do not persist assumptions that debugger sessions remain attached.

On service-worker restart:

1. Reconnect to the broker.
2. Re-evaluate exposure selectors.
3. Inspect debugger targets.
4. Reattach where policy permits.
5. Republish targets.
6. Require clients to reacquire leases.
7. Rebuild domain subscriptions.

### 11.3 Navigation

A top-level navigation may invalidate execution contexts and DOM references.

Notify clients of:

- frame navigation
- target change
- execution context destruction
- new document
- detached frames

Higher-level element handles should not be durable across navigation.

### 11.4 Tab movement

When a tab changes:

- group
- window
- URL
- incognito state

re-evaluate exposure policy.

### 11.5 Browser shutdown

The broker should:

- mark targets unavailable
- expire leases
- preserve only safe configuration
- wait for extension reconnection

---

## 12. Backpressure and event buffering

Network and tracing events can overwhelm slow consumers.

Each subscription should specify:

```ts
interface SubscriptionOptions {
  methods?: string[];
  domains?: string[];
  bufferSize?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  overflow?: "drop-oldest" | "drop-newest" | "disconnect";
}
```

The bridge should report:

- dropped event count
- last delivered sequence
- current buffer usage

Potential notification:

```text
subscription.overflow
```

Tracing and very high-volume domains may require:

- exclusive subscriptions
- binary transfer
- dedicated blob handles
- explicit duration limits

---

## 13. Package layout

Recommended monorepo:

```text
@browser-debug/protocol
  Shared schemas, JSON-RPC messages, capability definitions, errors.

@browser-debug/extension
  MV3 chrome.debugger bridge and exposure policy engine.

@browser-debug/host
  Local broker, target registry, leases, multiplexing, authentication.

@browser-debug/client
  Transport-neutral TypeScript client.

@browser-debug/transport-websocket
  JSON-RPC WebSocket client and server transport.

@browser-debug/transport-native
  Native Messaging transport.

@browser-debug/blob-store
  Short-lived HTTP or filesystem-backed artifact storage.

@browser-debug/helpers
  Optional high-level browser actions.

@browser-debug/adapter-mcp
  MCP tools backed by @browser-debug/client.

@browser-debug/adapter-stdio
  Thin stdio-to-Streamable-HTTP MCP proxy, if needed.

@browser-debug/devtools
  Diagnostics UI, protocol inspector, event viewer.
```

Dependency direction:

```text
protocol
  ↑
extension / host / client
  ↑
transport adapters
  ↑
helpers and MCP adapter
```

The MCP adapter must not own Chrome lifecycle state.

---

## 14. MCP adapter design

Expose a compact set of high-level tools:

```text
browser.list_targets
browser.acquire
browser.renew
browser.release

browser.snapshot
browser.navigate
browser.click
browser.type
browser.press
browser.evaluate
browser.screenshot

browser.console
browser.network
browser.network_body
browser.wait_for

browser.cdp
```

`browser.cdp` is the escape hatch:

```json
{
  "target": "target_93f",
  "method": "DOMSnapshot.captureSnapshot",
  "params": {
    "computedStyles": []
  }
}
```

Avoid generating one MCP tool for every CDP method.

Why:

- Tool catalogs would become enormous.
- Agents perform better with a small semantic surface.
- Raw CDP remains available for advanced workflows.
- High-level tools can enforce safer defaults.

### 14.1 Current Streamable HTTP requirements

For MCP `2026-07-28`:

- Use one POST endpoint.
- Do not depend on protocol sessions.
- Every request carries protocol metadata.
- Support JSON and request-scoped SSE responses.
- Implement cancellation by closing the response stream.
- Use `subscriptions/listen` for long-lived notifications when needed.
- Validate `Origin`.
- Bind to localhost by default.
- Authenticate.
- Support current MCP headers and reject mismatches.
- Keep compatibility with older clients only in a separate compatibility layer.

---

## 15. Initial MVP

Keep the first release narrow.

### Phase 1: bridge foundation

- MV3 extension.
- Explicit Connect/Disconnect current tab.
- WebSocket connection to localhost broker.
- Pairing token.
- Opaque target IDs.
- One actual `chrome.debugger` attachment per exposed tab.
- `targets.list`.
- `leases.acquire` and `leases.release`.
- `cdp.send`.
- `cdp.subscribe` and `cdp.event`.
- Detach handling.
- Service-worker reconnection.
- Basic event backpressure.
- TypeScript client SDK.

### Phase 2: useful debugging layer

- Network event collection.
- Response body retrieval.
- Console and Log domain aggregation.
- Runtime evaluation.
- Page navigation.
- Input dispatch.
- Screenshots.
- HTTP blob store.
- Child target support.
- Shared-read and exclusive-control leases.

### Phase 3: adapters

- MCP Streamable HTTP adapter.
- High-level browser tools.
- stdio proxy.
- Local web inspector.
- Client examples.

### Phase 4: expanded exposure

- Explicit multi-tab sets.
- Tab group exposure.
- Window exposure.
- URL-pattern policies.
- Time-limited exposure.
- Capability presets.
- User confirmation for privilege escalation.

### Phase 5: optional hardening

- Native Messaging transport.
- Per-client credentials.
- OS keychain integration.
- Audit log.
- Signed extension/host pairing.
- Enterprise policy support.

---

## 16. Suggested first implementation decisions

Use these defaults unless new constraints appear:

```text
Language:
  TypeScript

Extension framework:
  WXT or plain MV3

Broker runtime:
  Node.js

Extension transport:
  WebSocket over 127.0.0.1

Core protocol:
  JSON-RPC 2.0

Schema:
  TypeBox, Zod, or Standard Schema-compatible definitions

MCP adapter:
  Official Model Context Protocol TypeScript SDK

MCP transport:
  Streamable HTTP 2026-07-28

Target IDs:
  Random opaque IDs

Lease IDs:
  Random opaque IDs

Artifacts:
  Expiring local HTTP blob endpoint

Default exposure:
  Explicit single-tab opt-in

Default lease:
  Shared read-only

Mutating control:
  Explicit exclusive-control lease

Authentication:
  Random local pairing token plus Origin validation
```

---

## 17. Open design questions

Resolve these early:

1. Should the extension connect directly to the broker through WebSocket, or use Native Messaging by default?
   - Recommendation: WebSocket first, Native Messaging optional.

2. Should arbitrary local apps be allowed to request exposure?
   - Recommendation: no; exposure remains user-driven in the extension.

3. Should a control lease block the human user?
   - Recommendation: no; humans retain control, but human actions may invalidate automation assumptions.

4. What happens when DevTools opens?
   - Recommendation: detach and require explicit recovery.

5. Should read-only clients observe events during another client's exclusive-control lease?
   - Recommendation: yes, unless the target owner selects private control.

6. Can one target be exposed with different capabilities to different clients?
   - Recommendation: yes, through per-client leases bounded by the target's maximum policy.

7. Should raw CDP be enabled by default?
   - Recommendation: only for trusted local clients; disable in safer MCP presets.

8. How are incognito tabs handled?
   - Recommendation: disabled by default and separately authorized.

9. Should extensions, `chrome://` pages, and Web Store pages be controllable?
   - Recommendation: document Chrome restrictions and exclude unsupported pages from publication.

10. How should tab groups behave when tabs enter or leave?
    - Recommendation: dynamic publish/revoke based on group membership.

---

## 18. Risks

### Security

A debugger bridge can:

- read sensitive page content
- access authenticated sessions
- submit forms
- make purchases
- modify admin systems
- inspect tokens and network traffic
- execute JavaScript

The design must treat every exposed target as a high-value capability.

### Chrome API restrictions

`chrome.debugger` exposes a constrained subset of CDP domains and behavior may vary by Chrome version.

Track compatibility explicitly.

### Competing debugger clients

Chrome DevTools or another debugger extension may detach the bridge.

### Agent tool misuse

A raw CDP escape hatch is powerful and difficult for models to use safely.

Keep semantic high-level tools as the default agent surface.

### Protocol churn

MCP evolved significantly through 2025 and 2026.

Keep the MCP adapter isolated so that changes do not affect the debugger protocol.

---

## 19. Practical implementation starting point

Start by extracting the smallest useful pattern from the Playwright extension relay:

1. Allowlist:
   - attach
   - detach
   - sendCommand
2. Track attached tabs.
3. Filter `chrome.debugger.onEvent`.
4. Forward events over WebSocket.
5. Add opaque target IDs.
6. Add a lease check before each forwarded command.
7. Add capability validation.
8. Add target revocation.
9. Add a small TypeScript client.
10. Build high-level helpers above the raw bridge.

After the raw bridge is stable, reuse ideas from:

- `browser-link`
  - per-tab connection UX
  - claims
  - multi-agent lifecycle
  - console/network buffering
- `mcp-chrome`
  - local server layout
  - Streamable HTTP MCP adapter
  - Native Messaging host
- `webpage-mcp`
  - installer and Native Messaging registration
  - privacy documentation
- Chrome DevTools MCP
  - semantic MCP tool design
  - CDP debugging coverage

---

## 20. Definition of success

The project is successful when all of the following work:

1. The user opens their normal Chrome profile.
2. The user explicitly exposes one tab from the extension.
3. The extension attaches `chrome.debugger`.
4. A local broker publishes an opaque target.
5. A standard web application connects by WebSocket and receives console/network events.
6. A local TypeScript client sends raw CDP commands.
7. An MCP client connects through Streamable HTTP.
8. Claude Code, Codex, OpenCode, or Pi can:
   - inspect the page
   - navigate
   - click
   - type
   - read console logs
   - inspect requests and response bodies
9. No unexposed tab is visible or controllable.
10. Revoking the tab immediately terminates access for every client.
11. Multiple read-only clients can coexist.
12. Only one exclusive controller can mutate the tab at a time.
13. The same core packages can be embedded into another MV3 extension or another MCP server.

---

## 21. References

### Chrome

- `chrome.debugger` API:
  - <https://developer.chrome.com/docs/extensions/reference/api/debugger>
- Native Messaging:
  - <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>
- Real-time extension communication:
  - <https://developer.chrome.com/docs/extensions/develop/concepts/real-time>

### MCP

- Organization:
  - <https://github.com/modelcontextprotocol>
- Specification repository:
  - <https://github.com/modelcontextprotocol/modelcontextprotocol>
- Transport overview:
  - <https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/index.mdx>
- Streamable HTTP:
  - <https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx>
- 2026-07-28 release:
  - <https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/blog/content/posts/2026-07-28-spec-ga/index.md>
- HTTP standardization:
  - <https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2243-http-standardization.md>

### Related projects

- Playwright extension:
  - <https://github.com/microsoft/playwright/tree/main/packages/extension>
- Chrome DevTools MCP:
  - <https://github.com/ChromeDevTools/chrome-devtools-mcp>
- mcp-chrome:
  - <https://github.com/hangwin/mcp-chrome>
- browser-link:
  - <https://github.com/jobshimo/browser-link>
- Browser MCP:
  - <https://github.com/BrowserMCP/mcp>
- Webpage MCP:
  - <https://github.com/mcpland/webpage-mcp>
- playwright-crx:
  - <https://github.com/ruifigueira/playwright-crx>

---

## 22. One-sentence project positioning

> A capability-scoped, multi-client bridge for exposing selected tabs from a real Chrome profile through a transport-neutral CDP API, with optional WebSocket, Native Messaging, and MCP Streamable HTTP adapters.
