# Extension agent

This private workspace is the Manifest V3 agent composition. Configure the extension service worker with the broker endpoint and pairing flow, then import the public extension and browser transport entry points. The extension owns Chrome debugger attachment and selected-tab publication; the broker owns pairing credentials and client-facing authorization, so neither is exposed to page scripts.

Run `pnpm --filter @chrome-debugger-bridge-example/extension smoke` to verify the packed imports.
