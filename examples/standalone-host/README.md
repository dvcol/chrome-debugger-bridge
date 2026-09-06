# Standalone Node host

This composition owns the HTTP server, loopback transport policy, pairing presentation, filesystem lifecycle, and client authentication. It does not share an in-process client listener with the embedding application.

Set `CHROME_DEBUGGER_BRIDGE_CLIENT_TOKEN` and run `pnpm --filter @chrome-debugger-bridge-example/standalone-host start`. Pair the extension with the one-time code printed by the callback; do not expose the loopback endpoints outside the local machine.

Run `pnpm --filter @chrome-debugger-bridge-example/standalone-host smoke` to verify the packed public import.

For the complete trusted-approval example, run
`pnpm --filter @chrome-debugger-bridge-example/standalone-host approval` after `pnpm build`. This starts
an authenticated loopback host and builds the [loadable extension](../extension/README.md). It uses
`createGrantRequestCoordinator` and a store-backed logical client session. Each connecting client
requests `interact`; targets remain invisible until trusted extension approval installs exact
bindings. Client disconnection cancels its requests and terminates the logical session.

The example control HTTP endpoint has a separate generated bearer credential installed only in the
extension configuration. It derives provider identity from the live paired provider connection and
never accepts a principal or requested capabilities from approval payloads. The smoke command starts
the host, verifies that an authenticated client has no targets before approval, rejects anonymous
control access, and verifies request cleanup on shutdown.
