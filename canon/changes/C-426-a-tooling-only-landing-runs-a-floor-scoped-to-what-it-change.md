---
id: C-426
title: A tooling-only landing runs a floor scoped to what it changed instead of
  the full floor, and does not wait behind full-floor landings (#151)
status: open
rules: []
---

## 为什么

#151：只改工具代码的合入（例如 zhushenkongjian 的 C-343、C-345，只改了 `tools/devlog/` 下一个文件、它的 `tools/tests/` 测试、`canon/rules/devlog/` 的规则和变更文件）也要跑整个 floor（Godot 导入、全部脚本编译、lint、整套 gdUnit4、冒烟启动），还要排在 11 个游戏合入后面，等了一个多小时。`floor_skip_paths`（BR-2164）只能整个跳过 floor，没有“只跑这部分代码相关测试”的中间档。等得太久，负责人手动绕过了合入（#150，已按已知限制关闭）。

## 要改什么

- 期望：改动只落在某个配置声明的路径范围里的合入，跑那个范围自己的 floor 命令（例如 `python3 -I` 跑工具测试加 `canon check`），不跑整个 floor；main 仍然只前移到“跑过覆盖这次改动可能弄坏的一切”的树（BR-2014 的承诺不变）。
- 先写决策（canon-design），至少比较：(1) 配置按路径列出几个 floor（`floors: [{paths, command}]`），改动全落在一项里就跑它；(2) 用 `test_select_command` 选中的测试代替 floor；(3) 快的合入单独一条队列。要回答：快的合入还要不要在慢的 floor 跑着时排队（队列是串行的，BR-2014；让它插队就要说明对公平和冲突的影响）；路径范围的测试读不读范围外的文件（类似 BR-2181 的检查）；一起测（BR-2172）时范围不同的条目能不能同批。
- 规则按决策写，每条有边界两侧的例子。
- 不做：改变 `floor_skip_paths` 的现有含义。
