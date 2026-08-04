# CDP capability catalogue

The Chrome Debugger Bridge is a thin authorization layer over `chrome.debugger`. The bridge classifies command and event names, while Chrome remains responsible for validating native CDP parameters and producing native responses and events.

## Capability hierarchy

The levels are cumulative:

1. `observe` receives lifecycle and low-sensitivity metadata.
2. `inspect` reads page, runtime, network, storage, and diagnostic content.
3. `interact` changes ordinary page or browser behavior, including navigation, input, DOM mutation, emulation, and script execution.
4. `debug` controls intrusive or stateful developer instrumentation such as breakpoints, interception, profiling, and tracing.
5. `unsafe` covers known high-impact entries plus commands and events absent from the reviewed catalogue.

`observe` is the default. `observe` and `inspect` use shared-read authority; the remaining levels require exclusive-control authority.

An exact-name `allow` list covers both commands and events. It adds names when a level is present and is the complete grant when no level is present. Exact names also opt into native payload changes that postdate the pinned schema.

## Thin-wrapper boundary

CDP parameters, responses, and event payloads pass through without catalogue-level validation or rewriting. Large responses retain the authority of their originating command when transported as artifacts.

The bridge owns target discovery, attachment, and native domain activation. `Target.*` plus native `enable` and `disable` commands therefore remain outside the client catalogue. Eligible flat child sessions inherit their published root grant through opaque bridge session identities.

## Generation and review

[`cdp-classification-policy.ts`](../packages/core/scripts/cdp-classification-policy.ts) contains the supported `chrome.debugger` domain list, broad domain defaults, and the small set of direct-purpose overrides. [`cdp-catalogue.generated.ts`](../packages/core/src/cdp-catalogue.generated.ts) is the complete generated catalogue used by runtime enforcement.

The source protocol is pinned through the workspace `protocol` catalogue. Regenerate and verify the artifact with:

```sh
pnpm run catalogue:generate
pnpm run check:catalogue
```

Protocol updates must include the generated diff. The check fails when the committed artifact no longer matches its pinned protocol input and classification policy.
