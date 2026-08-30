import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { WebSearchProvider } from '@deepseek-ai/dsh-web'
import {
  DUCKDUCKGO_DEFAULT_BASE_URL,
  DUCKDUCKGO_DEFAULT_USER_AGENT,
  DUCKDUCKGO_LITE_PROVIDER_ID,
  DuckDuckGoLiteSearchProvider,
  challengeDetection,
  decodeResultUrl,
  parseLiteResults,
  stripTags,
} from '../src/provider.ts'
import type { DuckDuckGoLiteSearchProviderOptions } from '../src/provider.ts'
import * as duckduckgoPlugin from '../src/index.ts'
import * as duckduckgoInvariant from '../src/invariant.ts'

// Live DuckDuckGo Lite capture for the query 'openwrt mptcp': ten
// result-link rows, every URL wrapped in a `//duckduckgo.com/l/?uddg=`
// redirect, each with its own result-snippet cell.
const fixtureHtml = readFileSync(new URL('fixtures/lite-results.html', import.meta.url), 'utf8')

const expectedUrls = [
  'https://openwrt.org/docs/guide-user/network/mptcp?s[]=p.txt',
  'https://forum.openwrt.org/t/tutorial-build-openwrt-with-multipath-tcp/84325',
  'https://github.com/Ysurac/openmptcprouter',
  'https://github.com/BigNerd95/OpenWRT_MPTCP',
  'https://www.openmptcprouter.com/',
  'https://multipath-tcp.org/pmwiki.php/Users/OpenWRT',
  'https://forum.openwrt.org/t/configuring-mptcp-in-openwrt/48683',
  'https://www.openwrt.pro/post-654.html',
  'https://blog.csdn.net/m0_54683626/article/details/117533227',
  'https://dillonbaird.io/articles/mptcpbonding/',
]

const expectedTitles = [
  'Multipath TCP and OpenWrt',
  '[Tutorial] Build OpenWrt with Multipath TCP',
  'GitHub - Ysurac/openmptcprouter: OpenMPTCProuter is an open source ...',
  'GitHub - BigNerd95/OpenWRT_MPTCP: OpenWRT with Multipath TCP (MPTCP ...',
  'OpenMPTCProuter - Internet connection bonding - Home',
  'Linux Kernel implementation : Users - Open WRT browse - MultiPath TCP',
  'Configuring MPTCP in OpenWrt',
  'OpenWrt上基于mptcp、tproxy的聚合流量简明教程',
  '开源聚合路由 OpenMPTCProuter 配置使用-CSDN博客',
  'Multi-WAN Bonding with OpenMPTCProuter · DillonBaird.io',
]

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' }, ...init })
}

// Minimal Lite page builders: a result row is the result-link anchor plus,
// when given, the result-snippet cell that follows it and precedes the next
// anchor.
function litePage(rows: string): string {
  return `<html><body><table class='results'>${rows}</table></body></html>`
}

function liteRow(href: string, title: string, snippet?: string): string {
  const snip = snippet === undefined ? '' : `<tr><td>&nbsp;</td><td class='result-snippet'>${snippet}</td></tr>`
  return `<tr><td>&nbsp;</td><td><a rel="nofollow" href="${href}" class='result-link'>${title}</a></td></tr>${snip}`
}

const ddgRedirect = (target: string): string =>
  `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=abc123`

const base = 'https://lite.test/'

function provider(baseURL: string = base, userAgent: string = DUCKDUCKGO_DEFAULT_USER_AGENT): DuckDuckGoLiteSearchProvider {
  return new DuckDuckGoLiteSearchProvider((): DuckDuckGoLiteSearchProviderOptions => ({ baseURL, userAgent }))
}

