---
id: C-453
title: Creating a document in a guarded primary checkout is refused and points
  at canon work start (#179)
status: open
rules:
  - BR-2409
---

## 为什么

在 main 受 canon 守卫保护的项目里，主 checkout（签出 main）上运行 `canon change new` 会写出一个未跟踪的 `canon/changes/C-n.md`：这里提交不了（守卫拒绝），留着又让其他会话的 `canon work land` 一律以 main-dirty 被拒（#179，#180 是它的重复）。`rule new`、`decision new`、`note new`、`doc new`、`release new` 走同一条路径，问题相同。

## 要改什么

- 新规则 BR-2409（knowledge/documents）：签出 main、canon 的守卫在（任何版本）且 main 上已有 `canon/config.yaml` 时，这些新建命令退出码 1，不分配编号、不写文件；`change new` 提示 `canon work start --title "<标题>"`，其余提示到变更的工作树里运行。空标题仍按 BR-2187 退出码 2。
- `src/install/githook.ts` 加 `guardedMainCheckout`：复用 `guardStatus` 和 hook 自己的判断条件（main 上有 `canon/config.yaml`），不另造检测。
- `src/knowledge/documents/guarded.ts` 的 `refuseOnGuardedMain` 在 `newDocCommand` 和 `release new` 里、分配编号之前调用。
- `canon change new --help` 写明这一点。
- `src/invocation/main.test.ts` 里一个在已提交、受守卫的主 checkout 里建文档的用例改到变更的工作树里建。

## 陷阱和假设

- 测试里 `canon init` 之后没提交时 main 上没有 `canon/config.yaml`，守卫放行，所以这种项目里主 checkout 照常能建文档；只有提交之后才拒绝。
- `canon rule domain` 也会在主 checkout 写 README，不在这次的范围里。

## 教训

无

## 任务

- [x] 规则 BR-2409 和测试
- [x] 拒绝逻辑和帮助文字
