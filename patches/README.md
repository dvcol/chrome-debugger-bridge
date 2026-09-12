# Temporary dependency patches

`@devframes/hub-ui@0.9.10` backports [Devframe PR #375](https://github.com/devframes/devframe/pull/375), commit `6df25f3a`, to the pinned embedded and standalone browser bundles. It removes toasts when their messages disappear and preserves surviving entries during full reconciliation. It does not change notification behavior for updated messages.

The patch changes only the corresponding message-feed logic in the published assets. The standalone asset is minified on one line, so its textual patch is large despite the small behavior change. No dependency versions or unrelated generated assets are changed.

Remove the patch and its `patchedDependencies` entry when a compatible Devframe upgrade includes the fix. The Vite/DevTools upgrade remains separate. `tests/e2e/devframe-notifications.test.ts` exercises both installed browser bundles through the real hub, including updates, dismissal, intentional resurfacing, and incremental/full removal.

pnpm patches apply to the consuming workspace; they are not inherited by applications installing published CDB packages. A host on hub-ui 0.9.10 needs this patch to receive the removal fix. Hosts remain responsible for their own dependency installation.
