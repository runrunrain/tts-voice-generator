## 审核报告

### 审核概要
| 项目 | 内容 |
|------|------|
| 审核时间 | 2026-05-04 20:33:47 |
| 审核轮次 | 复审第 1 轮 |
| 变更范围 | 4 个重点文件（openrouter-provider.ts、tts.ts、smoke-real-openrouter.test.ts、security-gate.test.ts） |
| 审核结论 | 不通过 |

### 问题清单

#### Critical（必须修复，阻断发布）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| - | - | 未发现 Critical 问题 | - |

#### Major（必须修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| M1 | server/src/services/openrouter-provider.ts:309-337 | metadata 脱敏仍存在明显遗漏：SENSITIVE_KEYS 未包含 access_token/refresh_token/id_token/client_secret 等常见凭据字段；当上游返回 `{ access_token: "bare-token" }` 这类裸 token 值时，当前逻辑不会按 key 红线脱敏，且 sanitizeText 只识别 `access_token=...` 文本形态。数组处理也只处理一层，嵌套数组中的字符串不会递归脱敏，不满足“metadata 字符串/数组递归脱敏”的复审要求。 | 将脱敏实现改为统一递归函数 `sanitizeUnknown(value, key?)`：敏感 key 命中时直接 `[REDACTED]`；数组递归 map 任意深度；对象递归；字符串统一 sanitizeText。敏感 key 集合补齐 access_token、accessToken、refresh_token、id_token、client_secret、authorization_header 等常见别名，并补充对应回归测试。 |
| M2 | server/src/services/openrouter-provider.ts:187-193, 226-237；server/src/routes/tts.ts:272-297 | 仍存在返回/入库前未脱敏的 provider 错误消息路径：2xx 非 audio 响应会把 `text.slice(0, 500)` 直接拼入 errorMessage；network-level catch 会把 `err.message` 直接作为 errorMessage 返回。TTS 路由失败分支随后将 `result.errorMessage` 原样写入 generationJob.errorMessage 并返回给客户端。若上游/底层 fetch 错误文本包含 Bearer/sk/apiKey/access_token，仍会泄漏。 | 在 provider 生成所有 errorMessage 的出口统一调用 sanitizeText，尤其是 UNEXPECTED_RESPONSE_TYPE 和 NETWORK_ERROR 分支；或在 TTS 路由失败分支对 `result.errorMessage` 再做一层 sanitizeText 后入库/返回。补充 network fetch rejection 与非 audio 文本响应携带凭据的回归测试。 |

#### Minor（建议修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| m1 | server/src/services/openrouter-provider.ts:394-399 | sanitizeText 仅覆盖 `apiKey=`/`access_token=` 等等号形态，未覆盖常见的冒号形态（如 `apiKey: value`、`access_token: value`）。如果值没有 sk- 前缀，也可能漏脱敏。 | 将正则分隔符扩展为 `[:=]`，并保留普通错误文案不过度脱敏测试。 |

### 质量对比结论
| 维度 | 基准状态 | 新状态 | 对比结论 |
|------|---------|--------|---------|
| 代码质量 | 已有 provider/route 分层 | 新增 sanitizeText 复用，方向正确，但错误出口未统一 | 部分提升，仍有阻塞缺口 |
| 测试覆盖率 | 缺少脱敏回归 | 新增 error.message 脱敏、无 key blocked smoke 测试 | 提高，但覆盖未涵盖 metadata 裸 token key、嵌套数组、network catch、非 audio 文本 |
| 性能指标 | 无明显性能风险 | 递归脱敏为小对象处理，影响可忽略 | 维持 |
| 安全风险 | 存在错误文本泄漏风险 | 主路径已缓解，但仍有新增/残留错误出口泄漏风险 | 仍有残留 |

### 安全审计结果
| 发现 | OWASP 分类 | 置信度 | 严重性 | 修复建议 |
|------|-----------|--------|--------|---------|
| metadata 裸 token 字段与嵌套数组未充分脱敏 | A02 Cryptographic Failures / Sensitive Data Exposure | 90% | Major | 按 key 与值类型统一递归脱敏，补齐敏感字段别名 |
| provider 部分 errorMessage 出口未 sanitize 即被路由入库/返回 | A02 Cryptographic Failures / Sensitive Data Exposure | 85% | Major | provider 所有错误消息出口或路由统一 sanitize，并补测试 |

### 验证记录
| 命令 | 结果 |
|------|------|
| `$env:OPENROUTER_API_KEY=''; npm test -- smoke-real-openrouter.test.ts security-gate.test.ts` | PASS：2 个测试文件通过；24 passed + 1 skipped；未发真实 OpenRouter 请求 |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| 读取 blocked 报告 | PASS：server/agent-outputs/tester/phase4-real-openrouter-smoke/report-1777897933980.json 中 `realOpenRouterVerified=false` 且 `status=blocked` |

### 正向反馈
- Major 1 主路径已关闭：无 key 场景会落盘 blocked 报告并明确 `realOpenRouterVerified=false`，有 key E2E 合并为单个 it，避免跨测试依赖被 beforeEach 清库破坏。
- error.message 主路径脱敏已明显改善：Bearer、sk-、apiKey=、access_token= 的普通响应文案回归测试通过，普通模型不存在文案未被过度破坏。

### 建议下一步
打回修复上述 Major。修复后复跑目标测试、typecheck/build，并新增覆盖 M1/M2 的回归测试后再复审。
