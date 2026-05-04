## 审核报告

### 审核概要
| 项目 | 内容 |
|------|------|
| 审核时间 | 2026-05-04 20:57:53 |
| 审核轮次 | 最终复审 |
| 变更范围 | 4 个重点文件（server/src/services/openrouter-provider.ts、server/src/routes/tts.ts、server/__tests__/security-gate.test.ts、server/__tests__/smoke-real-openrouter.test.ts） |
| 审核结论 | 通过（PASS；真实 OpenRouter E2E 因无真实 key 且本轮明确禁止发真实请求，仍为非代码阻塞） |

### 问题清单

#### Critical（必须修复，阻断发布）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| - | - | 未发现 Critical 问题 | - |

#### Major（必须修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| - | - | 未发现 Major 问题；此前 Major 已关闭 | - |

#### Minor（建议修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| m1 | server/src/services/openrouter-provider.ts:307-320 | 当前敏感 key 集合覆盖 snake_case OAuth 字段与常见通用字段，但仍是精确 lower-case 匹配，未覆盖 `accessToken`、`refreshToken`、`idToken`、`clientSecret`、`authorizationHeader` 等 camelCase/别名字段。当前修复目标中的 `access_token`/`client_secret` 已安全，此项不阻断本轮 PASS。 | 后续可将 key 归一化为 lower-case 并移除 `_`/`-` 后匹配，补充 camelCase 别名回归测试。 |

### Major 关闭确认
| 原 Major/验收点 | 复审结论 | 证据 |
|------|------|------|
| JSON fallback 不泄露裸 token/secret | 已关闭 | `extractErrorMessage()` 兜底使用 `JSON.stringify(sanitizeErrorMetadata(data)).slice(0, 300)`，随后再 `sanitizeText(raw)`；M3 回归测试覆盖顶层与嵌套 `access_token`/`client_secret` 裸值，响应与 DB 均断言不含明文。 |
| smoke 无 key blocked 报告 | 已关闭 | 无 key运行 `smoke-real-openrouter.test.ts` 生成 blocked report：`server/agent-outputs/tester/phase4-real-openrouter-smoke/report-1777899374243.json`，内容为 `realOpenRouterVerified=false`、`status=blocked`。 |
| 有 key single-it E2E | 代码结构已关闭，真实调用未执行 | `smoke-real-openrouter.test.ts` 将有 key真实生成、文件、job detail、audio endpoint、history、报告写入集中在单个 `itIfKey` 中，避免 beforeEach 清库破坏链路。本轮按要求不设置真实 key、不发真实 OpenRouter 请求，因此该真实链路仍需有 key环境验收。 |
| metadata 递归脱敏 | 已关闭 | `sanitizeEntry()` 递归处理对象、数组、字符串；敏感 key 直接 `[REDACTED]`；security-gate M1 覆盖 token key、多 OAuth 字段、嵌套数组。 |
| 所有 provider/TTS errorMessage 出口脱敏 | 已关闭 | provider 非 audio、network catch、JSON/message fallback 均调用 `sanitizeText()`；TTS route 对 `result.errorMessage` 入库与返回二次 `sanitizeText()`，unexpected catch 也使用 `safeErrMsg`。 |
| route 兜底 | 已关闭 | `server/src/routes/tts.ts:276,293,315,328` 对失败入库、失败响应、异常入库、异常响应均使用脱敏后的消息。 |

### 质量对比结论
| 维度 | 基准状态 | 新状态 | 对比结论 |
|------|---------|--------|---------|
| 代码质量 | 前轮复审仍存在 JSON fallback 明文泄露路径 | fallback 改为先递归脱敏 metadata 再序列化，route 保留二次兜底 | 提升 |
| 测试覆盖率 | security-gate 31 passed，缺少 M3 fallback 回归 | security-gate 34 passed，新增 3 个 M3 用例 | 提高 |
| 性能指标 | 错误路径递归脱敏，开销可忽略 | 仅错误响应小对象处理，无新增热路径风险 | 维持 |
| 安全风险 | 无 message JSON 错误体可泄露裸值 | 目标路径未发现新增敏感信息泄露 | 无新增 |

### 安全审计结果
| 发现 | OWASP 分类 | 置信度 | 严重性 | 修复建议 |
|------|-----------|--------|--------|---------|
| 本轮未发现置信度 >80% 的新增安全问题 | - | - | - | - |

### 验证记录
| 命令/检查 | 结果 |
|------|------|
| `Remove-Item Env:OPENROUTER_API_KEY -ErrorAction SilentlyContinue; npm run typecheck` | PASS：`tsc --noEmit` 通过 |
| `Remove-Item Env:OPENROUTER_API_KEY -ErrorAction SilentlyContinue; npm run build` | PASS：`tsc` 构建通过 |
| `Remove-Item Env:OPENROUTER_API_KEY -ErrorAction SilentlyContinue; npx vitest run __tests__/security-gate.test.ts __tests__/smoke-real-openrouter.test.ts` | PASS：2 个文件通过；35 passed / 1 skipped；未发真实 OpenRouter 请求 |
| `Remove-Item Env:OPENROUTER_API_KEY -ErrorAction SilentlyContinue; npm test` | PASS：9 个测试文件通过；208 passed / 1 skipped；未发真实 OpenRouter 请求 |
| blocked report 内容读取 | PASS：`realOpenRouterVerified=false`、`status=blocked`、reason 为未设置 `OPENROUTER_API_KEY` |
| 代码静态复审 | PASS：未发现 `JSON.stringify(data)` 原始 fallback；未发现 `result.errorMessage` 原样入库/返回路径 |

### 正向反馈
- 修复准确命中了前轮阻塞点：JSON fallback 先复用递归 metadata 脱敏，再进入可读 errorMessage。
- M3 测试同时覆盖响应体、DB error_message 与非敏感内容可读性，能够防止再次回归。
- 在不使用真实 key的约束下，typecheck、build、目标安全测试与全量 server 测试均通过。

### 剩余非代码阻塞
- 真实 OpenRouter 有 key E2E 未在本轮执行：本轮明确禁止设置真实 key和发真实 OpenRouter 请求，因此只能确认测试结构正确、无 key blocked 报告正确；真实链路验证需在具备授权 key的受控环境执行。

### 建议下一步
通过。可进入提交/归档流程；后续在具备授权 key的受控环境补跑真实 OpenRouter smoke，并可择机处理 camelCase 敏感字段别名的 Minor 加固。
