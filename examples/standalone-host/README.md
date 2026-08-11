# Standalone Node host

This composition owns the HTTP server, loopback transport policy, pairing presentation, filesystem lifecycle, and client authentication. It does not share an in-process client listener with the embedding application.

Set `CHROME_DEBUGGER_BRIDGE_CLIENT_TOKEN` and run `pnpm --filter @chrome-debugger-bridge-example/standalone-host start`. Pair the extension with the one-time code printed by the callback; do not expose the loopback endpoints outside the local machine.

Run `pnpm --filter @chrome-debugger-bridge-example/standalone-host smoke` to verify the packed public import.
