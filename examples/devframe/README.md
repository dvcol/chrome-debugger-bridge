# Devframe browser-control example

This example runs a CDB broker as a Devframe service, serves the public management panel, and exposes native browser tools through an MCP stdio server owned by the example. The extension sends provider messages over its existing authenticated Devframe RPC peer. Final approval comes from the extension popup.

The supported baseline is Devframe 0.9.10, DevTools Kit 0.6.1 and Vite 8.1.5. Upgrading DevTools/Vite is separate from this integration.

1. Build the affected packages: `pnpm exec turbo run build --filter @dvcol/cdb-devframe...`.
2. Build the extension: `pnpm --filter @chrome-debugger-bridge-example/devframe build:extension`.
3. Load `examples/devframe/dist/extension` unpacked in Chrome and copy its extension ID.
4. Configure an MCP stdio command running `node examples/devframe/host.ts` from the repository. Set `CDB_EXTENSION_ORIGIN=chrome-extension://<extension-id>`. The host uses port 58920 by default; `CDB_EXAMPLE_PORT` changes the example's one Devframe port.
5. Open the management panel at the host URL. Connect the extension popup to the same host and authenticate with the Devframe code printed in the host's stderr log for that connection. Keep the inspected application tab active when approving.
6. Ask the agent for `browser.request_access`, review its requested level/navigation policy in the extension popup, and approve the current tab, group or window. Run `browser.snapshot` and `browser.batch` from that same agent session.

The example's identity file lives under `examples/devframe/dist/identity`. Preserve it and the extension's storage to retain pairing across restarts. The standalone panel requests review; the popup performs the final approval and validates the selected Chrome scope.

`pnpm --filter @chrome-debugger-bridge-example/devframe smoke` checks the served panel, page-script assets and native catalogue without a browser. The focused `tests/e2e/devframe-native.test.ts` exercises real Chromium, closed shadow roots, nested cross-origin frames, overlapping grants, live group membership and provider recovery through Devframe RPC and native MCP.

The example owns its single stdio principal and process lifecycle. An application with a registry should keep its own catalogue aggregation, authenticated principal mapping and registry-only WebMCP exposure.

`devtools.ts` demonstrates mounting the same panel through DevTools Kit's existing `createPluginFromDevframe` adapter. Pass the host's existing broker client and call the returned `dispose` hook during application shutdown.