function fetchCall(mock: ReturnType<typeof vi.fn>, index = 0): [string, RequestInit] {
  return mock.mock.calls[index] as unknown as [string, RequestInit]
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('parseLiteResults against the live capture (lite-results.html)', () => {
  const sources = parseLiteResults(fixtureHtml)

  it('is not a challenge body', () => {
    expect(challengeDetection(fixtureHtml)).toBeUndefined()
  })

  it('parses exactly 10 sources in page order', () => {
    expect(sources.map(source => source.url)).toEqual(expectedUrls)
  })

  it('decodes every uddg redirect to its absolute target', () => {
    for (const source of sources) {
      expect(source.url).toMatch(/^https:\/\//)
      expect(source.url).not.toContain('duckduckgo.com')
      expect(source.url).not.toContain('uddg')
    }
  })

  it('keeps the titles exactly as rendered (no tags, entities decoded)', () => {
    expect(sources.map(source => source.title)).toEqual(expectedTitles)
    for (const source of sources) {
      expect(source.title).not.toMatch(/</)
      expect(source.title).not.toMatch(/&amp;|&nbsp;|&quot;|&apos;|&#/)
    }
  })

  it('gives every source a snippet stripped of tags and decoded entities', () => {
    for (const source of sources) {
      expect(source.snippet).toBeTruthy()
      expect(source.snippet).not.toMatch(/<b>|<\/b>|</)
      expect(source.snippet).not.toMatch(/&amp;|&nbsp;|&#/)
    }
    // The &amp; in the second snippet decodes to a single &, not a raw entity.
    expect(sources[1]!.snippet).toContain('MPTCPv0 & MPTCPv1')
  })

  it('contains no duplicate urls', () => {
    expect(new Set(sources.map(source => source.url)).size).toBe(sources.length)
  })
})

describe('parseLiteResults row filtering and the snippet window', () => {
  it('returns no sources for a page without result anchors', () => {
    expect(parseLiteResults('<html><body><div class="results">none</div></body></html>')).toEqual([])
  })

  it('never borrows a snippet from a following neighbor result', () => {
    const html = litePage(
      liteRow('https://a.test/first', 'First')
      + liteRow('https://a.test/second', 'Second', 'belongs to the second result'),
    )
    expect(parseLiteResults(html)).toEqual([
      { url: 'https://a.test/first', title: 'First' },
      { url: 'https://a.test/second', title: 'Second', snippet: 'belongs to the second result' },
    ])
  })

  it('omits a blank snippet rather than emitting it', () => {
    const html = litePage(liteRow('https://a.test/x', 'X', '   '))
    expect(parseLiteResults(html)).toEqual([{ url: 'https://a.test/x', title: 'X' }])
  })

  it('omits an empty title', () => {
    const html = litePage(liteRow('https://a.test/x', '', 's'))
    expect(parseLiteResults(html)).toEqual([{ url: 'https://a.test/x', snippet: 's' }])
  })

  it('drops duplicate decoded targets, keeping the first occurrence', () => {
    const html = litePage(
      liteRow(ddgRedirect('https://a.test/dup'), 'first', 's1')
      + liteRow(ddgRedirect('https://a.test/dup'), 'second', 's2'),
    )
    expect(parseLiteResults(html)).toEqual([{ url: 'https://a.test/dup', title: 'first', snippet: 's1' }])
  })

  it('skips DDG-internal links without a uddg target', () => {
    const html = litePage(
      liteRow('//duckduckgo.com/t/redirect', 'internal')
      + liteRow('https://duckduckgo.com/l/?foo=bar', 'no uddg')
      + liteRow(ddgRedirect('https://a.test/real'), 'real'),
    )
    expect(parseLiteResults(html)).toEqual([{ url: 'https://a.test/real', title: 'real' }])
  })

  it('skips anchors whose href is not a parseable URL', () => {
    const html = litePage(
      liteRow('http://[broken', 'unparseable')
      + liteRow(ddgRedirect('https://a.test/real'), 'real'),
    )
    expect(parseLiteResults(html)).toEqual([{ url: 'https://a.test/real', title: 'real' }])
  })

  it('skips degenerate match entries and keeps the valid results', () => {
    // The regex engine never emits a missing entry, a missing index, or
    // undefined capture groups; drive those through a stubbed matchAll so the
    // parser's skip guards run, with the real first match as the control.
    const matches = [...fixtureHtml.matchAll(/<a rel="nofollow" href="([^"]+)" class='result-link'>([\s\S]*?)<\/a>/gu)]
    const control = matches[0]!
    const controlUrl = expectedUrls[0]!
    const controlTitle = expectedTitles[0]!
    const controlSnippet = parseLiteResults(fixtureHtml)[0]!.snippet
    vi.spyOn(String.prototype, 'matchAll').mockImplementation((() => (function* (): Iterable<unknown> {
      yield undefined
      yield { 0: control[0], index: undefined }
      yield { 0: control[0], 1: undefined, 2: undefined, index: control.index }
      yield { 0: control[0], 1: 'https://a.test/deg', 2: undefined, index: control.index }
      yield control
    })()) as unknown as typeof String.prototype.matchAll)
    expect(parseLiteResults(fixtureHtml)).toEqual([
      { url: 'https://a.test/deg' },
      { url: controlUrl, title: controlTitle, snippet: controlSnippet },
    ])
  })
})

describe('decodeResultUrl', () => {
  it('resolves a uddg redirect to its decoded target', () => {
    expect(decodeResultUrl(ddgRedirect('https://openwrt.org/docs/guide-user/network/mptcp?s[]=p.txt'))).toBe(
      'https://openwrt.org/docs/guide-user/network/mptcp?s[]=p.txt',
    )
    // The exact-path `/l/` form and the `www.` subdomain form.
    expect(decodeResultUrl(`https://www.duckduckgo.com/l/?uddg=${encodeURIComponent('https://t.test/x')}`))
      .toBe('https://t.test/x')
    expect(decodeResultUrl(`https://duckduckgo.com/l/?uddg=${encodeURIComponent('https://t.test/y')}`))
      .toBe('https://t.test/y')
  })

  it('resolves uddg redirects under the /l/ path prefix', () => {
    expect(decodeResultUrl(`https://duckduckgo.com/l/extra?uddg=${encodeURIComponent('https://t.test/z')}`))
      .toBe('https://t.test/z')
  })

  it('returns undefined for DDG-internal links without a usable uddg', () => {
    expect(decodeResultUrl('https://duckduckgo.com/l/?uddg=')).toBeUndefined()
    expect(decodeResultUrl('https://duckduckgo.com/l/?foo=bar')).toBeUndefined()
    expect(decodeResultUrl('https://duckduckgo.com/t/something')).toBeUndefined()
  })

  it('returns undefined for a uddg value that is not a URL', () => {
    expect(decodeResultUrl('https://duckduckgo.com/l/?uddg=:::not%20a%20url:::')).toBeUndefined()
  })

  it('passes external absolute and protocol-relative URLs through', () => {
    expect(decodeResultUrl('https://example.com/x?y=z')).toBe('https://example.com/x?y=z')
    expect(decodeResultUrl('//example.com/x')).toBe('https://example.com/x')
  })

  it('returns undefined when the href does not parse at all', () => {
    expect(decodeResultUrl('http://[broken')).toBeUndefined()
  })
})

describe('stripTags and entity decoding', () => {
  it('strips tags and collapses whitespace', () => {
    expect(stripTags('<b>bold</b> and <i>italic</i>')).toBe('bold and italic')
    expect(stripTags('a\n  b\t   c')).toBe('a b c')
    expect(stripTags('  padded  ')).toBe('padded')
  })

  it('decodes named and numeric entities', () => {
    expect(stripTags('A &amp; B &quot;Q&quot; &apos;A&apos; &lt;L&gt; &gt;G&lt; &nbsp;pad')).toBe(
      'A & B "Q" \'A\' <L> >G< pad',
    )
    expect(stripTags('&#8211; en &#x2715; cross')).toBe('– en ✕ cross')
  })

  it('decodes a double-encoded &amp;lt; exactly once', () => {
    expect(stripTags('&amp;lt;')).toBe('&lt;')
    // The single-encoded &gt; decodes to a literal > while the double-encoded
    // &amp;lt; stops at one entity.
    expect(stripTags('x &amp;lt;script&gt; y')).toBe('x &lt;script> y')
  })
})

describe('challengeDetection', () => {
  it('returns undefined for a genuine result page', () => {
    expect(challengeDetection(fixtureHtml)).toBeUndefined()
  })

  it('flags challenge markers with the stable message', () => {
    const message = 'DuckDuckGo Lite returned a challenge page instead of results; retry later or adjust the query'
    for (const body of [
      '<html><body>anomaly detected</body></html>',
      '<html><head><title>Captcha</title></head></html>',
      '<p>are you a robot?</p>',
      '<div class="challenge">verify</div>',
    ]) {
      expect(challengeDetection(body)).toBe(message)
    }
  })

  it('returns undefined for an empty page without markers', () => {
    expect(challengeDetection('<html><body><div class="results">none</div></body></html>')).toBeUndefined()
  })
})

describe('DuckDuckGoLiteSearchProvider', () => {
  it('registers under the duckduckgo-lite provider id', () => {
    expect(DUCKDUCKGO_LITE_PROVIDER_ID).toBe('duckduckgo-lite')
    expect(provider().id).toBe(DUCKDUCKGO_LITE_PROVIDER_ID)
  })

  it('is available for a parseable base URL and a non-empty user agent', () => {
    expect(provider().available()).toBe(true)
    expect(provider('not a url').available()).toBe(false)
    expect(provider(base, '').available()).toBe(false)
  })

  it('snapshots the options once per search', async () => {
    const options: DuckDuckGoLiteSearchProviderOptions = { baseURL: 'https://one.test/', userAgent: 'UA-one' }
    const p = new DuckDuckGoLiteSearchProvider(() => options)
    const fetchMock = vi.fn(async () => htmlResponse(litePage('')))
    vi.stubGlobal('fetch', fetchMock)
    await p.search({ query: 'first' })
    options.baseURL = 'https://two.test/'
    options.userAgent = 'UA-two'
    await p.search({ query: 'second' })
    expect(fetchCall(fetchMock, 0)[0]).toBe('https://one.test/?q=first')
    expect(fetchCall(fetchMock, 0)[1].headers).toEqual({ 'user-agent': 'UA-one', 'accept': 'text/html' })
    expect(fetchCall(fetchMock, 1)[0]).toBe('https://two.test/?q=second')
    expect(fetchCall(fetchMock, 1)[1].headers).toEqual({ 'user-agent': 'UA-two', 'accept': 'text/html' })
  })

  it('requests the query against the configured base URL with redirect: error', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(litePage('')))
    vi.stubGlobal('fetch', fetchMock)
    await provider().search({ query: 'openwrt mptcp' })
    const [url, init] = fetchCall(fetchMock)
    expect(url).toBe(`${base}?q=openwrt%20mptcp`)
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('error')
    expect(init.headers).toEqual({ 'user-agent': DUCKDUCKGO_DEFAULT_USER_AGENT, 'accept': 'text/html' })
    expect(init.signal).toBeUndefined()
  })

  it('appends a slash to a base URL without one', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(litePage('')))
    vi.stubGlobal('fetch', fetchMock)
    await provider('https://lite.test').search({ query: 'q' })
    expect(fetchCall(fetchMock)[0]).toBe('https://lite.test/?q=q')
  })

  it('threads the caller signal into the fetch request', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => htmlResponse(litePage('')))
    vi.stubGlobal('fetch', fetchMock)
    await provider().search({ query: 'q' }, controller.signal)
    expect(fetchCall(fetchMock)[1].signal).toBe(controller.signal)
  })

  it('returns the parsed sources for a result page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(fixtureHtml)))
    const result = await provider().search({ query: 'openwrt mptcp' })
    expect(result.truncated).toBe(false)
    expect(result.content).toBeUndefined()
    expect(result.sources).toHaveLength(10)
    expect(result.sources[0]!.url).toBe(expectedUrls[0]!)
  })

  it('reports an empty result page as an empty source list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(litePage(''))))
    await expect(provider().search({ query: 'nothing at all' }))
      .resolves.toEqual({ sources: [], truncated: false })
  })

  it('fails a 200 challenge body with WEB_PROVIDER_ERROR', async () => {
    const captcha = '<html><head><title>Captcha</title></head><body>verify you are human</body></html>'
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(captcha)))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: expect.stringContaining('challenge page') }))
  })

  it('maps an HTTP redirect to WEB_PROVIDER_ERROR without contacting the target', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 301, headers: { location: 'https://redirect-target.test/x' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'DuckDuckGo Lite search failed (HTTP 301)' }))
    // The redirect target is never fetched: exactly one request, the original.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchCall(fetchMock)[0]).toBe(`${base}?q=q`)
  })

  it('maps a non-OK HTTP status to WEB_PROVIDER_ERROR', async () => {
    // 2xx statuses are OK (202 parses as a body); 502 is the non-OK error path.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'DuckDuckGo Lite search failed (HTTP 502)' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR with the error message', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'DuckDuckGo Lite search request failed: TypeError: connection refused' }))
  })

  it('maps a non-Error rejection to its string form', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject('boom')))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'DuckDuckGo Lite search request failed: boom' }))
  })

  it('maps an unreadable response body to WEB_PROVIDER_ERROR with the cause', async () => {
    const response = htmlResponse('x')
    const broken = new TypeError('stream broke')
    response.text = () => Promise.reject(broken)
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(provider().search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'DuckDuckGo Lite response body unreadable: TypeError: stream broke', cause: broken })
  })

  it('maps a pre-aborted signal to WEB_ABORTED with the signal reason', async () => {
    const controller = new AbortController()
    const reason = new Error('user cancelled')
    controller.abort(reason)
    const fetchMock = vi.fn(async () => htmlResponse(litePage('')))
    vi.stubGlobal('fetch', fetchMock)
    await expect(provider().search({ query: 'q' }, controller.signal))
      .rejects.toMatchObject({ code: 'WEB_ABORTED', message: 'DuckDuckGo Lite search aborted', cause: reason })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps a bare AbortError rejection to WEB_ABORTED with the error as cause', async () => {
    const abort = new DOMException('aborted', 'AbortError')
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(abort)))
    await expect(provider().search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_ABORTED', message: 'DuckDuckGo Lite search aborted', cause: abort })
  })

  it('maps a caller abort during the request to WEB_ABORTED with the signal reason', async () => {
    const controller = new AbortController()
    const reason = new Error('late cancel')
    vi.stubGlobal('fetch', vi.fn(async () => {
      controller.abort(reason)
      return Promise.reject(new DOMException('aborted', 'AbortError'))
    }))
    await expect(provider().search({ query: 'q' }, controller.signal))
      .rejects.toMatchObject({ code: 'WEB_ABORTED', message: 'DuckDuckGo Lite search aborted', cause: reason })
  })

  it('maps a caller abort while reading the body to WEB_ABORTED', async () => {
    const controller = new AbortController()
    const response = htmlResponse(litePage(''))
    response.text = () => {
      controller.abort('late')
      return Promise.reject(new DOMException('aborted', 'AbortError'))
    }
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(provider().search({ query: 'q' }, controller.signal))
      .rejects.toMatchObject({ code: 'WEB_ABORTED', message: 'DuckDuckGo Lite search aborted', cause: 'late' })
  })
})

