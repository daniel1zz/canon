---
id: C-460
title: canon rule domain is refused in a guarded primary checkout like the other
  document commands (#184)
status: open
rules:
  - BR-2409
---

## 为什么

#184：C-453（BR-2409）让新建文档的命令在受守卫保护、签出了 main 的主 checkout 里拒绝运行，但漏了 `canon rule domain`。它照样把 `canon/rules/<名字>/README.md` 写进主 checkout：那里提交不了，留着会让所有落地以 main-dirty 被拒。复现：throwaway 项目 `canon init` 并提交到 main 后，主 checkout 里 `canon rule domain demo2 --code src` → 退出码 0，`git status` 显示 `?? canon/rules/`。

## 要改什么

- `canon rule domain` 在写 README 之前按 BR-2409 同样检查，同样的提示，退出码 1，什么也不写；在变更的工作树里照常建出。
- BR-2409 的规则列出 `canon rule domain`，加一条两侧的例子。
- 不在范围内：其他写文件的命令（`canon init`、`canon update` 有自己的流程）。

## 教训

无

## 任务

- [x] `canon rule domain` 调 `refuseOnGuardedMain`
- [x] 测试 `BR-2409: canon rule domain refuses ...`（去掉修复时失败，加上后通过）
