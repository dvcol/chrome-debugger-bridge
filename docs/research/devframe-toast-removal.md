# Devframe 0.9.10 toast removal

Status: reproduced during browser validation on 8 September 2026. This is an unresolved presentation limitation of the pinned host UI.

## Public reproduction

Mount a page script in a Devframe 0.9.10 host using its embedded hub UI. The following synthetic script needs no browser provider, grant, application data, or CDB authority:

```ts
interface NotificationContext {
  messages: {
    info: (
      message: string,
      options: { id: string; notify: boolean; autoDismiss: false },
    ) => Promise<{ dismiss: () => Promise<void> }>;
  };
}

export default async function reproduceToastRemoval(context: NotificationContext): Promise<void> {
  const notification = await context.messages.info('Synthetic pending request', {
    id: 'synthetic-request-removal',
    notify: true,
    autoDismiss: false,
  });
  await new Promise(resolve => setTimeout(resolve, 3_000));
  await notification.dismiss();
}
```

Expected: the notification disappears from both the message list and the visible toast list after three seconds.

Observed: the message entry disappears, while its toast remains visible. Repeating request/approval/revocation sequences leaves obsolete request and active-control toasts.

## Boundary and regression coverage

Inspection of the installed `@devframes/hub-ui` 0.9.10 embedded bundle shows that `src/client/state/messages.ts` deletes `removedIds` from the message map without removing their entries from `src/client/state/toasts.ts`. The page script uses the supported handle's `dismiss()` method, which removes the host message over RPC.

CDB's `packages/devframe/test/page-script.test.ts` verifies that ended requests unregister their commands and dismiss their host messages. That test establishes CDB cleanup, not the host's visible toast behavior. The reproduction above remains a manual browser regression until the host UI is fixed; it is not a passing automated acceptance test.

Broker grants, pending requests, and the mounted CDB panel update correctly. Obsolete toasts must not be treated as current authority. Keep the existing dependency pins; resolve this through the host UI separately, without patching installed dependencies or introducing a second notification renderer in CDB.
