---
id: C-477
title: canon-test and canon-diagnose state refusals and determinism once, so the
  release check passes on main (#189)
status: done
rules: []
---

## 为什么

C-476 在自己的分支上让 `bun scripts/release.ts --check` 通过了，但合入时变基到 C-472 之后（C-472 改了 canon-rules 和 canon-domains），main 上的 11d5c1b68 再跑这个检查又拦下两条重复：canon-test 三处要求测试拒绝的情况，canon-diagnose 第 1 阶段复述 canon-test 第 4 节的“确定性”。不改掉，main 的发布仍然卡住（#189）。

## 要改什么

只改 skill 文本，规则行为不变：

- canon-test 第 1 节第 2 步把“拒绝也成为用例”并进“每个例子成为用例”一条；第 5 节第 1 条只留“先列出必须失败的情况，没跑到的就是没覆盖的要求”，怎么测拒绝只留在第 4 节。
- canon-diagnose 第 1 阶段的“确定性”指向 canon-test 第 4 节。
- canon-parallel 第 2 节第 3 步原来指向 canon-rules 第 6 节第 5 步说“规则改动放在实现它的变更里”；C-476 把那一步缩成“测试和规则同一提交”后指向不再成立，改为指向 brief。

## 教训

- 同一批 skill 文本，分支上通过的重复检查在变基后的 main 上又拦下新的重复：检查对整份文本做模型判断，别的变更改了任何一个 skill 都会让结果变化，合入前的预检不代表 main 能发布 → 待负责人确认是否固化（例如合入改了 skill 的变更时，在变基后的文本上跑同一个检查）。

## 任务

- [x] 改 canon-test、canon-diagnose、canon-parallel
- [x] 在 11d5c1b68 之上 `bun scripts/release.ts --check` 通过
