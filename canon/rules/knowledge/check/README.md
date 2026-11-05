# 检查（knowledge/check）

`canon check` 检查整个 `canon/` 是否自洽：文件格式、编号唯一、引用存在、领域的代码位置（README 的 `code:` 或 `code_root` 下的目录）和代码目录对得上、规则有测试的名字点名（读测试报告的记账，BR-2005）、本变更碰的测试文件有当前内容的报告（BR-2344）、必填段落非空、没有残留的模板占位行、规则 `lists` 声明的代码列表和文字及代码对得上、测试不读 `floor_skip_paths` 下的真实文件。合入时也会跑它（`work/land`）。另有一种只提示、不算发现的输出：固定加载的文字超出预算（BR-2257）。

## 术语

- **发现（finding）**：一条检查结果，带种类（如 `ref-dangling`）、文件和说明。
- **提示（hint）**：写在标准错误上、以 `hint ` 开头的一行，不算发现，不改变退出码。
- **测试名**：JUnit 报告里一个 `testcase` 的外层 `testsuite` 名、`classname` 和 `name`；只有会运行的（没有 `skipped`）测试名里的规则编号才算这条规则有测试（BR-2005）。
- **报告记账**：协调数据库里每个（测试文件路径，文件内容的 git blob 哈希）一行的 `testcase` 列表（BR-2337）；`canon check` 只读它，不运行任何东西。
- **共享代码**：`shared` 列出的、不属于任何业务领域的代码（共享内核，BR-2116）；`code_root` 和 `shared` 写在 `canon/config.yaml`，声明在 `src/knowledge/check/config-keys.ts`。
