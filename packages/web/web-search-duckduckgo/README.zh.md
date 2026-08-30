# @deepseek-ai/dsh-web-search-duckduckgo

[English](README.md) | 中文

无需密钥、免费的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.zh.md)（`ctx.web`）。它请求 DuckDuckGo 的 **Lite**（无 JS）检索页（`GET https://lite.duckduckgo.com/lite/?q=…`），并把结果表格——`result-link` 锚点提供标题与 URL，其后的 `result-snippet` 单元格提供 snippet——解析为 seam 规范化的 `WebSearchResult`。

这是付费的 [`@deepseek-ai/dsh-web-search-deepseek`](../web-search-deepseek/README.zh.md) 提供方的**免费回退**：无需 API 密钥，无需额外的模型轮次，每次检索只发出一个纯 HTML GET。DuckDuckGo 会把大多数结果 URL 包进自己的 `//duckduckgo.com/l/?uddg=<encoded>` 重定向；提供方会解码 `uddg` 目标，使调用方收到真实 URL。

与 `@deepseek-ai/dsh-web-search-deepseek` 一样，它是一个**实现**包：它向 `ctx.web` 注册提供方（函数插件，`inject: ['web']`），不注册面向模型的工具——`@deepseek-ai/dsh-tool-web` 仍是 `web_search`／`web_fetch` 的唯一拥有者。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | `https://lite.duckduckgo.com/lite/` | Lite 检索页基址；查询以 `?q=` 追加在该路径上。 |
| `userAgent` | `Mozilla/5.0` | 每个请求的 `user-agent` 头。通用的浏览器风格 agent 可让页面正常返回结果；机器人形态的 agent 有触发挑战响应的风险。 |

```yaml
- id: web-search-duckduckgo
  name: '@deepseek-ai/dsh-web-search-duckduckgo'
```

上面的条目不带配置；每个键都由 schema 提供默认值。要让 `web_search` 走这个提供方，把 seam 的选择项设为它的 id（在 `@deepseek-ai/dsh-web` 条目上设置 `searchProvider: duckduckgo-lite`，或在启动时设置 `$DSH_WEB_SEARCH_PROVIDER`）。

## 解析

- 结果是有序的 `class='result-link'` 锚点。每个结果的 snippet 是出现在**下一个结果链接之前**的第一个 `class='result-snippet'` 单元格——窗口为空表示该结果没有 snippet，绝不会从相邻结果借用。
- 锚点文本与 snippet 单元格会被归约为展示文本（剥离标签、解码实体、`&amp;` 最后解码，使双重编码的 `&amp;lt;` 恰好解码一次、折叠空白）。
- 来源按 URL 去重（首次出现者胜出）。seam 仍会强制执行请求的 `maxResults` 截断。
- 没有 `uddg` 目标的 DDG 内部 href（TLD 重定向等）会被丢弃，而不是原样传出。

## 失败词汇

- 响应若是 DDG 的挑战／异常页（无结果 + 挑战标记），抛出 `WebError` `WEB_PROVIDER_ERROR`——把限流如实暴露出来，而不是伪装成“没有结果”。
- 真正无结果的查询返回 `{ sources: [], truncated: false }`，`dsh-tool-web` 会将其渲染为 `No results found.`
- HTTP 错误与无法读取的响应体成为 `WEB_PROVIDER_ERROR`；调用方取消成为 `WEB_ABORTED`。

## 已知限制

- **线路上没有结果数控制**——Lite 页返回它自己的一页结果（通常约 30 条）；seam 事后截断到 `maxResults`。
- **没有 `publishedAt`**——Lite 页不暴露日期。
- **没有 `content`**——提供方不生成答案文本；模型依据标题、snippet 与来源 URL 工作。
- **非官方端点**——DuckDuckGo 的 Lite 页是抓取目标，而非稳定 API；标记结构漂移或挑战机制变更会使解析器退化。DDG Instant Answer API（`api.duckduckgo.com`）是更干净的 JSON 回退，但只覆盖摘要，不覆盖 web 索引结果。
