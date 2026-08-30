/**
 * Mojeek search provider: keyless plain-HTML retrieval against
 * `mojeek.com/search`. Each search is one GET whose `results-standard` list
 * rows are parsed for the direct `ob` target anchor (no redirect unwrapping),
 * the row's `<h2>` title, and the `<p class="s">` snippet. Mojeek runs its
 * own independent index and is deliberately bot-tolerant, which makes it a
 * reliable fallback for data-center IPs that DuckDuckGo (Lite and HTML)
 * challenge. No credential, no key, no dedicated API.
 *
 * Operational notes:
 * - Mojeek is bot-tolerant but still rate-limits bursts: several requests in
 *   a short window from one (data-center) IP get a JavaScript captcha page
 *   (HTTP 200, `<title>Captcha</title>`); the plain-HTML client cannot solve
 *   it, the challenge expires after a short cooldown (minutes). A challenged
 *   request is retried ONCE after a short backoff (covers burst edges); a
 *   second challenge fails loud with `WEB_PROVIDER_ERROR` so the caller can
 *   wait or switch providers.
 * - The query MUST be form-encoded (`+` for spaces, via URLSearchParams): the
 *   WAF challenges `%20`-encoded queries from data-center IPs even when
 *   spaced out (verified 2026-08-29).
 * - Keep request volume low (one request per search, as the seam does).
 * @module @deepseek-ai/dsh-web-search-mojeek/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'

/** Stable id this provider registers under. */
export const MOJEEK_PROVIDER_ID = 'mojeek'

/**
 * Default endpoint base: the public Mojeek site. The `/search` path with
 * `?q=` is appended on this base.
 */
export const MOJEEK_DEFAULT_BASE_URL = 'https://www.mojeek.com'

/**
 * Default request user agent. A full browser-style agent keeps the page
 * serving ordinary results; a bot-shaped agent risks challenge responses.
 */
export const MOJEEK_DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** Per-attempt network timeout; the tool's own search timeout still applies. */
const REQUEST_TIMEOUT_MS = 20000

/** Upper bound applied when the request does not set `maxResults`. */
const DEFAULT_MAX_RESULTS = 8

/** Attempts per search: initial request plus a single backoff retry. */
const MAX_ATTEMPTS = 2

/** Base delay before the single retry after a challenge (jittered ±20 %). */
const RETRY_BACKOFF_MS = 10000

/** Resolved provider options (the plugin's `apply` fills schema defaults). */
export interface MojeekSearchProviderOptions {
  /** Mojeek site base (trailing slashes removed); `/search?q=` is appended. */
  baseURL: string
  /** `user-agent` header sent with every request. */
  userAgent: string
}

/** Sleep that rejects as `WEB_ABORTED` when the caller's signal fires. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const fail = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', fail)
      reject(searchAborted(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', fail)
      resolve()
    }, ms)
    signal?.addEventListener('abort', fail, { once: true })
  })
}

/* jscpd:ignore-start -- 1:1 port of the standalone dsh-web-search-mojeek plugin's markup utilities;
   identical to the dsh-web-search-duckduckgo-lite copy (same tested source family), not an accidental clone */
/** Decode the common HTML entities the Mojeek markup emits. */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => safeFromCodePoint(parseInt(dec, 10)))
}

/** Code-point conversion that never throws on out-of-range values. */
function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code)
  } catch {
    // String.fromCodePoint rejects only out-of-range code points.
    return ''
  }
}

/**
 * Reduce one HTML fragment to its display text: strip tags, decode entities,
 * and collapse whitespace.
 * @param html - the raw fragment (row title or snippet content).
 * @returns the trimmed display text.
 */
export function toPlainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}
/* jscpd:ignore-end */

/**
 * Slice the standard-results list out of a Mojeek search page.
 * @param html - the decoded response body.
 * @returns the `<ul class="results-standard">` content, or `""` when absent.
 */
