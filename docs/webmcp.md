# Native page WebMCP

CDB exposes the approved page's native WebMCP registrations through two stable tools:

| MCP tool | Client method | Minimum access | Lease |
| --- | --- | --- | --- |
| `browser.list_webmcp_tools` | `listWebMcpTools` | `inspect` | Shared read |
| `browser.invoke_webmcp_tools` | `invokeWebMcpTools` | `interact` | Exclusive control |

Both target the main document. There is no frame argument, frame aggregation, injected registration
hook, or JavaScript fallback. An empty native catalogue returns `tools: []`; a browser without the
native CDP WebMCP domain returns `FEATURE_UNSUPPORTED`.

## Discovery policy

The extension installation chooses discovery policy through `defineProvider` or `definePublisher`.
Configuration is fixed for the adapter lifetime; callbacks can read changing application state and
are evaluated on each listing.

```ts
import { createChromeProvider, defineProvider } from '@dvcol/cdb-extension/chrome';

const provider = createChromeProvider(defineProvider({
  connect: connectProvider,
  maximumLevel: 'interact',
  authorizeApproval,
  webMcp: {
    discovery: {
      enabled: ({ url }) => new URL(url).hostname.endsWith('.example.com'),
      include: [/^catalog_/u, 'search'],
      exclude: [
        'catalog_delete',
        /^internal_/u,
        ({ tool }) => tool.annotations?.untrustedContent === true,
      ],
    },
  },
}));
```

`connectProvider` and `authorizeApproval` are host callbacks. Schema conditions use ordinary
JavaScript or a host's existing validator; CDB adds no schema-matching dependency. For example,
`exclude: [({ tool }) => forbiddenSchema.safeParse(tool.inputSchema).success]` can use a host-owned
schema validator.

Discovery defaults to enabled with every tool included. If `include` is present, a tool must match at
least one entry; an empty include array includes nothing. Any matching exclusion wins. Matchers may
be exact names, regular expressions, or synchronous/asynchronous callbacks. Callbacks receive the
page URL, target ID, target generation, and a tool descriptor with cloned schema and annotation data.
Stateful regular expressions do not mutate the host's `lastIndex`. A thrown or rejected callback
fails the entire listing with `WEBMCP_DISCOVERY_FAILED`; CDB never returns a partly filtered list.

These controls affect discovery only. An approved caller with `interact` access may invoke a hidden
tool by name, including when discovery is disabled. Use the provider's command authorization policy
to impose additional execution restrictions. Tool annotations are page-provided hints and never
reduce the required access level or lease mode.

## Calls and references

```json
{ "targetRef": "t1" }
```

Pass this to `browser.list_webmcp_tools`. Its result contains `documentRef`, `enabled`, and `tools`.
Each tool has `name`, `description`, `toolRef`, and any native `inputSchema` and `annotations`.
Native stack traces, backend node IDs, and frame IDs are not returned.

Invoke one tool through `browser.invoke_webmcp_tools`:

```json
{ "targetRef": "t1", "toolName": "search", "input": { "query": "coffee" } }
```

Use either `toolName` or a returned `toolRef`, never both. Names resolve in the current main document
without a preceding list. References are opaque and bound to the target generation and document;
navigation, authority renewal, or removal makes them stale. List again after `WEBMCP_TOOL_STALE`.
References confer no authority. Every call still passes the current principal's grant and lease checks.

The client facade offers the same operations through an explicit existing lease:

```ts
const result = await client.listWebMcpTools({
  targetId, targetGeneration, leaseId, operationId: crypto.randomUUID(),
});
const invoked = await client.invokeWebMcpTools({
  targetId, targetGeneration, leaseId: exclusiveLeaseId,
  operationId: crypto.randomUUID(), toolName: 'search', input: { query: 'coffee' },
});
```

Acquire those leases for `Bridge.listWebMcpTools` and `Bridge.invokeWebMcpTools`, respectively.
Semantic MCP sessions acquire temporary leases and keep target generations internal. Raw native
`WebMCP.*` commands and events are reserved, including at `unsafe` access, so they cannot bypass
provider discovery and invocation handling.

## Results and interruption

Successful invocation returns `{ "status": "completed", "output": ... }`. Output may be any JSON
value and remains untrusted page content. Page tools are returned as data; they are not registered
as additional MCP tools.

Results above the broker's inline limit use its existing artifact store. Semantic WebMCP responses
contain `artifact`, `leaseId`, `expiresAt`, and `targetRef`. Read bounded base64 ranges with
`browser.read_artifact` and release with `browser.release_artifact`, supplying that target reference,
artifact ID, and lease ID. Releasing the artifact also releases its temporary lease. Session disposal,
client replacement, or target revocation releases retained leases. The lease can expire earlier than
the artifact descriptor; use the response's lease expiry. Another session cannot read the artifact.

Cancellation after dispatch attempts `WebMCP.cancelInvocation` and returns
`WEBMCP_OUTCOME_UNKNOWN`. Navigation, revocation, or transport loss may also leave an unknown outcome.
No automatic replay is performed: page effects may have happened before the result was lost.
A native tool error returns `CDP_COMMAND_FAILED`; a native cancellation returns `REQUEST_CANCELLED`.
The extension's maximum result size remains an outer bound for catalogues and invocation output.

## Native protocol basis

The implementation uses [`WebMCP.enable`, `invokeTool`, and `toolResponded`](https://chromedevtools.github.io/devtools-protocol/tot/WebMCP/).
Chrome's [DevTools session handler](https://github.com/chromium/chromium/blob/main/chrome/browser/devtools/chrome_devtools_session.cc)
permits the WebMCP domain for extension debugger clients. The
[Blink inspector agent](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/inspector/inspector_web_mcp_agent.cc)
seeds existing tools during enable. The empty catalogue has no initial event; CDB uses completion of
the enable command rather than waiting for a tools-added event. Main-document selection avoids
claiming complete same-process iframe discovery. Live verification is still required against the
Chrome build used by an embedding application.
