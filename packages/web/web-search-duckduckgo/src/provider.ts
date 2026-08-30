/**
 * DuckDuckGo Lite search provider: keyless HTML retrieval against
 * `lite.duckduckgo.com/lite/`. Each search is one GET whose result table rows
 * are parsed for `result-link` anchors (title + URL) and the following
 * `result-snippet` cell (snippet). DuckDuckGo wraps most result URLs in its
 * own `//duckduckgo.com/l/?uddg=<encoded>` redirect; the provider decodes the
 * `uddg` target so callers receive the real URL. No credential, no key, no
 * dedicated API — this is the free fallback backend for `ctx.web` search.
 * @module @deepseek-ai/dsh-web-search-duckduckgo/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'

/** Stable id this provider registers under. */
export const DUCKDUCKGO_LITE_PROVIDER_ID = 'duckduckgo-lite'

/**
 * Default endpoint: DuckDuckGo's Lite (no-JS) search page. The query is
 * appended as `?q=` on this path.
 */
export const DUCKDUCKGO_DEFAULT_BASE_URL = 'https://lite.duckduckgo.com/lite/'

/**
 * Default request user agent. A generic browser-style agent keeps the page
 * serving ordinary results; a bot-shaped agent risks challenge responses.
 */
export const DUCKDUCKGO_DEFAULT_USER_AGENT = 'Mozilla/5.0'

/** Resolved provider options (the plugin's `apply` fills schema defaults). */
export interface DuckDuckGoLiteSearchProviderOptions {
  /** Lite search page base; the query becomes `?q=` on this URL. */
  baseURL: string
  /** `user-agent` header sent with every request. */
  userAgent: string
}

/**
 * Parse one DuckDuckGo Lite result page into normalized sources. Results are
 * the ordered `class='result-link'` anchors; each result's snippet is the
 * first `class='result-snippet'` cell that appears BEFORE the next result
 * link (an empty window means the result carried no snippet, never a borrow
 * from its neighbor). Duplicate URLs collapse to their first occurrence.
 * @param html - the full Lite search page body.
 * @returns the deduplicated source list (may be empty for a genuine no-result query).
 */
export function parseLiteResults(html: string): WebSearchSource[] {
  const anchors = [...html.matchAll(
    /<a rel="nofollow" href="([^"]+)" class='result-link'>([\s\S]*?)<\/a>/gu,
  )]
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (let i = 0; i < anchors.length; i += 1) {
    const anchor = anchors[i]
    if (anchor === undefined || anchor.index === undefined) continue
    const next = i + 1 < anchors.length ? anchors[i + 1] : undefined
    const windowEnd = next?.index ?? html.length
    const window = html.slice(anchor.index + anchor[0].length, windowEnd)
    const url = decodeResultUrl(anchor[1] ?? '')
    if (url === undefined || seen.has(url)) continue
    seen.add(url)
    const title = stripTags(anchor[2] ?? '')
    const snippetMatch = window.match(/<td class='result-snippet'>([\s\S]*?)<\/td>/u)
    const snippet = snippetMatch !== null && snippetMatch[1] !== undefined ? stripTags(snippetMatch[1]) : undefined
    sources.push({
      url,
      ...title.length > 0 ? { title } : {},
      ...snippet !== undefined && snippet.length > 0 ? { snippet } : {},
    })
  }
  return sources
}

/**
 * Resolve one result anchor's href to its real target. DuckDuckGo wraps most
 * results in a protocol-relative `//duckduckgo.com/l/?uddg=<encoded>`
 * redirect; the `uddg` parameter is the destination. Any other DuckDuckGo
 * internal link (e.g. TLD redirect paths) resolves to no usable target.
 * @param href - the anchor's raw href attribute value.
 * @returns the decoded absolute URL, or `undefined` when no target is extractable.
 */
export function decodeResultUrl(href: string): string | undefined {
  let url: URL
  try {
    // Protocol-relative hrefs need a base host; the DDG host makes internal
    // redirects recognizable, and absolute hrefs ignore the base entirely.
    url = new URL(href, 'https://duckduckgo.com')
  } catch {
    return undefined
  }
  const host = url.hostname.toLowerCase()
  if (host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) {
    if (url.pathname === '/l/' || url.pathname.startsWith('/l/')) {
      const uddg = url.searchParams.get('uddg')
      if (uddg === null || uddg.length === 0) return undefined
      try {
        return new URL(uddg).toString()
      } catch {
        return undefined
      }
    }
    return undefined
  }
  return url.toString()
}

/**
 * Reduce one HTML fragment to its display text: strip tags, decode entities
 * (`&amp;` LAST so a double-encoded `&amp;lt;` decodes exactly once), and
 * collapse whitespace.
 * @param text - the raw fragment (anchor text or snippet cell content).
 * @returns the trimmed display text.
 */
export function stripTags(text: string): string {
  return unescapeHtml(text.replace(/<[^>]*>/gu, ' ')).replace(/\s+/gu, ' ').trim()
}

/** Decode the HTML entities the Lite page actually emits. */
function unescapeHtml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_match, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
}

/**
 * The keyless Lite endpoint occasionally answers rate-limited or suspicious
 * clients with a challenge page instead of results. Distinguish that (an
 * error worth surfacing) from a genuine no-result query (a valid empty
 * result the tool renders as "No results found.").
 * @param html - the full response body.
 * @returns the error message, or `undefined` when the body is a plain result page.
 */
export function challengeDetection(html: string): string | undefined {
  if (/<a rel="nofollow" href="[^"]+" class='result-link'>/u.test(html)) return undefined
  if (/anomaly|challenge|captcha|are you a robot|not\s+a\s+robot/iu.test(html)) {
    return 'DuckDuckGo Lite returned a challenge page instead of results; retry later or adjust the query'
  }
  return undefined
}

/** The DuckDuckGo Lite search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class DuckDuckGoLiteSearchProvider implements WebSearchProvider {
  readonly id = DUCKDUCKGO_LITE_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted
   * once at each operation's entry so one search never mixes two sections.
   */
  constructor(private readonly resolveOptions: () => DuckDuckGoLiteSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return URL.canParse(options.baseURL) && options.userAgent.length > 0
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    throwIfSearchAborted(signal)
    const options = this.resolveOptions()
    const endpoint = `${options.baseURL.endsWith('/') ? options.baseURL : `${options.baseURL}/`}?q=${encodeURIComponent(request.query)}`
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'GET',
        redirect: 'error',
        headers: {
          'user-agent': options.userAgent,
          'accept': 'text/html',
        },
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError(`DuckDuckGo Lite search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      throw new WebError(`DuckDuckGo Lite search failed (HTTP ${response.status})`, 'WEB_PROVIDER_ERROR')
    }

    let html: string
    try {
      html = await response.text()
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError(`DuckDuckGo Lite response body unreadable: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    throwIfSearchAborted(signal)

    const sources = parseLiteResults(html)
    if (sources.length === 0) {
      const challenge = challengeDetection(html)
      if (challenge !== undefined) throw new WebError(challenge, 'WEB_PROVIDER_ERROR')
    }
    return { sources, truncated: false }
  }
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted(signal)
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('DuckDuckGo Lite search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
