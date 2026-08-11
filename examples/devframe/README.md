# Devframe adapter

This composition adapts an isolated Devframe RPC channel to the public generic client. Configure the host-side channel and inject it into the adapter before connecting a client. The Devframe host owns its channel and authorization policy; the bridge package owns only protocol mediation and must not receive host credentials.

Run `pnpm --filter @chrome-debugger-bridge-example/devframe smoke` to verify its packed imports.
