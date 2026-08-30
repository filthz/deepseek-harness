import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  MOJEEK_DEFAULT_BASE_URL,
  MOJEEK_DEFAULT_USER_AGENT,
  MOJEEK_PROVIDER_ID,
  MojeekSearchProvider,
  challengeDetection,
  parseResults,
} from '../src/provider.ts'
import type { MojeekSearchProviderOptions } from '../src/provider.ts'
import * as mojeekPlugin from '../src/index.ts'

// Live Mojeek capture for the query 'deep seek harness' (2026-08-29): ten
// result rows, direct `ob` target URLs, no timestamps.
const fixtureHtml = readFileSync(new URL('fixtures/results-10.html', import.meta.url), 'utf8')

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' }, ...init })
}

function page(rows: string): string {
  return `<html><body><ul class="results-standard">${rows}</ul></body></html>`
}

function row(rowClass: string, inner: string): string {
  return `<li class="${rowClass}">${inner}</li>`
}

function fullRow(rowClass: string, url: string, title: string, snippet: string): string {
  return row(rowClass, `<a class="ob" href="${url}"></a><h2><a class="title" href="${url}">${title}</a></h2><p class="s">${snippet}</p>`)
}

const base = 'https://mojeek.test'

function provider(baseURL: string = base): MojeekSearchProvider {
  return new MojeekSearchProvider((): MojeekSearchProviderOptions => ({
    baseURL,
    userAgent: MOJEEK_DEFAULT_USER_AGENT,
  }))
}

