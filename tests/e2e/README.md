# Native agent loop fixtures

These tests launch an isolated persistent Chromium profile with a real MV3 extension. The control path is the public MCP SDK, authenticated client WebSocket, broker, authenticated provider WebSocket, and `chrome.debugger`. MCP's local SDK hop uses `InMemoryTransport`; large debugger results use authenticated artifact HTTP. No private consumer application or user browsing data is required.

```sh
pnpm build
pnpm exec vitest run --project extension-e2e tests/e2e/native-agent-loop.test.ts tests/e2e/approval-example.test.ts
```

`deep-dom-page.ts` creates three nested frames with nonzero offsets and borders. Cross-origin mode forces OOPIFs with synthetic `*.test` hosts; same-origin mode exercises in-process frame documents. The normal payload contains approximately 10,000 DOM nodes, 200 DOM layers, and 20 shadow roots; the stress payload uses 100,000 nodes and 1,000 layers. Small page scaffolding is additional to the payload. Shadow roots can be closed, open, or alternating open/closed.

The regressions cover snapshot references, strict CSS frame-chain locators, fill/click/Enter, parent overlay occlusion, replacement during scrolling, bounded batch observation, batch revocation and navigation, and an explicit stress-size failure that leaves the target usable. The fill/click regression uses the public batch deadline; latency gates run separately with the recorded measurements below.

The approval tests build the public `examples/extension` and `examples/standalone-host/grant-flow.ts` composition. A page-origin approval must fail. Only input in the actual Chrome toolbar popup grants the selected tab; a second tab stays invisible, native snapshot and screenshot tools work, and popup revocation removes authority. Chromium does not expose toolbar popups through Playwright's page list, so `extension-popup.ts` attaches their actual CDP target and sends mouse input. It does not replace the popup with an extension tab.

The live-group test approves a group in that popup, then drives real Chrome group membership events and observes the resulting MCP target visibility. Joining tabs gain access. Leaving tabs lose the group binding while an independent exact-tab grant remains usable, including after the group becomes empty. The two client connections have independent logical sessions under the public example's shared principal; this test does not claim to exercise distinct-principal isolation.

## Repeatable measurements

Run timing measurements without other browser suites or heavy builds running:

```sh
CDB_NATIVE_BENCHMARK=1 CDB_NATIVE_BENCHMARK_SAMPLES=30 CDB_NATIVE_PERFORMANCE_GATE=1 CDB_NATIVE_BENCHMARK_OUTPUT=/tmp/cdb-native.json pnpm exec vitest run --project extension-e2e tests/e2e/native-agent-benchmark.test.ts
```

The test warms the snapshot/fill/click workflow once, then records every complete call in 30 iterations. The default action selector is a fresh snapshot reference. Set `CDB_NATIVE_BENCHMARK_SELECTOR=locator` to measure strict CSS locators, or `CDB_NATIVE_BENCHMARK_PROFILE=stress` to examine the stress case. An incomplete workflow stops measurement and fails the test; missing timing values are not treated as zero-latency success.

The opt-in gate requires warm native action p95 ≤500 ms and snapshot p95 ≤1,000 ms. Timings include the full local control path and native actionability waits. They exclude browser startup, the initial warmup, page fixture loading, and model latency. The direct Playwright reference uses at most ten iterations with open shadow roots, bypasses CDB, and measures actions only; it is a limited behavioral and timing reference.

Reports preserve all call durations, MCP argument/response sizes, underlying command counts and serialized sizes, artifact bytes, browser version, Node version, operating system, and CPU details. Token counts are estimates (`ceil(serialized JSON characters / 4)`), not model tokenizer measurements. The actual SDK-discovered catalogue is counted once, separately from a successful snapshot/fill/click workflow. Broker/CDP traffic is not counted as model context.

`CDB_MCP_BASELINE_MODULE=/absolute/path/index.mjs` loads a separately built MCP module while retaining the current fixture transport. This supports an explicitly labeled MCP-only baseline. Preserve its source revision and lockfile before rebuilding the working tree; it is not a complete historical browser-stack comparison.

## Recorded results

The [30-iteration report](measurements/native-normal-chromium-151.json) records Chromium 151.0.7922.34, Node 24.20.0, macOS arm64, and an Apple M3 Pro with 11 logical processors. All 90 measured native calls succeeded on the normal closed-shadow/OOPIF fixture.

| Measurement | Observed result |
| --- | ---: |
| Warm native fill/click p95 | 99.35 ms |
| Warm native snapshot p95 | 569.86 ms |
| Initial snapshot before warmup | 609.80 ms |
| Limited direct Playwright action p95, open roots | 31.66 ms |
| Actual MCP SDK catalogue | 65,605 characters; approximately 16,402 tokens |
| One successful snapshot/fill/click workflow | Approximately 175 tokens |

The [preserved MCP baseline](measurements/mcp-baseline-811909f.json), revision `811909f17b83fda8ca198acd0cb96573cf205ab1`, exposed 371,342 catalogue characters (approximately 92,836 tokens). Its snapshot omitted the deep controls and its warmup workflow failed; there is no successful baseline action distribution to compare. The current catalogue is 82.3% smaller by serialized character count. These reports preserve measured values, not portable performance guarantees.

These isolated Chromium results do not establish behavior in a user's main Chrome profile. That requires the same public workflow with the extension installed and the intended tab/window scope approved in that profile.
