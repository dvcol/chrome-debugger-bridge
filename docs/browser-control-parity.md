# Browser-control parity

This matrix compares CDB's public browser controls with the documented behavior of OpenAI computer use and Cursor Browser. It records observable capabilities, not private implementation details.

| Capability | Status | CDB owner | Notes |
| --- | --- | --- | --- |
| Authorized target discovery | supported | core and broker | Returns only targets granted to the authenticated principal. |
| Structural page snapshot | supported | MCP | Bounded DOM text with reusable backend node references. |
| Screenshot | supported | MCP | Explicit PNG, JPEG, or WebP capture with artifact externalization. |
| Pointer move and hover | supported | MCP | Coordinate movement and DOM-targeted hover. |
| Click variants | supported | MCP | Coordinate and DOM-targeted single, multiple, right, middle, back, and forward clicks. |
| Wheel scrolling | supported | MCP | Bounded coordinate wheel actions. |
| Drag | supported | MCP | Bounded multi-point pointer drag with cancellation cleanup. |
| Keyboard input | supported | MCP | Key dispatch, focused text insertion, and DOM-targeted text insertion. |
| DOM-targeted interaction | supported | MCP | Resolves snapshot references immediately and rejects stale, hidden, disabled, obscured, or geometry-free nodes. |
| Navigation and history | supported | MCP | URL navigation, back, forward, reload, and bounded lifecycle waits. |
| JavaScript dialogs | supported | MCP | Bounded observation plus accept and dismiss controls. |
| Frame-aware operation | supported | extension and MCP | Uses opaque public child-session IDs and target-generation fencing. |
| Console events | supported | MCP | Bounded event subscription. |
| Network events and response bodies | supported | MCP | Bounded event subscription and artifact-aware response bodies. |
| Arbitrary CDP commands | raw-only | MCP | Optional, capability-gated raw catalogue for commands without semantic tools. |
| File upload and downloads | host-owned | extension host | Chrome permissions, paths, and user policy stay outside CDB. |
| Clipboard access | host-owned | extension host | The host owns site and user policy. |
| Tab discovery and selection | host-owned | extension host | CDB receives already-authorized targets and never discovers Chrome tabs. |
| Approval prompts and site allowlists | host-owned | extension host | The embedding extension owns consent, origin policy, and request presentation. |
| Visible control disclosure | host-owned | extension host with `@dvcol/cdb-extension/presentation` | CDB supplies an opt-in pointer and favicon presenter; the host installs it and supplies current grant state. |
| Browser profile creation or persistence | intentionally excluded | browser host | CDB attaches to existing authorized tabs and does not manage browser profiles. |
| Hiding Chrome debugger disclosure | intentionally excluded | Chrome | CDB does not suppress browser-owned security UI. |

## Behavioral references

- [OpenAI computer use](https://developers.openai.com/api/docs/guides/tools-computer-use) documents the screenshot and action loop used for click, move, drag, scroll, keyboard, typing, and wait behavior.
- [ChatGPT browser extension](https://learn.chatgpt.com/docs/chrome-extension) documents browser access prompts and site permissions. CDB leaves those decisions with its embedding host.
- [Cursor Browser](https://prod.cursor.com/docs/agent/tools/browser) documents navigation, history, refresh, click variants, hover, typing, scrolling, screenshots, console output, and network traffic.

## Security boundary

Every target-scoped operation requires the target ID and current generation. Semantic actions use the same broker authorization and lease path as raw CDP. CDB does not infer a tab, weaken a requested access level, or move navigation policy into the transport-neutral core.
