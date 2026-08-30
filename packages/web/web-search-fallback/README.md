---
description: "The DuckDuckGo Lite + Mojeek cascade provider for ctx.web: keyless web search for data-center IPs with Mojeek as the reliability fallback."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-fallback

## Summary

With `dsh-web-search-fallback`, the harness searches the web through a single cascade provider registered in `ctx.web`: **DuckDuckGo Lite first** (better index, fresher results), and — when the primary fails, typically a bot challenge against the deployment's data-center IP — **the same request retried on Mojeek** (deliberately bot-tolerant). The web seam supports exactly one provider per selection and has no built-in chain, so the fallback lives inside this one provider, which instantiates both engines itself. No API key, no JavaScript, one plain HTML GET per engine. The model-facing `web_search` tool lives in `dsh-tool-web`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web service; it registers as the `duckduckgo-lite-fallback` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: duckduckgo-lite-fallback`.

### When to choose it

Choose this backend when a deployment has no paid search API key and its egress IP is a data-center IP: DuckDuckGo (Lite and HTML) challenges such IPs with anomaly pages, while Mojeek serves them. The cascade hides that regime — quality comes from DDG Lite when it answers, reliability from Mojeek when it does not. The provider reports itself available whenever both configured engine base URLs parse and both user agents are non-empty, and every search call that fails does so with a structured error, never silently.

### Minimal configuration

Load the web service and the provider; every setting has a safe default, so no config is required.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-fallback'
```

| Field | Default | Meaning |
|---|---|---|
| `duckduckgoBaseURL` | `https://lite.duckduckgo.com/lite/` | DuckDuckGo Lite (primary) search page base; the query is appended as `?q=`. |
| `duckduckgoUserAgent` | `Mozilla/5.0` | Primary `user-agent` header. A generic browser-style agent keeps the page serving ordinary results; a bot-shaped agent risks challenge responses. |
| `mojeekBaseURL` | `https://www.mojeek.com` | Mojeek (fallback) site base; `/search?q=` is appended. Trailing slashes are stripped by the engine. |
| `mojeekUserAgent` | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36` | Fallback `user-agent` header. A full browser-style agent keeps the page serving ordinary results. |

The defaults are the engines' own tested defaults, re-exported from the two engine packages — this package configures, it never redefines them.

### Cascade policy

- A caller abort — the signal already aborted, a raw fetch `AbortError`, or a primary `WEB_ABORTED` — is **propagated immediately**: never swallowed, never retried, never masked by the fallback.
- Any other primary failure (challenge, network, HTTP, timeout) triggers the fallback with the **same request and signal**. While DDG rate-limits a data-center IP the challenge answer arrives fast, so the fallback cost is one short round trip.
- A genuinely **empty** primary result (valid response, zero sources) is returned as-is — **no fallback**, each engine has its own index.
- A fallback failure throws `WebError` `WEB_PROVIDER_ERROR` whose message names both engines (`search fallback exhausted: DuckDuckGo Lite failed (…); Mojeek also failed (…)`) and whose `cause` is the fallback error (the primary error is included in the message).

### What a search returns

The result of whichever engine answered, normalized by that engine: DDG Lite sources carry `url`, `title`, and `snippet` (its `uddg` redirect unwrapped); Mojeek sources carry `url`, `title`, and `snippet`. The seam still enforces the request's `maxResults` truncation; `truncated` reflects the answering engine.

### Failures and recovery

Engine failures — network failures, timeouts, rejected redirects, unreadable bodies, HTTP errors, challenges — are routed by the policy above; an aborted request surfaces as `WEB_ABORTED` at any point in the cascade. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the cascade; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The cascade is a router, not a new backend: it owns only the routing decision and the exhausted-cascade failure. Both engines — request dispatch, challenge detection, parsing, encoding — are the two engine packages, instantiated per operation from a fresh options snapshot (one search never mixes two config sections) and wired with arrow wrappers over the snapshot.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `CascadeSearchProvider`: engine wiring and the cascade routing policy |
| [`src/invariant.ts`](src/invariant.ts) | Package-owned invariant companion (no runtime invariant; routing is enforced at the owning seam) |

### Request flow

`search()` snapshots the options, instantiates the DuckDuckGo Lite engine, and runs the request. A primary `WEB_ABORTED`, a raw `AbortError`, or an already-aborted signal re-throws the cascade's stable cancellation error with the original reason as `cause`. Any other primary error instantiates the Mojeek engine and re-runs the same request and signal; a fallback abort is likewise propagated as `WEB_ABORTED`. Only a non-abort fallback failure builds the exhausted-cascade `WEB_PROVIDER_ERROR`, carrying both engines' error text and the fallback error as `cause`.

</details>

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which retains the answering engine's `maxResults`-bounded URLs, titles, and snippets, and the cascade's `search fallback aborted` cancellation plus `search fallback exhausted: DuckDuckGo Lite failed (…); Mojeek also failed (…)` double-failure under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the cascade is a poor fit. They are current package constraints.

- **Both engines are keyless scrapers** — markup drift on either endpoint degrades its half of the cascade (fewer sources before no sources); a challenged DDG plus a challenged Mojeek fails loud as `WEB_PROVIDER_ERROR`.
- **No per-engine result blending** — the cascade returns one engine's answer whole, never a union; an empty primary answer is returned as-is by policy.
- **The fallback adds latency only on failure** — on a challenged primary the cascade pays the primary round trip plus the Mojeek attempt (including its own single backoff retry); on success the cost is exactly one engine request.
