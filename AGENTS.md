## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The default canonical triage label vocabulary is used. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses the single-context layout. See `docs/agents/domain.md`.

## Browser-control integration

Read `ARCHITECTURE.md` before changing broker, WebSocket, extension, or MCP behavior. CDB is a
transport-neutral library. Embedding hosts own application processes and MCP lifecycle. Provider
hosts own target discovery, Chrome integration, and approval UI.

Preserve these invariants:

- Authenticate a provider by its stable implementation instance ID and stored pairing.
- Model one provider per implementation installation/profile, with many targets beneath it. Keep
  provider and instance IDs available as non-secret diagnostics.
- Scope grants and target visibility to the authenticated client principal.
- Require target ID and target generation for every target-scoped operation.
- Fence an old generation immediately when authority is renewed.
- Keep generations internal to semantic MCP tools. Create one `createCdbToolSession` per principal,
  route agents through its stable `tN` target references, and dispose it with the principal.
- Prefer compact interactive accessibility snapshots, disposable `eN` references, and strict
  re-resolving locators. Arbitrary JavaScript is a debug escape hatch, not a semantic action path.
- Allow multiple grants, but reject conflicting exclusive leases without queuing or preemption.
- Treat provider recovery as bounded and recoverable; treat broker death as revocation of all live
  authority.
- Keep Chrome APIs and tab-selection policy out of CDB.
- Keep URL and navigation-grant policy out of CDB. The embedding broker may scope different
  principals differently while they share one target.
- Keep MCP definitions transport-neutral. The embedding host owns the MCP server and passes its
  authenticated session through as principal identity.
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

Run `pnpm verify` when the change affects transport, browser, extension, packaging, or example
composition behavior. Consumer applications own their approval-policy and platform-adapter tests.
