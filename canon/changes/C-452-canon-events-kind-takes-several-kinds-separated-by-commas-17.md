---
id: C-452
title: canon events --kind takes several kinds separated by commas (#176)
status: open
rules: [BR-2156, BR-2357, BR-2360]
---

## 为什么

#176：`canon events` 没法按几个事件种类过滤。帮助写着“repeat for several”，但统一的选项检查拒绝重复写的选项（退出码 2），拒绝时提示用逗号隔开，而逗号隔开的值被当成一个种类，什么也列不出。`--follow` 用同一个函数，也有这个问题。canon-parallel skill 和 BR-2360 教的写法也是重复 `--kind`，照着跑会被拒绝。

## 要改什么

- `src/work/stats/commands.ts`：`--kind` 的值用共享的 `list` 按逗号拆开（两边空格不算），列表和 `--follow` 都用它；逗号拆开后一个种类也没有时以退出码 2 拒绝，不悄悄列出全部；帮助改成逗号写法。
- BR-2156：`--kind` 用逗号写多个种类，写两次和空种类以退出码 2 拒绝；例子改成逗号写法。BR-2357 加一个 `--follow` 下逗号写法的例子。BR-2360 和 canon-parallel skill 里的示例命令改成逗号写法。
- 测试：`src/work/stats/commands.test.ts` 通过真实 CLI 验证列表、`--follow`、拒绝和帮助文字。
- 顺带处理 BR-2360 上未关的评审意见（改这份规则时要处理）：正文写明重新认领的 `version` 比记过的都大；同一个 `version` 先 holder-gone、后租约到期会写两条；占位规则的引用改成 BR-2019、BR-2064。例子按代码现状改，`src/work/claims/claims.test.ts` 补两条测试。

## 教训

无

## 任务

- [x] `--kind` 按逗号拆开，列表和 `--follow` 都用；空种类以退出码 2 拒绝；帮助改成逗号写法
- [x] BR-2156、BR-2357、BR-2360 和 canon-parallel skill 改成逗号写法
- [x] 测试：`src/work/stats/commands.test.ts`
- [x] BR-2360 的评审意见和两条新测试
