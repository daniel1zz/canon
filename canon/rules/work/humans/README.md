---
code:
  - src/coord/state.ts
---

# 留给人的问题（work/humans）

只有方向、明确留给人的选择、花钱、对共享范围不可逆的操作、需要凭据时才问人（D-6）。`canon human ask` 记下问题，所有会话都看得到；人在对话里回答后，agent 用 `canon human answer --relayed` 如实记下原话。代码在 `src/coord/state.ts` 的问题部分。

## 术语

- **转述（relayed）**：agent 代人记下回答时附上的人的原话。
