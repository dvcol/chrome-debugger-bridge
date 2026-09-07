# Native tab control MVP

CDB supplies transport-neutral authority and browser-control modules. Embedding applications own approval UI, policy, platform bindings, and process lifecycle. The runnable [approval example](../examples/extension/README.md) composes the public modules without application-specific dependencies. See [grant requests](grant-requests.md) for the trust contract and scope lifecycle.

## Agent interface

Keep one `createCdbToolSession` per authenticated principal. Its `tN` references remain stable across target generation changes. Snapshot and find results issue disposable `eN` references. A refreshed observation invalidates earlier element references for that target. A detached reference fails stale; a strict locator can resolve a replacement before input. CDB never automatically retries an action after input may have been dispatched.

Use an interactive snapshot, then reference-based actions for the shortest arguments and fastest iteration. Use locators when the application rerenders. `browser.find` resolves its complete candidate set before deciding uniqueness. When the result display limit is reached, it returns `{matches, totalMatches, truncated:true}` instead of silently shortening the list. A discovery limit returns `MCP_SEARCH_INCOMPLETE`.

Unscoped locators search the root document and nested frame contexts. An explicit `frameChain` narrows that search. Accessibility discovery forwards cancellation so a stalled command cannot keep a batch running past its deadline. Fill verification accepts Chrome's omitted empty accessibility value only when the control node is still present.

Interactive snapshots include names, values and control states. The default text budget is 6,000 characters, approximately 1,500 tokens using a characters-divided-by-four estimate. This is a character limit, not a model tokenizer guarantee. `maximumCharacters` and `maximumNodes` control display; structural DOM depth does not truncate interactive discovery. Truncation preserves complete reference annotations and adds an explicit notice. Expand a subtree with `root: {ref: "e1"}` or `root: {locator: {...}}`.

Debug evaluation, raw leases, artifact tools, and network/console diagnostics require `enableRawCdp: true`. The default catalogue shares repeated JSON schemas using `$defs`; runtime argument validation remains complete.

Default screenshots return MCP image content and release temporary artifacts internally. Debug sessions retain the inline-or-artifact result for explicit inspection.

## Batches

`browser.batch` runs ordered element actions on one target under one exclusive lease. The default total deadline is 30 seconds, with at most 20 actions. The first catalogue contains click, fill, type, press, check, uncheck, focus, hover and scroll-into-view. Navigation commands are excluded.

```json
{
  "targetRef": "t1",
  "actions": [
    {"action": "fill", "ref": "e1", "text": "Example"},
    {"action": "click", "ref": "e2"}
  ],
  "observe": true
}
```

Each step calls the same implementation as its individual tool. Success returns `completed` entries with zero-based indices and action names. `observe` adds a final compact snapshot. Failures use the standard `code`, `message`, `retryable` and `details` error envelope. `details.completed` records successful steps, `details.failedStep` identifies the failed step, and `details.uncertain:true` means input may have occurred. A final observation failure uses `details.phase: "observation"`. Cancellation, target authority replacement, or document replacement stops subsequent steps. Completed actions are not rolled back or replayed. If final observation fails, completed actions remain recorded.

## Browser behavior and limits

Native discovery covers open and closed author shadow roots, in-process frame documents, and cross-origin debugger child sessions. CSS queries execute in each document and author shadow root. CSS descendant combinators follow native tree boundaries; use locator `descendants` or `frameChain` to express cross-boundary scope. XPath follows Chrome's native XPath behavior and does not pierce shadow roots.

Flat DOM discovery uses `DOM.getFlattenedDocument` because recursive `DOM.getDocument` responses can exceed `chrome.debugger`'s JSON conversion stack on the normal deep-tree fixture. Chrome marks this command deprecated. The real-browser suite verifies its behavior on the recorded Chromium version; this compatibility dependency must be checked when updating Chromium. Unsupported or oversized traversal must fail explicitly.

Pointer and focused input check local hit targets and ancestor frames, including scroll offsets, borders, and fractional frame dimensions. Input uses viewport coordinates; hit tests use document coordinates. Fill and check verify resulting control state. Verification failure or an uncertain result requires a fresh observation before the caller decides what to do next.

The extension publisher limits each debugger result to 16 MiB by default, configurable through `maximumResultBytes`. Hosts should set this within their transport and artifact budgets. Oversized results fail before transmission so the provider connection remains usable. Native snapshots read bounded artifacts and release them through authenticated HTTP deletion. Custom HTTP hosts must implement the optional `releaseArtifact` callback to reclaim stored replies promptly.

## Regression matrix

| Area | Public regression coverage |
| --- | --- |
| Display depth and breadth | 1, 200 and 1,000 levels; 1, 10,000 and 100,000 controls; complete reference annotations; bounded text |
| Native DOM boundaries | 20 nested open/closed/mixed roots; three same-origin and cross-origin frame levels; strict CSS excludes script text |
| Targeting | Ambiguity, output-limited matches, frame scopes, descendant filters, rerender before input, stale refs |
| Actionability and outcomes | Hidden, disabled, readonly, covered and moving controls; parent overlays; filled values; boolean/string/indeterminate checked state; Enter activation |
| Batch lifecycle | Ordered steps, one lease, uncertain dispatch without replay, revocation, navigation and final observation |
| Authority and approval | Principal isolation, concurrent/replayed decisions, stale claims, expiry/cancellation, failed stores, provider takeover, overlapping bindings and resume |
| Live membership | Shared per-tab publication, joining/leaving scopes, closed groups/windows, late attachment, stale queries, tab ID reuse and stop/restart |
| Transport | Authenticated extension-to-broker execution, bounded oversized replies without connection loss, owner-only artifact deletion |

The normal browser fixture contains up to 10,000 DOM nodes, 200 DOM levels, 20 nested shadow roots and three frame levels. The stress fixture increases this to 100,000 nodes and 1,000 levels. Mocked protocol tests supplement the real Chromium tests; they do not establish browser behavior.

Run `pnpm verify` for build, unit tests, type checks, lint (including browser import restrictions), Chromium browser tests, extension tests, package boundaries and package-consumer checks. Performance acceptance is warm single-action p95 at or below 500 ms and compact-snapshot p95 at or below one second on the normal fixture. Record the environment and raw samples; exclude model time and explicit application waits. Token reports must identify their estimator and include catalogue, arguments, responses and workflow costs.

The [recorded 30-iteration run](../tests/e2e/measurements/native-normal-chromium-151.json) on Chromium 151, Node 24 and an Apple M3 Pro completed 90 calls without errors: action p95 was 99 ms and snapshot p95 was 570 ms. The SDK catalogue was approximately 16,402 estimated tokens, and one snapshot/fill/click workflow was approximately 175 estimated tokens. The [preserved MCP baseline](../tests/e2e/measurements/mcp-baseline-811909f.json) omitted the deep controls and failed its warmup, so it has no successful latency distribution. Its catalogue was approximately 92,836 estimated tokens. See the [measurement instructions](../tests/e2e/README.md) for reproduction and the limited open-shadow-root Playwright comparison.

Embedding hosts must also validate their chosen non-persisting workflow in the user's main browser profile. Production URLs, captured DOM and application identifiers stay outside this repository. Convert failures into synthetic public regressions before considering the integration complete.
