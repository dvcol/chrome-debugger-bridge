# `@dvcol/cdb-extension`

Manifest V3 helpers for publishing approved Chrome targets, recovering connections, and presenting browser control.

```sh
pnpm add @dvcol/cdb-extension
```

```ts
import { createBirpcAgentBootstrap } from '@dvcol/cdb-extension/bootstrap';
```

The embedding extension owns Chrome selection policy and approval UI. See the [repository documentation](https://github.com/dvcol/chrome-debugger-bridge#readme) for the provider trust boundary.

## Optional Chrome adapter

Import `createChromeProvider` and `getChromeProviderIdentity` from `@dvcol/cdb-extension/chrome` to compose debugger, tab, navigation, alarm and storage bindings. Supply a `connect` callback returning a provider connection, `maximumLevel`, and an `authorizeApproval` callback that validates the final approval source and tab-selection policy. A page message alone does not establish a human decision.

Use `provider.approve(requestId, selector, approvalContext)` from the trusted approval channel. The adapter shares one publisher per tab across overlapping scopes, reconciles live group/window membership, renews target generations on top-level navigation, and recovers through its supplied connection factory. `provider.dispose()` revokes its scopes and detaches publishers before closing its CDB channel.

The host chooses installation, recovery and pairing storage keys. Preserve those keys when adopting the adapter. Chrome session storage supports publication recovery but is never itself proof of approved authority.

The `@dvcol/cdb-extension/notifications` entry supplies a headless notification controller and an optional neutral shadow-root renderer. Both derive state from the broker; local dismissal never changes authority. Review actions open the host's final approval UI. Branding and CSS are optional renderer inputs.

See the [Devframe example](../../examples/devframe/README.md) for a complete composition over an existing RPC peer.

### Notification presentation

`@dvcol/cdb-extension/notifications` exports a headless controller and an optional
Shadow DOM renderer. The controller does not access the DOM or install theme
listeners. A host may render its state itself, or use
`renderBrowserControlNotifications` with the default CDB card.

The renderer accepts `colorMode: 'system' | 'light' | 'dark'` (default: `system`),
`theme`, `branding`, and optional `css`. `defaultBrowserControlNotificationTheme`
and the exported theme types describe the light/dark palettes, grant colors,
spacing, typography, radii and shadow. Tokens become namespaced `--cdb-*` CSS
variables. Precedence is default theme, supplied theme values, explicit branding,
then custom CSS. Prefer theme values for normal customization.

Call `setTheme` or `setColorMode` on the returned renderer to change presentation
without replacing buttons, losing focus or restarting pending actions. System
mode follows OS preference through CSS; explicit modes override it. The host
owns placement and may supply its title, client labels, Review/Accept label and
approval/rejection callbacks. Dismiss only hides a request; it does not reject it.
Devframe hosts should use the Devframe notification adapter instead of this DOM
renderer.

### Page request correlation

`createPageRequestBridge` matches response type, source, origin and correlation
identifier, with one deadline and listener cleanup for success, cancellation,
timeout and disposal. Supply the receiving and target windows, target origin and
application message names. Readiness probes and approval acknowledgements use
the same request method. A correlated message is **not** proof of human approval:
the host must validate Chrome senders and own the final approval channel.
