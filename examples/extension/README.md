# Extension agent with trusted approval

This runnable Manifest V3 example composes the public approval channel, live tab-scope manager,
selected-tab publishers, pairing store, and authenticated WebSocket transport. The actual toolbar
popup approves a pending request for the current tab, its live group, or its live window. Group and
window scopes include tabs that join later; overlapping scopes share one debugger publisher.

From the repository root, run:

```sh
pnpm build
pnpm --filter @chrome-debugger-bridge-example/standalone-host approval
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the generated
`examples/extension/dist` directory printed by the host. Open the host's example-page URL in that
browser profile. Start the [Node client](../node-client/README.md) using the endpoint and client
credential printed by the host, then open the extension toolbar popup and choose **Allow INTERACT**.
The client prints a semantic snapshot of the approved page. The popup also lets you revoke access.

The in-page notification only asks the extension to present its approval surface. Page-origin
approve/deny payloads are rejected. Final approval requires the extension's own popup URL and a
runtime sender without a tab. The generated configuration contains a private provider-control
credential and one-time pairing code; it is not web-accessible. Client credentials are separate.
The sample host and configuration are local development examples; restarting the host requires
rebuilding and reloading the extension.

The example's visible policy allows HTTP(S) navigation within an approved tab and includes future
members of live scopes. A production host owns any narrower URL policy and recovery lifecycle. See
[grant requests and trust boundaries](../../docs/grant-requests.md).

The build compiles the TypeScript service worker, popup, and content script into `dist`; Chrome loads
only those generated JavaScript files. `pnpm typecheck` checks all example sources without emitting
files beside them.

Run `pnpm --filter @chrome-debugger-bridge-example/extension smoke` to verify the packed public imports.
The extension end-to-end test exercises the actual popup and rejects page-origin approval.
