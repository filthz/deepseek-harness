# Agent Note: Keyless web search with a Mojeek fallback for challenged data-center IPs

Status: proposed

English | [中文](2026-08-29-keyless-search-fallback-cascade.zh.md)

## Problem

The keyless DuckDuckGo Lite provider ([`@deepseek-ai/dsh-web-search-duckduckgo`](../../packages/web/web-search-duckduckgo/README.md)) serves real web-index results without an API key, but DuckDuckGo answers data-center IPs with a JavaScript bot challenge (HTTP 202 plus anomaly page) after a short burst of requests, and the challenge expires only after a cooldown measured in minutes. A single-engine keyless search provider on such an IP therefore has to trade quality for reliability: DuckDuckGo Lite has the larger, fresher index and exposes timestamps, while the bot-tolerant Mojeek endpoint returns results steadily but from a smaller index and without dates.

The Mojeek endpoint carries its own data-center-IP rule that was not visible from the documentation: queries whose space is percent-encoded (`q=a%20b`) get the JavaScript captcha page on every request, while the same query form-encoded (`q=a+b`) with identical headers returns results. A three-replicate controlled run (Node fetch and curl, both encodings, spaced requests) showed 3/3 challenges for `%20` and 3/3 results for `+`. Any plain-HTML Mojeek client that builds its query with `encodeURIComponent` is therefore challenged by default.

## Proposal

Add two packages and register one new provider id; change no default.

`@deepseek-ai/dsh-web-search-mojeek` (provider id `mojeek`) implements the keyless Mojeek provider against `GET https://www.mojeek.com/search?q=…`. Its query is built with `URLSearchParams` so spaces become `+`; the source carries a warning comment against switching to `encodeURIComponent` because of the WAF rule above. It applies a 20-second request timeout, retries a challenged request once after a ~10-second jittered backoff, and raises `WEB_PROVIDER_ERROR` on 403/429, a `<!-- status=… -->` head marker other than `OK`, or captcha markup; caller cancellation is `WEB_ABORTED`.

`@deepseek-ai/dsh-web-search-fallback` (provider id `duckduckgo-lite-fallback`) is a cascade provider that instantiates the existing `duckduckgo-lite` provider as primary and the `mojeek` provider as fallback, in the style of the other search packages. Its policy: an abort (already-aborted signal or `WEB_ABORTED` from the primary) propagates without a fallback attempt; any other primary failure (typically `WEB_PROVIDER_ERROR` for the challenge) triggers the fallback with the same request and signal; a valid primary result with zero sources is returned as-is because each engine indexes different pages; a failing fallback raises `WEB_PROVIDER_ERROR` whose message names both engines and whose `cause` is the fallback error. The web seam accepts exactly one provider id per `searchProvider` value, which is why the fallback lives inside one provider instead of a seam-level chain.

Both packages follow the web package conventions: typed `WebSearchProvider`, options resolved through a per-operation `resolveOptions()` function, `schemastery` config schema with defaults, an explained empty `./invariant` companion, offline unit tests plus one recorded-style e2e test each, and 100 percent per-file coverage.

Nothing in `@deepseek-ai/dsh-base` changes: the packages are available but not base-active, the same posture as [`@deepseek-ai/dsh-web-search-exa`](../../packages/web/web-search-exa/README.md) and [`@deepseek-ai/dsh-web-search-perplexity`](../../packages/web/web-search-perplexity/README.md), and consistent with the [default-search decision](../implemented/feature/2026-07-31-web-default-search.md), which keeps the shipped composition default keyed; the cascade remains a profile-level opt-in. A profile opts in by setting `searchProvider: duckduckgo-lite-fallback` (or `mojeek`) on the web seam entry.

The same branch also closes two gate gaps of the already-landed `web-search-duckduckgo` package on that branch: it gains the mandatory `./invariant` companion (exports, `files`, `dsh-invariants` peer and dev dependency, project reference) and an offline test suite with 100 percent per-file coverage, because the repository coverage gate instruments every file under `packages/*/*/src`.

## Alternatives considered

Backoff and retry inside the DuckDuckGo provider alone. Rejected: the observed cooldown runs for minutes, so in-call retries waste the tool budget and still fail during a block; retries only soften the burst edge, which the Mojeek provider's single backoff retry already covers for its own endpoint.

Pinning a single engine (Mojeek only, since it is the reliable one from this class of IP). Rejected: it permanently gives up DuckDuckGo's larger index and timestamps for profiles whose egress IP is not challenged, while the cascade costs one short round trip (~200 ms, the challenge answer) only while DuckDuckGo is blocked.

Keyed search APIs (Brave Search, Google Custom Search). Rejected for this line of providers: they restore reliability but introduce a credential requirement, which the keyless DuckDuckGo provider was added to avoid; the packages here stay keyless by construction.

Routing requests through a proxy to a non-data-center IP. Rejected: it is a terms-of-service gray area for both endpoints, depends on third-party infrastructure, and changes the observed IP class for no local signal.

## Acceptance criteria

A profile with `searchProvider: duckduckgo-lite-fallback` returns citable sources for ordinary queries from a data-center IP in both DDG states: direct DuckDuckGo results when unchallenged, and Mojeek results after the challenge answer otherwise (measured end-to-end ~1.3 s from challenge to sources).

The offline suites of `web-search-mojeek` and `web-search-fallback` pass, both packages report 100 percent per-file statement, branch, function, and line coverage, `web-search-duckduckgo` passes the same bar with its new suite, `verify-package-invariants` reports zero repository-wide violations, the host root type check builds green with the three packages registered in `tsconfig.host.json` and `tsconfig.base.json` paths, and the duplication gate reports no clones.

## Risks

Both endpoints are unofficial scraping targets: markup drift or a challenge-regime change degrades whichever engine is serving, and the cascade does not protect against Mojeek being challenged or down — a double failure surfaces as one named `WEB_PROVIDER_ERROR`.

The Mojeek `%20` rule is an empirical finding (3/3 control replicates from one IP class), not documented behavior; Mojeek may tighten it, loosen it, or change the encoding that trips it. The encoding site in the provider source is where the warning lives, so a future switch to percent-encoding fails against the documented reason instead of silently.

During a DuckDuckGo block, every search pays the primary round trip before the fallback answers, and Mojeek sources carry no `publishedAt` and, for niche queries, fewer hits than DuckDuckGo's page — the model works from a smaller, date-less result set exactly in the state that triggered the fallback.