function defaultProvider(): MojeekSearchProvider {
  return new MojeekSearchProvider((): MojeekSearchProviderOptions => ({
    baseURL: MOJEEK_DEFAULT_BASE_URL,
    userAgent: MOJEEK_DEFAULT_USER_AGENT,
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('parseResults against the live capture (results-10.html)', () => {
  const sources = parseResults(fixtureHtml)

  it('is not a challenge body', () => {
    expect(challengeDetection(200, fixtureHtml)).toBeUndefined()
  })

  it('parses 10 results', () => {
    expect(sources).toHaveLength(10)
  })

  it('keeps the first row as the direct omni.se target', () => {
    const first = sources[0]!
    expect(first.url).toBe('https://omni.se/microsoft-gor-deep-seeks-r1-modell-tillganglig-via-molnet/a/mPx611')
    expect(first.title).toContain('Deep Seeks R1-modell')
    expect((first.snippet ?? '').length).toBeGreaterThan(30)
    expect(first.snippet).not.toMatch(/<strong>|<\/strong>|<b>/)
    expect(first.title).not.toMatch(/&amp;|&nbsp;|&#/)
  })

  it('produces only absolute http(s) urls', () => {
    for (const source of sources) expect(source.url).toMatch(/^https?:\/\//)
  })

  it('contains no duplicate urls', () => {
    expect(new Set(sources.map(source => source.url)).size).toBe(sources.length)
  })

  it('leaks no mojeek-internal urls', () => {
    for (const source of sources) expect(source.url).not.toContain('mojeek.com')
  })

  it('gives every source a title and a snippet', () => {
    for (const source of sources) {
      expect(source.title).toBeTruthy()
      expect(source.snippet).toBeTruthy()
    }
  })

  it('parses the second row (the clu-result variant)', () => {
    expect(sources[1]!.url).toContain('omni.se/sakerhetsforskare')
  })
})

describe('challengeDetection', () => {
  it('flags HTTP 403 and 429 regardless of the body', () => {
    expect(challengeDetection(403, '<html><body></body></html>')).toContain('HTTP 403')
    expect(challengeDetection(429, '<html><body></body></html>')).toContain('HTTP 429')
  })

  it('detects a non-OK status marker', () => {
    expect(challengeDetection(200, '<!-- status="CHALLENGED" -->')).toBeDefined()
    expect(challengeDetection(200, "<!-- status='blocked' -->")).toBeDefined()
  })

  it('does not flag an OK status marker (case-insensitive)', () => {
    expect(challengeDetection(200, '<!-- status="OK" -->')).toBeUndefined()
    expect(challengeDetection(200, '<!-- status="ok" -->')).toBeUndefined()
  })

  it('detects captcha-style wording', () => {
    expect(challengeDetection(200, '<h1>Please verify you are human</h1>')).toBeDefined()
    expect(challengeDetection(200, '<html><head><title>Captcha</title></head></html>')).toBeDefined()
    expect(challengeDetection(200, 'We are seeing unusual traffic')).toBeDefined()
  })

  it('does not flag a plain page', () => {
    expect(challengeDetection(200, '<html><body><div class="results">none</div></body></html>')).toBeUndefined()
  })
})

describe('parseResults row filtering and text decoding', () => {
  it('returns no sources for a page without the results list', () => {
    expect(parseResults('<html><body><div class="results">none</div></body></html>')).toEqual([])
  })

  it('tolerates a results list without a closing tag', () => {
    const html = `<html><body><ul class="results-standard">${fullRow('r1', 'https://a.test/x', 't', 's')}<div>tail</div></body></html>`
    expect(parseResults(html)).toEqual([{ url: 'https://a.test/x', title: 't', snippet: 's' }])
  })

  it('skips a row without an ob anchor', () => {
    expect(parseResults(page(row('r1', '<h2>No anchor</h2><p class="s">s</p>')))).toEqual([])
  })

  it('skips a row whose ob anchor has no href', () => {
    expect(parseResults(page(row('r1', '<a class="ob">no href</a><h2>t</h2><p class="s">s</p>')))).toEqual([])
  })

  it('skips rows with a malformed or non-http target', () => {
    const html = page(
      fullRow('r1', 'not a url', 'a', 's')
      + fullRow('r2', 'javascript:alert(1)', 'b', 's')
      + fullRow('r3', 'ftp://x.test/y', 'c', 's'),
    )
    expect(parseResults(html)).toEqual([])
  })

  it('drops duplicate urls, keeping the first occurrence', () => {
    const html = page(fullRow('r1', 'https://a.test/x', 'first', 's1') + fullRow('r2', 'https://a.test/x', 'second', 's2'))
    expect(parseResults(html)).toEqual([{ url: 'https://a.test/x', title: 'first', snippet: 's1' }])
  })

  it('omits an absent or blank title and snippet rather than emitting it', () => {
    const html = page(
      // No h2, no snippet.
      row('r1', '<a class="ob" href="https://a.test/a"></a>')
      // Blank h2, no snippet.
      + row('r2', '<a class="ob" href="https://a.test/b"></a><h2>  </h2>')
      // h2, blank snippet.
      + row('r3', '<a class="ob" href="https://a.test/c"></a><h2>c</h2><p class="s">   </p>')
      // Full row, for contrast.
      + fullRow('r4', 'https://a.test/d', 'd', 'sd'),
    )
    expect(parseResults(html)).toEqual([
      { url: 'https://a.test/a' },
      { url: 'https://a.test/b' },
      { url: 'https://a.test/c', title: 'c' },
      { url: 'https://a.test/d', title: 'd', snippet: 'sd' },
    ])
  })

  it('decodes named, quoted, and numeric entities in titles and snippets', () => {
    const html = page(fullRow('r1', 'https://a.test/x', 'T &amp; U &#8211; A &#x2715; &#39;quoted&#39; &quot;q&quot; &lt;lt&gt; &gt; &nbsp;pad', 's'))
    expect(parseResults(html)).toEqual([
      { url: 'https://a.test/x', title: 'T & U – A ✕ \'quoted\' "q" <lt> > pad', snippet: 's' },
    ])
  })

  it('replaces an out-of-range numeric entity with nothing', () => {
    const html = page(fullRow('r1', 'https://a.test/x', '&#1114112;X', 's'))
    expect(parseResults(html)[0]!.title).toBe('X')
  })
})

describe('MojeekSearchProvider', () => {
  it('registers under the mojeek provider id', () => {
    expect(MOJEEK_PROVIDER_ID).toBe('mojeek')
    expect(provider().id).toBe(MOJEEK_PROVIDER_ID)
  })

  it('is available for a parseable base URL and a non-empty user agent', () => {
    expect(provider().available()).toBe(true)
    expect(new MojeekSearchProvider((): MojeekSearchProviderOptions => ({ baseURL: 'not a url', userAgent: 'x' })).available()).toBe(false)
    expect(new MojeekSearchProvider((): MojeekSearchProviderOptions => ({ baseURL: base, userAgent: '' })).available()).toBe(false)
  })

  it('requests the form-encoded query (space -> +) against the default base URL', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(page('')))
    vi.stubGlobal('fetch', fetchMock)
    await defaultProvider().search({ query: 'deep seek harness' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${MOJEEK_DEFAULT_BASE_URL}/search?q=deep+seek+harness`)
    expect(url).not.toContain('%20')
    expect((init.headers as Record<string, string>)['user-agent']).toBe(MOJEEK_DEFAULT_USER_AGENT)
    expect(init.redirect).toBe('error')
  })

  it('strips trailing slashes from a configured baseURL', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(page('')))
    vi.stubGlobal('fetch', fetchMock)
    await provider(`${base}//`).search({ query: 'q' })
    expect((fetchMock.mock.calls[0] as unknown as [string, unknown])[0]).toBe(`${base}/search?q=q`)
  })

  it('returns parsed sources capped at maxResults', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(fixtureHtml)))
    const result = await provider().search({ query: 'deep seek harness', maxResults: 3 })
    expect(result.truncated).toBe(false)
    expect(result.content).toBeUndefined()
    expect(result.sources).toHaveLength(3)
  })

  it('caps at eight sources when the request omits maxResults', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(fixtureHtml)))
    const result = await provider().search({ query: 'deep seek harness' })
    expect(result.sources).toHaveLength(8)
  })

  it('reports an empty result page as a no-results content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(page(''))))
    const result = await provider().search({ query: 'nothing at all' })
    expect(result).toEqual({ content: 'No results from Mojeek for "nothing at all".', sources: [], truncated: false })
  })

  it('maps a non-challenge HTTP error to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('server error', { status: 500 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Mojeek search failed (HTTP 500)' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR with the error message', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Mojeek search request failed: TypeError: connection refused' }))
  })

  it('maps a non-Error rejection to its string form', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject('boom')))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Mojeek search request failed: boom' }))
  })

  it('maps an unreadable response body to WEB_PROVIDER_ERROR', async () => {
    const response = htmlResponse(page(''))
    response.text = () => Promise.reject(new TypeError('stream broke'))
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Mojeek response body unreadable: TypeError: stream broke' }))
  })

  it('maps a caller abort while reading the body to WEB_ABORTED', async () => {
    const controller = new AbortController()
    const response = htmlResponse(page(''))
    response.text = () => {
      controller.abort()
      return Promise.reject(new DOMException('aborted', 'AbortError'))
    }
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(provider().search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED', message: 'Mojeek search aborted' }))
  })

  it('maps a pre-aborted signal to WEB_ABORTED before any request', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(provider().search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED', message: 'Mojeek search aborted' }))
  })

  it('maps a caller abort during the request to WEB_ABORTED with the signal reason', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => {
      // Abort the caller right after the request starts.
      controller.abort()
      return Promise.reject(new DOMException('aborted', 'AbortError'))
    }))
    await expect(provider().search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED', message: 'Mojeek search aborted' }))
  })

  it('maps a bare AbortError rejection to WEB_ABORTED with the error as cause', async () => {
    const abort = new DOMException('aborted', 'AbortError')
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(abort)))
    await expect(provider().search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_ABORTED', message: 'Mojeek search aborted', cause: abort })
  })

  it('surfaces a caller abort after the body read as WEB_ABORTED', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => {
      controller.abort()
      return htmlResponse(page(''))
    }))
    await expect(provider().search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED', message: 'Mojeek search aborted' }))
  })

  it('maps a timeout to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('timed out', 'TimeoutError'))))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Mojeek request timed out after 20000 ms' }))
  })

  describe('challenge handling (single backoff retry)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      // Deterministic backoff: exactly RETRY_BACKOFF_MS, no jitter.
      vi.spyOn(Math, 'random').mockReturnValue(0)
    })

    it('retries once after the backoff and returns the second result', async () => {
      const fetchMock = vi.fn(async () => htmlResponse(fixtureHtml))
      fetchMock.mockResolvedValueOnce(new Response('<!-- status="CHALLENGED" -->', { status: 403 }))
      vi.stubGlobal('fetch', fetchMock)
      const pending = provider().search({ query: 'deep seek harness' })
      await vi.advanceTimersByTimeAsync(10_000)
      const result = await pending
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(result.truncated).toBe(false)
      expect(result.sources).toHaveLength(8)
    })

    it('fails loud with WEB_PROVIDER_ERROR when the second attempt is challenged too', async () => {
      let calls = 0
      const fetchMock = vi.fn(async () => {
        calls += 1
        return calls === 1
          ? new Response('blocked', { status: 403 })
          : new Response('blocked', { status: 429 })
      })
      vi.stubGlobal('fetch', fetchMock)
      const pending = provider().search({ query: 'q' })
      // Observe the rejection up front so no timer tick sees it unhandled.
      const assertion = expect(pending).rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: expect.stringContaining('HTTP 429'),
      }))
      await vi.advanceTimersByTimeAsync(10_000)
      await assertion
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('treats an HTTP 200 captcha page as a challenge on both attempts', async () => {
      const captcha = '<html><head><title>Captcha</title></head><body>verify you are human</body></html>'
      vi.stubGlobal('fetch', vi.fn(async () => new Response(captcha, { status: 200 })))
      const pending = provider().search({ query: 'q' })
      // Observe the rejection up front so no timer tick sees it unhandled.
      const assertion = expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
      await vi.advanceTimersByTimeAsync(10_000)
      await assertion
    })

    it('surfaces an abort during the retry backoff as WEB_ABORTED', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('blocked', { status: 403 })))
      const controller = new AbortController()
      const pending = provider().search({ query: 'q' }, controller.signal)
      // Observe the rejection up front so no timer tick sees it unhandled.
      const assertion = expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED', message: 'Mojeek search aborted' }))
      // Settle attempt 1 so the backoff delay is scheduled.
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      controller.abort()
      await assertion
    })
  })
})

