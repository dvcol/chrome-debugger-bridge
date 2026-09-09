# Lifecycle fixes and repeated validation

Recorded on 9 September 2026 with Chromium 151.0.7922.34, Node 24.20.0, macOS arm64 and an Apple M3 Pro with 11 logical processors. Public fixtures retain 10,000 nodes, 200 DOM levels, 20 closed shadow roots and three cross-origin frame levels. No production page data is included.

## Lifecycle matrix

Run the optional matrix through the existing extension E2E:

```sh
CDB_LIFECYCLE_DIAGNOSTICS_OUTPUT=/tmp/cdb-lifecycle.json pnpm exec vitest run --project extension-e2e tests/e2e/devframe-native.test.ts
```

Each of 30 cycles reloads and acts, reconnects and acts, cancels a covered action and acts again, then revokes during a covered action, obtains another approval and acts again. Cancellation and revocation also check the ordinary shared Devframe RPC connection. The surrounding E2E retains independent overlapping grants, live group membership, navigation scope, the standalone panel and successful interaction in closed shadow roots inside nested cross-origin frames.

| Final run scenario | Cycles | Failures | Complete scenario p95 |
| --- | ---: | ---: | ---: |
| Reload and action | 30 | 0 | 1,141 ms |
| Reconnect and action | 30 | 0 | 763 ms |
| Cancel, shared RPC read and action | 30 | 0 | 777 ms |
| Revoke, shared RPC read, reapprove and action | 30 | 0 | 1,129 ms |

These are complete lifecycle scenarios, not warm single-action measurements. Machine load averages were 26.3/20.6/18.3 before and 22.2/19.9/18.2 afterward. [All lifecycle samples](./2026-09-09-lifecycle.csv) include the preliminary failures:

- Run 1 revoked a scope left empty by the earlier overlap test. The diagnostic setup now clears those earlier scopes.
- Run 2 completed 11 cycles before its rapid reapproval reached the existing two-second request rate limit. The test service now disables this throttle, and the diagnostic surfaces an early access-request error immediately.
- Run 3 timed out during discovery after reapproval in cycle 8. No input was dispatched. The 13th CDP command, an accessibility query, had not completed by the two-second deadline. This run overlapped downstream builds and shell startup.
- Run 4 completed all 120 scenarios without overlapping builds or other test suites. The original mouse-dispatch stall and Chrome crash were not reproduced. The cause of the discovery timeout remains unresolved; a clean run does not explain it.

Opt-in `cdb.mcp.action` diagnostics now include pending and failed commands, their elapsed time at action completion and dispatch status. Previously only completed commands appeared, hiding the operation that was pending at a timeout. Normal tool responses are unchanged. A stalled-dispatch regression verifies that a diagnostic remains a snapshot of the pending command even after late completion, and that input is not replayed.

## Performance gates

Both benchmarks ran sequentially after the lifecycle matrix, using their existing warmups and 30 samples. [Raw measurements](./2026-09-09-latency.csv) retain these failed gates.

| Transport and scenario | p95 | Required gate | Result |
| --- | ---: | ---: | --- |
| Devframe fill by locator | 975 ms | 500 ms | Failed |
| Devframe click by locator | 606 ms | 500 ms | Failed |
| Devframe compact snapshot | 2,188 ms | 1,000 ms | Failed |
| Devframe batch with observation | 2,219 ms | — | Measured |
| Devframe individual fill, click and snapshot | 3,383 ms | — | Measured |
| Devframe covered click | 2,284 ms | — | No input dispatched |
| WebSocket action by reference | 433 ms | 500 ms | Passed |
| WebSocket compact snapshot | 1,965 ms | 1,000 ms | Failed |

Devframe load averages were 15.8/18.6/17.8 before and 16.2/18.1/17.7 afterward. WebSocket load rose from 13.5/16.6/17.2 to 29.4/21.5/19.0. Both transports had slower snapshots than the earlier passing measurements. Different action selectors prevent a direct transport-only comparison. Contention is a plausible contributor, but is not isolated as the cause. No speculative performance optimization was applied, and the earlier passing runs do not satisfy the current gates.

All measured actions completed successfully. The covered-action duration includes delivery and event-loop overhead around the two-second input deadline. It is reported separately from successful actions. No private application loading, approval UI time or model time is included in these public benchmark results.

## Remaining validation

These results record the earlier validation attempt; its failed measurements remain part of the evidence. Public fixtures do not establish live validation in embedding applications. Upstream toast removal is fixed in [Devframe PR #375](https://github.com/devframes/devframe/pull/375). The follow-up backports that fix through a version-specific pnpm patch while retaining dependency pins. Changed notification descriptions may resurface dismissed toasts using Devframe’s existing update behavior; dismissal persistence across meaningful updates is no longer a requirement.
