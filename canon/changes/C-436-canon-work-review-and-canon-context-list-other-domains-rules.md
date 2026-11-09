---
id: C-436
title: canon work review and canon context list other domains' rules and
  decisions that share the edited document's identifiers (#165)
status: open
rules: []
---

## 为什么

#165：合入评审拦下的矛盾里，一大半是和别的领域的规则或决策的矛盾。会话改一条规则时，没有办法一次看到说的是同一件事的其他规则和决策：`canon context` 只按领域列标题，`canon search` 要自己想关键词。结果矛盾一轮评审一个地冒出来，每轮都要排队。

## 要改什么

- `canon work review` 和 `canon context <规则或决策编号>` 的输出里，多一段：别的领域里和这次改动的文档共用标识符（反引号里的字段名、事件名、配置键、命令名，以及引用的规则或决策编号）的生效规则和已接受决策，只列编号和标题，有数量上限，超出时写明截断了多少。
- 只是提示：不拦截，退出码不变；没有共用标识符时不输出这一段。
- 新增一条规则写上面的行为和两侧例子；改 BR-2358 写明 `canon work review` 多了这一段。

不做：不改合入评审给模型的提示范围（D-72 否决了按共用标识符打包，要推翻需按 D-67 的方式先测召回）；不保证找全。

## 教训

无

## 任务

- [ ] 新规则 + BR-2358
- [ ] 按标识符找其他领域的规则和决策
- [ ] 测试按规则命名
