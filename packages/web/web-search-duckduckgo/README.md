# @deepseek-ai/dsh-web-search-duckduckgo

English | [中文](README.zh.md)

A keyless, free `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls DuckDuckGo's **Lite** (no-JS) search page (`GET https://lite.duckduckgo.com/lite/?q=…`) and parses the result table — `result-link` anchors for title and URL, the following `result-snippet` cell for the snippet — into the seam's normalized `WebSearchResult`.

This is the **free fallback** to the paid [`@deepseek-ai/dsh-web-search-deepseek`](../web-search-deepseek/README.md) provider: no API key, no auxiliary model turn, one plain HTML GET per search. DuckDuckGo wraps most result URLs in its own `//duckduckgo.com/l/?uddg=<encoded>` redirect; the provider decodes the `uddg` target so callers receive the real URL.

Like `@deepseek-ai/dsh-web-search-deepseek`, it is an **implementation** package: it registers a provider into `ctx.web` (function plugin, `inject: ['web']`) and does not register a model-facing tool — `@deepseek-ai/dsh-tool-web` stays the only owner of `web_search`/`web_fetch`.

## Config

| Key | Default | Meaning |
|---|---|---|
| `baseURL` | `https://lite.duckduckgo.com/lite/` | Lite search page base; the query is appended as `?q=` on this path. |
| `userAgent` | `Mozilla/5.0` | `user-agent` header for every request. A generic browser-style agent keeps the page serving ordinary results; a bot-shaped agent risks challenge responses. |

```yaml
- id: web-search-duckduckgo
  name: '@deepseek-ai/dsh-web-search-duckduckgo'
```

The entry above carries no config; every key is schema-defaulted. To route `web_search` through this provider, set the seam's selection to its id (`searchProvider: duckduckgo-lite` on the `@deepseek-ai/dsh-web` entry, or `$DSH_WEB_SEARCH_PROVIDER` at launch).

## Parsing

- Results are the ordered `class='result-link'` anchors. Each result's snippet is the first `class='result-snippet'` cell that appears **before the next result link** — an empty window means the result carried no snippet, never a borrow from its neighbor.
- Anchor text and snippet cells are reduced to display text (tags stripped, entities decoded, `&amp;` decoded last so a double-encoded `&amp;lt;` decodes exactly once, whitespace collapsed).
- Sources deduplicate by URL (first occurrence wins). The seam still enforces the request's `maxResults` truncation.
- DDG-internal hrefs without a `uddg` target (TLD redirects etc.) are dropped rather than passed through.

## Failure vocabulary

- A response that is a DDG challenge/anomaly page (no results + challenge markers) throws `WebError` `WEB_PROVIDER_ERROR` — surfacing rate-limiting instead of masquerading as "no results".
- A genuine no-result query returns `{ sources: [], truncated: false }`, which `dsh-tool-web` renders as `No results found.`
- HTTP errors and unreadable bodies become `WEB_PROVIDER_ERROR`; caller cancellation becomes `WEB_ABORTED`.

## Known Limitations

- **No result-count control on the wire** — the Lite page returns its own page of results (typically ~30); the seam truncates to `maxResults` post-hoc.
- **No `publishedAt`** — the Lite page exposes no dates.
- **No `content`** — the provider generates no answer text; the model works from titles, snippets, and source URLs.
- **Unofficial endpoint** — DuckDuckGo's Lite page is a scraping target, not a stable API; markup drift or a challenge regime change degrades the parser. The DDG Instant Answer API (`api.duckduckgo.com`) is a cleaner JSON fallback but covers only abstracts, not web-index results.
