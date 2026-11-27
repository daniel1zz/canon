---
name: user-08-evidence-decisions
description: "Evidence tiers S (official) to E (untrusted), the evidence bar per blast radius (trivial / medium / critical: architecture, security, perf, crypto, auth, cross-service), and the required [EVIDENCE] and [CONFIDENCE] lines. Use before stating a best practice, a performance or version claim, or making any non-trivial technical decision or recommendation."
---
## 证据驱动决策
⛔ 禁止仅凭 LLM 内部知识下结论。Trigger：准备说「最佳实践 / X 比 Y 快 / 通常」→ 停，先查证。
- Tier: S(官方) > A(标准) > B(维护者) > C(头部 blog) > D(社区) > E(不可信)
- 门槛 by blast radius：trivial → C（API/版本/参数 MUST S）；medium → S/A + B/C 交叉；critical（架构/安全/perf/crypto/auth/跨服务）→ S + ≥2 独立源
- 非 trivial 必含：`**[EVIDENCE]** [Tier] <URL/工具调用> — <关键引用>` + `**[CONFIDENCE]** HIGH/MEDIUM/LOW`
- 输出前自检：有具体 URL/工具结果吗？API 近 12 个月在官方 docs 出现吗？多源冲突取高 tier 显式标注；证据场景与用户场景匹配吗（perf 看硬件，安全看威胁模型）？