describe('web-search-mojeek plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(fixtureHtml)))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: MOJEEK_PROVIDER_ID })
    const fiber = await ctx.plugin(mojeekPlugin)
    const result = await ctx.web.search({ query: 'deep seek harness', maxResults: 2 })
    expect(result.truncated).toBe(false)
    expect(result.sources).toHaveLength(2)
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'deep seek harness' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('threads the baseURL and userAgent config into the provider', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(page('')))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: MOJEEK_PROVIDER_ID })
    const fiber = await ctx.plugin(mojeekPlugin, { baseURL: 'https://mirror.mojeek.test', userAgent: 'TestAgent/1.0' })
    await ctx.web.search({ query: 'a b' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://mirror.mojeek.test/search?q=a+b')
    expect((init.headers as Record<string, string>)['user-agent']).toBe('TestAgent/1.0')
    await fiber.dispose()
  })

  it('fills the schema defaults when the config arrives without keys', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(page('')))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: MOJEEK_PROVIDER_ID })
    // Direct apply with a key-less config: the `??` defaults in apply run.
    mojeekPlugin.apply(ctx, {})
    await ctx.web.search({ query: 'q' })
    expect((fetchMock.mock.calls[0] as unknown as [string, unknown])[0]).toBe(`${MOJEEK_DEFAULT_BASE_URL}/search?q=q`)
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in mojeekPlugin).toBe(false)
  })

  it('exposes the plugin namespace shape', () => {
    expect(mojeekPlugin.name).toBe('web-search-mojeek')
    expect(mojeekPlugin.inject).toEqual(['web'])
  })
})
