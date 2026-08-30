---
description: "The Mojeek-backed search provider for ctx.web: how deployments mount keyless, bot-tolerant plain-HTML web search as a fallback for data-center IPs."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-mojeek

## Summary

With `dsh-web-search-mojeek`, the harness searches the web through Mojeek — a deliberately bot-tolerant, independent search engine — by scraping its plain-HTML endpoint. It needs no API key and no JavaScript, which makes it a reliable fallback for data-center IPs that DuckDuckGo (Lite and HTML) challenge with HTTP 202 anomaly modals. Mojeek exposes no timestamps, so sources carry `url`, `title`, and `snippet` only. The model-facing `web_search` tool lives in `dsh-tool-web`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web service; it registers as the `mojeek` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: mojeek`.

### When to choose it

Choose this backend when a deployment has no paid search API key and its egress IP is a data-center IP that paid-key-free providers challenge. The endpoint needs no credentials; the provider reports itself available whenever the configured base URL is parseable and the user agent non-empty, and every search call that fails does so with a structured error, never silently.

### Minimal configuration

Load the web service and the provider; every setting has a safe default, so no config is required.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-mojeek'
```

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `https://www.mojeek.com` | Mojeek endpoint base; `/search` is appended. Trailing slashes are stripped |
| `userAgent` | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36` | `user-agent` header for every request. A full browser-style agent keeps the page serving ordinary results; a bot-shaped agent risks challenge responses. |

### Endpoint and query encoding

One `GET {baseURL}/search?q=<query>` per search, with a browser-style `user-agent`. The query is form-encoded through `URLSearchParams`, so spaces become `+`. HTTP redirects are rejected (`redirect: 'error'`) and fail the request.

> **Warning:** the query must stay form-encoded (`+` for spaces). Never switch to `encodeURIComponent` — Mojeek's WAF challenges `%20`-encoded queries from data-center IPs with a JavaScript captcha even when requests are spaced out (verified 2026-08-29).

### What a search returns

Each result row (`<li class="rN">` inside `<ul class="results-standard">`) maps to a `WebSearchSource`: the direct target URL from the row's `ob` anchor (no redirect unwrapping), the row's `<h2>` as `title`, and `<p class="s">` as `snippet`. Page order is preserved, duplicate URLs are dropped, and no timestamps are emitted. A request's `maxResults` caps the sources at the provider as well as at the seam, with a default cap of 8 when the request omits it; `truncated` is always `false` from this provider, since the seam owns the final bound. An empty result page returns `content: 'No results from Mojeek for "<query>".'` with no sources.

### Bot tolerance, burst rate-limiting, and challenges

Mojeek is bot-tolerant but still rate-limits bursts: several requests in a short window from one (data-center) IP get a JavaScript captcha page (HTTP 200, `<title>Captcha</title>`). The plain-HTML client cannot solve it; the challenge expires after a short cooldown (minutes). The provider detects a challenge as any of: HTTP 403 or 429, a `<!-- status="…" -->` head marker whose value is not `OK`, or captcha-style markup in the body. A challenged request is retried **once** after a ~10 s jittered backoff, which covers burst edges; a second challenge fails loud as `WebError` `WEB_PROVIDER_ERROR` with a challenge message so the caller can wait out the cooldown or switch providers. Keep request volume low: one request per search, as the seam does.

### Failures and recovery

Provider failures — network failures, timeouts (20 s per attempt), rejected redirects, unreadable bodies, and non-challenge HTTP errors — surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`, including an abort that fires while the backoff delay is in flight. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin scraper with two deliberate rules:

- **Direct targets only.** The `ob` anchor carries the real destination, so sources are citeable URLs without a redirect hop, and non-`http(s)` or malformed targets are dropped rather than normalized.
- **Fail loud on challenges.** A challenge is never answered by retrying indefinitely: exactly one backoff retry, then a routable `WEB_PROVIDER_CHALLENGED`, because the cooldown is minutes long and burning requests extends it.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `MojeekSearchProvider`: request dispatch, challenge detection and retry, HTML parsing |

### Request and parsing flow

`search()` form-encodes the query with `URLSearchParams`, fetches with `redirect: 'error'`, a 20 s timeout per attempt, and the caller's signal combined in, then reads the body as text. A challenge (403/429, non-`OK` status marker, or captcha markup) triggers one jittered ~10 s backoff — abortable, rejecting as `WEB_ABORTED` when the caller cancels — and a single retry. Otherwise the body is sliced to the `results-standard` list, row by row: the `ob` anchor's href is validated as an absolute `http(s)` URL, the `<h2>` and `<p class="s">` are stripped of markup and entity-decoded into `title` and `snippet`, and duplicates by URL are dropped.

</details>

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which retains this provider's `maxResults`-bounded URLs, titles, and snippets, its exact `No results from Mojeek for "<query>".` content on empty pages, and its `Mojeek request timed out after 20000 ms`, `Mojeek search request failed: <error>`, `Mojeek response body unreadable: <error>`, `Mojeek search failed (HTTP <status>)`, `Mojeek search aborted`, and `Mojeek returned a bot challenge (HTTP <status>)…` / `Mojeek returned a challenge page instead of results…` failures under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the provider is a poor fit. They are current package constraints.

- **Burst rate-limiting is real** — a challenged IP needs a cooldown of minutes; the single backoff retry only covers burst edges, and a sustained challenge (`WEB_PROVIDER_ERROR` with a challenge message) means waiting or switching providers.
- **No generated answer and no timestamps** — Mojeek exposes neither, so results carry `url`/`title`/`snippet` only and `content` is set solely on empty pages.
- **Plain-HTML scraping is brittle to markup changes** — Mojeek reworking the `results-standard` list, the `ob` anchor, or the `<h2>`/`<p class="s">` rows degrades results silently (fewer sources) before breaking them; the live-capture fixture pins the current shape.
- **One fixed retry policy** — the backoff (~10 s, ±20 % jitter), the 20 s per-attempt timeout, and the 8-source default cap are protocol constants, not config.
