# Node client

This is the generic Node-client composition. It owns a Node WebSocket connection and speaks the public client protocol; the host retains target authority, client authentication, event delivery, cancellation, and artifact policy.

Use `connectNodeClientWebSocket` for a raw protocol connection, or compose it with the core client facade in an application. Never put credentials in endpoint URLs.

Run `pnpm --filter @chrome-debugger-bridge-example/node-client smoke` to verify its packed public import. The packed-consumer verifier drives cancellation, CDP event delivery, and authorized artifact reads through a loopback host.
