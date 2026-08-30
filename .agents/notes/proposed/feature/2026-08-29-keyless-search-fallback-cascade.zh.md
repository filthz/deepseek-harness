# Agent Note：面向被 challenge 的数据中心 IP 的 Mojeek 回退 keyless 网页搜索

Status: proposed

[English](2026-08-29-keyless-search-fallback-cascade.md) | 中文

## Problem

无需 API key 的 DuckDuckGo Lite 提供程序（[`@deepseek-ai/dsh-web-search-duckduckgo`](../../packages/web/web-search-duckduckgo/README.md)）能免 key 返回真实网页索引结果，但 DuckDuckGo 对数据中心 IP 在一次短促的连续请求之后会用 JavaScript 机器人验证（HTTP 202 加异常页面）作答，且该验证只会在以分钟计的冷却期之后才失效。因此单一引擎的 keyless 搜索提供程序在这类 IP 上只能在质量与可靠性之间二选一：DuckDuckGo Lite 的索引更大、更新，并带时间戳；而对机器人宽容的 Mojeek 端点则能稳定返回结果，但索引更小且没有日期。

Mojeek 端点还有一条文档里没有的数据中心 IP 规则：空格按百分号编码（`q=a%20b`）的查询在每次请求时都会得到 JavaScript 验证码页面，而同样查询、完全相同的请求头、空格按表单编码（`q=a+b`）时则正常返回结果。一次三重复的对照实验（Node fetch 与 curl、两种编码、间隔请求）显示 `%20` 3/3 被 challenge、`+` 3/3 出结果。因此任何用 `encodeURIComponent` 构造查询的纯 HTML Mojeek 客户端默认就会被 challenge。

## Proposal

新增两个包并注册一个新的 provider id；不改动任何默认值。

`@deepseek-ai/dsh-web-search-mojeek`（provider id `mojeek`）实现对 `GET https://www.mojeek.com/search?q=…` 的 keyless Mojeek 提供程序。其查询用 `URLSearchParams` 构造，使空格变成 `+`；源码带有警告注释，禁止改回 `encodeURIComponent`，原因即上文所述的 WAF 规则。它施加 20 秒请求超时，对被 challenge 的请求在约 10 秒的抖动退避后重试一次，并在 403/429、`<!-- status=… -->` 头部标记非 `OK`、或验证码标记时抛出 `WEB_PROVIDER_ERROR`；调用方取消为 `WEB_ABORTED`。

`@deepseek-ai/dsh-web-search-fallback`（provider id `duckduckgo-lite-fallback`）是一个级联（cascade）提供程序，按其他搜索包的样式实例化现有的 `duckduckgo-lite` 提供程序作为主引擎、`mojeek` 提供程序作为回退。其策略：中止（信号已中止，或主引擎抛出 `WEB_ABORTED`）不做回退直接传播；其他任何主引擎失败（典型为 challenge 触发的 `WEB_PROVIDER_ERROR`）用同一 request 与 signal 触发回退；主引擎返回有效但零条来源的结果按原样返回，因为两个引擎索引的页面不同；回退也失败时抛出 `WEB_PROVIDER_ERROR`，消息同时点名两个引擎，`cause` 为回退错误。web seam 每个 `searchProvider` 值只接受一个 provider id，所以回退逻辑放在一个提供程序内部，而不是 seam 层面的链。

两个包都遵循 web 包约定：类型化的 `WebSearchProvider`、经每次操作的 `resolveOptions()` 函数解析选项、带默认值的 `schemastery` 配置 schema、带解释的空的 `./invariant` companion、离线单元测试各加一个记录式 e2e 测试、每文件 100% 覆盖率。

`@deepseek-ai/dsh-base` 不做任何改动：两个包可用但不进入 base 默认，与 [`@deepseek-ai/dsh-web-search-exa`](../../packages/web/web-search-exa/README.md) 和 [`@deepseek-ai/dsh-web-search-perplexity`](../../packages/web/web-search-perplexity/README.md) 的处境相同，并且与[默认搜索决定](../implemented/feature/2026-07-31-web-default-search.md)一致——该决定让出货组合的默认保持需要 key；本级联保持为 profile 级自选。profile 通过把 web seam 条目的 `searchProvider` 设为 `duckduckgo-lite-fallback`（或 `mojeek`）来启用。

同一分支还补齐了该分支上已落地的 `web-search-duckduckgo` 包的两处门禁缺口：它获得强制的 `./invariant` companion（exports、`files`、`dsh-invariants` peer 与 dev 依赖、project reference）和一套 100% 每文件覆盖率的离线测试，因为仓库覆盖率门禁会插桩 `packages/*/*/src` 下的每个文件。

## Alternatives considered

只在 DuckDuckGo 提供程序内部做退避与重试。否决：实测冷却期以分钟计，调用内重试浪费工具预算且在封锁期内照样失败；重试只能缓解连发边缘，而这已由 Mojeek 提供程序自身端点的一次退避重试覆盖。

固定单一引擎（只用可靠的 Mojeek，因为从这类 IP 看它最稳）。否决：对出口 IP 不被 challenge 的 profile，它永久放弃 DuckDuckGo 更大的索引与时间戳；而级联只在 DuckDuckGo 被封锁期间多花一次短往返（约 200 ms，即 challenge 应答本身）。

带 key 的搜索 API（Brave Search、Google Custom Search）。否决：它们能恢复可靠性，但引入凭据要求，而这正是 keyless DuckDuckGo 提供程序要规避的；这里的包按构造保持无 key。

经代理把请求路由到非数据中心 IP。否决：它对两个端点都是服务条款灰色地带，依赖第三方基础设施，且没有任何本地信号就改变了观测到的 IP 类别。

## Acceptance criteria

配置 `searchProvider: duckduckgo-lite-fallback` 的 profile 从数据中心 IP 对普通查询在两种 DDG 状态下都返回可引用的来源：未被 challenge 时直接得到 DuckDuckGo 结果，被 challenge 时经 challenge 应答后得到 Mojeek 结果（实测从 challenge 到来源约 1.3 秒端到端）。

`web-search-mojeek` 与 `web-search-fallback` 的离线测试套件通过，两个包均报告语句、分支、函数、行 100% 每文件覆盖率，`web-search-duckduckgo` 用新套件达到同样标准，`verify-package-invariants` 全仓库零违规，host 根类型检查在三个包注册进 `tsconfig.host.json` 与 `tsconfig.base.json` paths 后构建为绿，重复代码门禁报告零克隆。

## Risks

两个端点都是非官方抓取目标：标记漂移或 challenge 机制变化会劣化当前在服务的引擎，而级联不防护 Mojeek 被 challenge 或宕机——双重失败以一个点名的 `WEB_PROVIDER_ERROR` 浮出。

Mojeek 的 `%20` 规则是经验发现（一个 IP 类别的 3/3 对照重复），不是文档化行为；Mojeek 可能收紧、放松或改变触发它的编码。警告放在提供程序源码的编码处，这样将来改回百分号编码时是撞上有据可查的禁令，而不是静默失败。

在 DuckDuckGo 封锁期间，每次搜索都要先付主引擎的往返代价再由回退应答，且 Mojeek 来源没有 `publishedAt`，对小众查询命中数也少于 DuckDuckGo 的一页——模型恰好在工作在被回退触发的状态下、面对更小且无日期的结果集。
