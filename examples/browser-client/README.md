# Browser client

This is the generic browser-client composition: it creates a target-directory client from the browser WebSocket and `fetch` APIs only. It owns its connection and subscriptions; the host owns authentication, authorization, and the artifact endpoint.

Configure `endpoint`, `artifactEndpoint`, and an application-issued `authorization` credential, then call `createBrowserChromeDebuggerBridgeClient`. The client reconnects, restores target watching and subscriptions, can cancel an operation, receives CDP events, and retrieves authorized artifacts over HTTP.

Run `pnpm --filter @chrome-debugger-bridge-example/browser-client smoke` to verify its packed public import. The packed-consumer verifier also runs the reconnect, cancellation, event, and artifact flow against a real temporary WebSocket and HTTP bridge.