function extractResultsList(html: string): string {
  const startMatch = /<ul\b[^>]*class=["'][^"']*results-standard[^"']*["'][^>]*>/i.exec(html)
  if (startMatch === null) return ''
  const start = startMatch.index + startMatch[0].length
  const end = html.indexOf('</ul>', start)
  return html.slice(start, end === -1 ? undefined : end)
}

/**
 * Read a capture group that always participates in its match. The `??`
 * fallback is unreachable for such patterns and exists only to satisfy the
 * type checker under `noUncheckedIndexedAccess`.
 * @param match - an `exec` or `matchAll` hit.
 * @param group - the group index.
 * @returns the captured text.
 */
function capture(match: RegExpMatchArray, group: number): string {
  /* v8 ignore next -- the group always participates; only the checker needs the fallback */
  return match[group] ?? ''
}

/**
 * Parse one Mojeek search page into citeable sources (page order preserved,
 * duplicates by URL removed).
 * @param html - the decoded response body.
 * @returns the parsed sources.
 */
export function parseResults(html: string): WebSearchSource[] {
  const list = extractResultsList(html)
  const rowRe = /<li\b[^>]*class=["'][^"']*\br\d+\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  for (const match of list.matchAll(rowRe)) {
    const row = capture(match, 1)
    // Direct target URL: the row's `ob` anchor (no redirect wrapper).
    // The href-first alternative below is unreachable — the class-first
    // pattern's `[^>]*` span already crosses the href attribute — and kept
    // only because the reference implementation carries it.
    /* v8 ignore next -- the `??` fallback is subsumed by the first pattern: any anchor it matches is matched first */
    const urlMatch = /<a\b[^>]*class=["']ob["'][^>]*>/i.exec(row) ?? /<a\b[^>]*href=["']([^"']+)["'][^>]*class=["']ob["']/i.exec(row)
    const anchorTag = urlMatch !== null ? urlMatch[0] : ''
    const hrefMatch = /href=["']([^"']+)["']/i.exec(anchorTag)
    let url: string | undefined
    if (hrefMatch !== null) {
      try {
        const candidate = new URL(decodeEntities(capture(hrefMatch, 1)))
        if (/^https?:$/u.test(candidate.protocol)) url = candidate.toString()
      } catch {
        // Only a malformed href reaches this arm; `new URL` throws otherwise.
        url = undefined
      }
    }
    if (url === undefined || seen.has(url)) continue
    const source: { url: string; title?: string; snippet?: string } = { url }
    const h2Match = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(row)
    if (h2Match !== null) {
      const title = toPlainText(capture(h2Match, 1))
      if (title.length > 0) source.title = title
    }
    const snippetMatch = /<p\b[^>]*class=["']s["'][^>]*>([\s\S]*?)<\/p>/i.exec(row)
    if (snippetMatch !== null) {
      const snippet = toPlainText(capture(snippetMatch, 1))
      if (snippet.length > 0) source.snippet = snippet
    }
    seen.add(url)
    sources.push(source)
  }
  return sources
}

/**
 * The keyless endpoint occasionally answers rate-limited or suspicious
 * clients with a challenge page instead of results. Distinguish that (an
 * error worth surfacing) from a genuine no-result query (a valid empty
 * result): a challenge is HTTP 403/429, a head status marker other than
 * `OK`, or captcha-style body markup.
 * @param status - the response status code.
 * @param body - the decoded response body.
 * @returns the error message, or `undefined` when the response is a plain result page.
 */
export function challengeDetection(status: number, body: string): string | undefined {
  if (status === 403 || status === 429) {
    return `Mojeek returned a bot challenge (HTTP ${status}); the endpoint rate-limits bursts from this IP — retry later or switch providers`
  }
  const statusMarker = /<!--\s*status=["']([^"']+)["']\s*-->/i.exec(body)
  const markerChallenged = statusMarker !== null && capture(statusMarker, 1).trim().toUpperCase() !== 'OK'
  if (markerChallenged || /captcha|are you (a|an) (human|robot)|unusual traffic|verify you are human/i.test(body)) {
    return 'Mojeek returned a challenge page instead of results; retry later or switch providers'
  }
  return undefined
}

/** The Mojeek search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class MojeekSearchProvider implements WebSearchProvider {
  readonly id = MOJEEK_PROVIDER_ID

  /* jscpd:ignore-start -- keyless search-provider dispatch sequence (options snapshot + GET preamble),
     structurally identical across the ctx.web provider family, not an accidental clone */
  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted
   * once at each operation's entry so one search never mixes two sections.
   */
  constructor(private readonly resolveOptions: () => MojeekSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return URL.canParse(options.baseURL) && options.userAgent.length > 0
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    throwIfSearchAborted(signal)
    const options = this.resolveOptions()
    // Form-style encoding (space -> `+`), as URLSearchParams produces.
    // IMPORTANT: Mojeek's WAF challenges `%20`-encoded queries from
    // data-center IPs (JS captcha) — do not switch to encodeURIComponent.
    const endpoint = `${options.baseURL.replace(/\/+$/u, '')}/search?${new URLSearchParams({ q: request.query }).toString()}`
    /* jscpd:ignore-end */
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response
      try {
        response = await fetch(endpoint, {
          method: 'GET',
          redirect: 'error',
          headers: {
            'user-agent': options.userAgent,
            'accept': 'text/html',
          },
          signal:
            signal !== undefined
              ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
              : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (error: unknown) {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        if (isTimeoutError(error)) throw new WebError(`Mojeek request timed out after ${REQUEST_TIMEOUT_MS} ms`, 'WEB_PROVIDER_ERROR', { cause: error })
        throw new WebError(`Mojeek search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
      }
      let body: string
      try {
        body = await response.text()
      } catch (error: unknown) {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        throw new WebError(`Mojeek response body unreadable: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
      }
      throwIfSearchAborted(signal)

      const challenge = challengeDetection(response.status, body)
      if (challenge !== undefined) {
        if (attempt < MAX_ATTEMPTS) {
          // Burst edge: give the challenge a short chance to expire.
          await abortableDelay(Math.round(RETRY_BACKOFF_MS * (1 + Math.random() * 0.2)), signal)
          continue
        }
        throw new WebError(challenge, 'WEB_PROVIDER_ERROR')
      }
      if (!response.ok) throw new WebError(`Mojeek search failed (HTTP ${response.status})`, 'WEB_PROVIDER_ERROR')

      const cap = request.maxResults ?? DEFAULT_MAX_RESULTS
      const sources = parseResults(body).slice(0, cap)
      if (sources.length === 0) {
        return {
          content: `No results from Mojeek for "${request.query}".`,
          sources: [],
          truncated: false,
        }
      }
      return { sources, truncated: false }
    }
    // Unreachable: the loop always returns or throws.
    /* v8 ignore next -- the loop body always returns or throws, so this fall-through is dead */
    throw new WebError('Mojeek search ended without a result', 'WEB_PROVIDER_ERROR')
  }
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted(signal)
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('Mojeek search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** True for the per-attempt timeout signal firing, surfaced as `WEB_PROVIDER_ERROR`. */
function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError'
}