type CtxWithFakeRegister = Context & { web: { registerSearchProvider: ReturnType<typeof vi.fn> } }

describe('web-search-duckduckgo plugin', () => {
  function fakeCtx() {
    return { web: { registerSearchProvider: vi.fn() } } as unknown as CtxWithFakeRegister
  }

  it('exposes the plugin namespace shape and has no default export', () => {
    expect(duckduckgoPlugin.name).toBe('web-search-duckduckgo')
    expect(duckduckgoPlugin.inject).toEqual(['web'])
    expect('default' in duckduckgoPlugin).toBe(false)
  })

  it('fills the schema defaults for an empty config', () => {
    expect(duckduckgoPlugin.Config({})).toEqual({
      baseURL: DUCKDUCKGO_DEFAULT_BASE_URL,
      userAgent: DUCKDUCKGO_DEFAULT_USER_AGENT,
    })
  })

  it('registers a duckduckgo-lite provider with the config defaults', () => {
    const ctx = fakeCtx()
    duckduckgoPlugin.apply(ctx, {})
    expect(ctx.web.registerSearchProvider).toHaveBeenCalledTimes(1)
    const registered = ctx.web.registerSearchProvider.mock.calls[0]![0] as WebSearchProvider
    expect(registered.id).toBe(DUCKDUCKGO_LITE_PROVIDER_ID)
    expect(registered.available()).toBe(true)
  })

  it('threads the config into the registered provider', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(litePage('')))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = fakeCtx()
    duckduckgoPlugin.apply(ctx, { baseURL: 'https://mirror.test/', userAgent: 'TestAgent/1.0' })
    const registered = ctx.web.registerSearchProvider.mock.calls[0]![0] as WebSearchProvider
    const result = await registered.search({ query: 'a b' })
    expect(result.sources).toEqual([])
    const [url, init] = fetchCall(fetchMock)
    expect(url).toBe('https://mirror.test/?q=a%20b')
    expect((init.headers as Record<string, string>)['user-agent']).toBe('TestAgent/1.0')
  })

  it('serves fixture results through the registered provider', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(fixtureHtml)))
    const ctx = fakeCtx()
    duckduckgoPlugin.apply(ctx, {})
    const registered = ctx.web.registerSearchProvider.mock.calls[0]![0] as WebSearchProvider
    const result = await registered.search({ query: 'openwrt mptcp' })
    expect(result.truncated).toBe(false)
    expect(result.sources).toHaveLength(10)
  })
})

describe('web-search-duckduckgo invariant companion', () => {
  it('exposes the companion namespace shape', () => {
    expect(duckduckgoInvariant.name).toBe('web-search-duckduckgo-invariant')
    expect(duckduckgoInvariant.inject).toEqual(['invariants'])
  })

  it('registers the manifest name and returns the registration disposer', async () => {
    const disposer = vi.fn()
    const register = vi.fn((_packageName: string, _installer: () => void) => disposer)
    const ctx = { invariants: { register } } as unknown as Context & { invariants: { register: typeof register } }
    const result = await duckduckgoInvariant.apply(ctx)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-web-search-duckduckgo', expect.any(Function))
    expect(result).toBe(disposer)
    // The companion's install is an explained no-op: invoking it returns nothing.
    const install = register.mock.calls[0]![1]
    expect(install()).toBeUndefined()
  })
})
