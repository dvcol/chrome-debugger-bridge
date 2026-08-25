## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The default canonical triage label vocabulary is used. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses the single-context layout. See `docs/agents/domain.md`.

## Browser-control integration

Read `ARCHITECTURE.md` before changing broker, WebSocket, extension, or MCP behavior. CDB is a
transport-neutral dependency of DevKit and QA Helper. It must not start a DevKit daemon, discover a
Chrome tab, show approval UI, or add one MCP host per Vite server.

Preserve these invariants:

- Authenticate a provider by its stable implementation instance ID and stored pairing.
- Model one provider per implementation installation/profile, with many targets beneath it. Keep
  provider and instance IDs available as non-secret diagnostics.
- Scope grants and target visibility to the authenticated client principal.
- Require target ID and target generation for every target-scoped operation.
- Fence an old generation immediately when authority is renewed.
- Allow multiple grants, but reject conflicting exclusive leases without queuing or preemption.
- Treat provider recovery as bounded and recoverable; treat broker death as revocation of all live
  authority.
- Keep Chrome APIs and tab-selection policy out of CDB.
- Keep MCP definitions transport-neutral. DevKit owns the MCP server and passes its current RPC
  session through as principal identity.
- Return structured errors with retry hints where retry can succeed.

The user-visible access levels are `observe`, `inspect`, `interact`, `debug`, and `unsafe`. Do not
silently downgrade a requested level.

## Validation

Run the repository gates before handing off a CDB change:

```sh
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

For changes to public transport types, rebuild the affected package before testing linked DevKit or
QA Helper. Also run DevKit's `src/broker/runtime.test.ts`, which verifies authenticated pairing,
multiple grants, lease conflicts, recovery, generation fencing, and principal disconnect behavior.

Do not claim the local browser-control proof is complete from unit tests alone. The end-to-end gate
must load QA Helper, accept a request in a real tab, and execute debugger actions through DevKit.
