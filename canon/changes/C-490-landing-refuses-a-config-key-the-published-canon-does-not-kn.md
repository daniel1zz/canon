---
id: C-490
title: Landing refuses a config key the published canon does not know
status: open
rules: [BR-2224]
---

## 为什么

负责人在 canon human #26 选了 A：配置键的检查也要对照已发布的 canon 认识什么，发布版不认识的键不许合入。BR-2248 只拿 main 的代码比，而会话们实际运行的是 PATH 上发布的 `dist/canon`（BR-2222、BR-2412），它可能比 main 旧。

查下来 BR-2224 本该挡住这种情况：after 模式下合入运行 PATH 上的 `canon config --schema`，看退出码。但 `canon config --schema` 按 BR-2175 根本不读配置，配置里有未知键也退出 0（实测：发布版对写了 `not_a_key_xyz: 1` 的配置退出 0，同一目录 `canon search` 以未知键报错）。所以 BR-2224 从来拦不住任何键。

## 要改什么

- BR-2224 改写：已发布的 canon 就是 PATH 上的 `canon`（canon 自己的仓库里是 `dist/canon`；用 canon 的项目里是装的 canon，通常就是运行合入的那个）。合入向它要 `canon config --schema`，用 ajv 拿被合入树的 `canon/config.yaml` 去校验：不认识的键按 `<上一层>.<键>` 点名（顶层、`hooks`、`check_reviews` 等），会被拒绝的值也点名，原因 `config`，退出码 1，提示等包含它们的发布。取不到 schema（PATH 上没有、非 0 退出、输出不是 JSON Schema）同样拒绝，不当成认识。仍只在 `floor_timing: after` 下做。
- 代码：`src/work/watch/published.ts`，`watch.ts` 的 `pathCanonReads` 调它；测试里假的 `canon` 改成打印一个接受任何配置的 schema。

## 陷阱和假设

- 依赖 BR-2175：canon 读配置时接受的，schema 一定接受，所以按 schema 拒绝不会误拒；schema 表达不了的检查（脚本是否存在等）这一步不比较。
- 测试里 after 模式的合入都要在 PATH 前面放一个打印 schema 的假 `canon`，否则会用本机装的 canon。

## 教训

- `canon config --schema` 不读配置，却被 BR-2224 当成“能不能读配置”的探针用了很久（429 次运行，0 次拒绝）；测试用的假 canon 直接按退出码模拟，所以发现不了 → 现在由 BR-2224 的测试用真实 schema 去掉一个键来模拟旧版本保证。

## 任务

- [x] 改写 BR-2224，加 `src/work/watch/published.ts` 和测试
