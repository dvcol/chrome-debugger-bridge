# Node client

This is the generic Node-client composition. It owns a Node WebSocket connection and speaks the public client protocol; the host retains target authority, client authentication, event delivery, cancellation, and artifact policy.

Use `connectNodeClientWebSocket` for a raw protocol connection, or compose it with the core client facade in an application. Never put credentials in endpoint URLs.

Run `pnpm --filter @chrome-debugger-bridge-example/node-client smoke` to verify its packed public import. The packed-consumer verifier drives cancellation, CDP event delivery, and authorized artifact reads through a loopback host.

To use the [trusted-approval example](../extension/README.md), start its host and load its generated
extension. In another terminal, set the client authorization printed by the host, then run:

```sh
export CDB_EXAMPLE_CLIENT_AUTHORIZATION='Bearer <client credential from the host terminal>'
node examples/node-client/grant-flow.ts ws://127.0.0.1:<port>/cdb/client
```

Approve the request in the extension toolbar. The client creates one `createCdbToolSession`, waits
for an authorized target, and prints a compact snapshot using its `tN` reference. Keep the client
running to retain its session; Ctrl-C disposes it and revokes that session's grants.
