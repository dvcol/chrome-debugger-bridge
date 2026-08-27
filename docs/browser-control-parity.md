# Browser-control parity

CDB uses Playwright as the correctness benchmark and agent-browser/Codex as the agent interaction
benchmark. It retains a stricter authority model for multiple principals, grants, leases, and target
generation fencing.

| Capability | Status | CDB behavior |
| --- | --- | --- |
| Principal-scoped target discovery | supported | Semantic tools expose stable `tN` references; trusted diagnostics retain raw IDs and generations. |
| Compact interactive snapshot | supported | Bounded accessibility tree with fresh monotonic `eN` references. |
| Complete accessibility snapshot | supported | Explicit bounded `accessibility` mode. |
| Diagnostic DOM snapshot | supported | Explicit `dom` mode; screenshots remain a separate tool. |
| Semantic find | supported | Small contextual matches using the same locator resolver as actions. |
| Locator model | supported core subset | Role/name, text, label, placeholder, alt, title, test ID, CSS, descendants, frame chains, `has`, text/visibility/exclusion/`nth` filters. |
| Shadow DOM | supported | Open and closed author roots are pierced by default; user-agent roots are excluded. |
| Frames | supported | Same-process frames and OOPIF child sessions. |
| Strictness and actionability | supported | One strict match; bounded visible, stable, enabled/editable, scroll, and hit-target checks. |
| Locator actions | supported | Click, hover, focus, fill, type, press, check, uncheck, select option, scroll into view, and drag. |
| Coordinate actions | supported | Explicit `_at` tools for pointer movement, click, wheel, and drag. |
| Navigation and lifecycle | supported | Navigate, back, forward, reload, bounded load waits, and dialogs. |
| Console, network, screenshot | supported | Bounded inspection and artifact-aware large results. |
| Visible agent control | supported host component | `@dvcol/cdb-extension/presentation` supplies pointer movement/click feedback and a grant-lifetime controller-count favicon. |
| Generation-safe retry | stronger than benchmark | Reads and locator resolution can renew transparently; actions retry only before input and never replay uncertain input. |
| Multiple agents | stronger than benchmark | Principal-scoped grants plus compatible shared and exclusive leases. |
| Arbitrary JavaScript/CDP | debug/raw only | Explicit escape hatch; bypasses locator and pointer guarantees. |
| Snapshot diffs | deferred | Version one returns complete fresh compact snapshots. |
| Full Playwright selector language and XPath | deferred | The first release uses the serializable core locator model. |
| File upload, downloads, clipboard | host-owned | Browser permissions, paths, and user policy stay outside CDB. |
| Tab discovery, selection, approval | host-owned | CDB receives already-authorized targets and never discovers Chrome tabs. |
| Chrome debugger disclosure | intentionally excluded | Browser-owned security UI is never hidden. |

## Behavioral references

- [Playwright locators](https://playwright.dev/docs/locators) define re-resolution, strict matching,
  frames, and author-shadow behavior.
- [Playwright actionability](https://playwright.dev/docs/actionability) defines visibility, stability,
  enabled/editable, and hit-target checks.
- [agent-browser](https://github.com/vercel-labs/agent-browser) provides the compact accessibility
  snapshot and disposable-reference interaction model.
- [OpenAI computer use](https://developers.openai.com/api/docs/guides/tools-computer-use) documents
  the visible action loop used as the presentation benchmark.

## Security boundary

Semantic callers never supply a generation. A tool session resolves its `tN` reference to the exact
current target generation before acquiring a lease or dispatching CDP. Raw lease/CDP/provider APIs
continue to require exact target ID and generation. CDB does not infer a tab, weaken a requested
access level, or move navigation and approval policy into the transport-neutral core.
