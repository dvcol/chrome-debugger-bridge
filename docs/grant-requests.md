# Grant requests and trusted approval

A host creates one `createGrantRequestCoordinator` beside its `AuthorityStore`. Each request stores
its authenticated principal, logical session, requested capabilities, and deadline. Approval supplies
only a stored request ID and exact target references; it cannot change the principal or requested
level. Requests default to a 60-second pending deadline. `expiresAt` overrides that deadline;
`bindingExpiresAt` independently limits the resulting grant. A `null` deadline disables that expiry. A pending request also expires if its binding deadline arrives first.

```ts
const coordinator = createGrantRequestCoordinator({
  authorityStore,
  targetDirectory: {
    getProviderConnectionGeneration: principalId => authenticatedProviders.get(principalId)?.connectionGeneration,
    getTarget: targetId => {
      const target = broker.listTargets().find(candidate => candidate.id === targetId);
      const providerPrincipalId = broker.getTargetAgentPrincipalId(targetId);
      return target && providerPrincipalId ? { providerPrincipalId, target } : undefined;
    },
  },
});
const request = await coordinator.request({
  logicalSessionId: session.logicalSessionId,
  principalId: session.principalId,
  capabilities: { level: 'interact' },
});

// Derive these values from the authenticated provider connection in the host.
const provider = { principalId: connection.principal.id, connectionGeneration: connection.connectionGeneration };
const claim = coordinator.claim(request.id, provider);
const bindings = await coordinator.complete(claim, [{ targetId: target.id, targetGeneration: target.generation }]);
```

The target directory must read the host's real authenticated provider and broker directory. Do not
construct it from the approval payload. Completion checks the current provider connection, exact
target ownership and generation, requested capabilities, and logical-session principal inside the
atomic authority-store update. A claim completes once. Renewed provider connections fence old claims.
The coordinator preserves bindings owned by other requests or host policies.

`release(claim)` makes an uncompleted request available for another claim. `cancel(requestId)` revokes
that request's bindings and waits for any racing completion. Cancel each request when its logical
session ends. Call `dispose()` when the embedding host shuts down; broker death revokes all live
authority. Subscribe to coordinator changes to update approval UI and surface storage failures. Observer failures
cannot interrupt authority changes. If a store commit acknowledgement fails, the coordinator attempts
to remove only that request's bindings before returning a retryable error. If this cleanup also fails,
the request is hidden and retains its binding identities for a later `cancel` retry. The host must fail
closed for affected client/provider connections until it can confirm revocation.
Persisting requests across host restarts is deliberately outside this in-memory helper.

## Approval surfaces

The coordinator does not prove a human clicked a button. The embedding host must authenticate the
approval source before it claims or completes a request. A page message, DOM event, content-script
relay, request ID, or Chrome tab sender identifies context; none proves user consent.

`createApprovalChannel` parses strict `cdb.approval.request`, `cdb.approval.approve`, and
`cdb.approval.deny` messages. Its `onRequest` callback is a presentation intent and creates no
authority. Approve and deny require the host's `isTrustedSender` predicate.
`createExtensionApprovalSenderValidator` checks the extension ID and exact allowlisted extension
URLs, and rejects tab/content-script senders. Use an extension toolbar popup or side panel as the
final approval surface. An in-page notification can request that surface be shown. An in-page final
approval requires a separate host-established trusted channel; forwarding `window.postMessage`
through a content script cannot provide it.

The [runnable extension example](../examples/extension/README.md) includes both an in-page notification
and the actual toolbar popup. The local host has separate client and provider-control credentials.
Only the extension's private configuration contains the provider-control credential; the manifest
has no web-accessible resources. The page cannot read pending request state or install authority.
The host derives the provider identity from the live paired WebSocket connection.

When approval shares a runtime message bus with other features, unrelated listeners must decline
the message without acknowledging it. Return the approval result only after the channel's handler
settles. A generic delivery acknowledgement is not proof that the request was claimed or granted;
drive the UI from the coordinator state and expose failures instead of leaving an indefinite wait.

Hosts that replace a disconnected client must stop its reconnect loop before discarding it. Otherwise
a retired client can reconnect and replay registration beside its replacement. Keep reconnection and
registration ownership within one live client lifecycle.

## Live scopes

`createTabScopeManager` owns selected-tab publisher membership for explicit tabs, a live tab group,
or a live window. The extension host injects Chrome event/query ports and an exact-tab publisher
factory. Overlapping approved scopes share one publisher per tab. A tab leaving one scope remains
published while another approved scope includes it.

Use the grant request ID as the scope ID. On trusted approval, call `addScope(requestId, selector)`,
complete the claim with the returned targets, then reconcile the latest `getTargets(requestId)`.
After approval, send each `onTargetsChanged` snapshot to `coordinator.reconcile` with the current
authenticated provider. Reconcile replaces only that request's bindings; an empty target array
revokes its current membership. Forward successful target publications and renewals through
`updateTarget(tabId, target)` and revocations through `updateTarget(tabId, undefined)` so projected
bindings never retain an old generation.

Chrome eligibility, user detach handling, group/window selection, and URL/navigation policy stay in
the embedding host. Remove the corresponding scope when approval is withdrawn, then cancel its
coordinator request. The example explicitly approves following HTTP(S) navigation and tabs joining a
live scope; another host can enforce origin restrictions before publishing or reconciling targets.
