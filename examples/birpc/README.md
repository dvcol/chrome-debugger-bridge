# Application-owned birpc adapter

This composition adapts an application-owned `birpc` RPC channel to the public generic client. It does not use upstream Devframe or Vite. Its runnable smoke flow publishes a target, acquires a lease, evaluates a command, consumes a CDP event, reads a bounded artifact, releases authority, and proves complete disposal.

The application page and `birpc` channel are only bootstrap/control composition. Once an extension accepts an expiring offer, direct extension traffic carries CDP data; the page is not in that data path. The host owns channel setup, offer policy, and credentials. The bridge only mediates the public contracts and must not receive host secrets.

Run `pnpm --filter @chrome-debugger-bridge-example/birpc smoke` to run the flow. The repository packed-package verifier repeats this command with tarball dependencies rather than workspace aliases.

See [the migration note](../../docs/migrations/cdb-birpc.md) for the pre-release package and symbol rename.
