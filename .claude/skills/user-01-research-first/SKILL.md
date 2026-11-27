---
name: user-01-research-first
description: "Which source to use when researching: a library's current API or config (context7), how real code uses an API (grep MCP, regex across public GitHub), how a third-party repo works inside (deepwiki, then verify), code navigation in this repo (built-in LSP tool), community/academic/news (OpenCLI), WebSearch as fallback. Also: use a mature library before building one, default to the latest version, copy benchmark products for product/UI/UX. Use before researching a topic, choosing or adding a dependency, calling an unfamiliar API, or designing product/UI."
---
## 研究优先

遇到下面的情况，先用对应的工具，不凭记忆写：

| 情况 | 用什么 |
|---|---|
| 某个库现在的 API、参数、配置怎么写；版本迁移 | context7（`resolve-library-id` → `query-docs`）。模型记忆可能过时，哪怕觉得自己知道也查 |
| 别人在真实代码里怎么用某个 API、某种写法常不常见 | grep MCP（`searchGitHub`，按代码片段搜，支持正则和语言、仓库过滤） |
| 第三方仓库内部怎么工作（锁、并发、生命周期等） | deepwiki（`ask_wiki_question`）。回答是 AI 生成的：关键结论到源码或官方文档里核实一次 |
| 本仓库里的定义、引用、类型、调用链 | 内置 LSP 工具（TypeScript 已装 typescript-lsp 插件）；纯文本匹配用 grep/rg |
| 社区讨论、学术、资讯 | OpenCLI；找不到再用 WebSearch |
| GitHub 上的 issue、PR、仓库文件 | `gh` 命令 |

## 选型

- 成熟的 SDK 或库已经存在就用它，自建是最后手段；自建前也先找参考实现
- 三方库默认用最新版本；产品和 UI/UX 抄标杆
- 去偏：候选里至少放一个小众（不到 5k 星）的选项，查一查“曾经流行、正在衰落”的方案；每个候选至少找一条负面来源（issue、迁移文章、弃用说明）
- 基准测试前先问：性能差别会不会改变决定？不会就不测
