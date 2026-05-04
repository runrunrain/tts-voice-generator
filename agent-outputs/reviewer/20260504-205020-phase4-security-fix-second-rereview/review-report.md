## 审核报告

### 审核概要
| 项目 | 内容 |
|------|------|
| 审核时间 | 2026-05-04 20:50:20 |
| 审核轮次 | 第二轮复审 |
| 变更范围 | 3 个重点文件（server/src/services/openrouter-provider.ts、server/src/routes/tts.ts、server/__tests__/security-gate.test.ts） |
| 审核结论 | 不通过 |

### 问题清单

#### Critical（必须修复，阻断发布）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| - | - | 未发现 Critical 问题 | - |

#### Major（必须修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| M1 | server/src/services/openrouter-provider.ts:374-393, 410-423；server/src/routes/tts.ts:276,293 | `extractErrorMessage()` 的兜底分支仍可能把无 `error.message`/`message`/字符串 `error` 的 JSON 错误体原样序列化进 `errorMessage`。当前 `sanitizeText()` 只覆盖 Bearer、sk-、`apiKey=`、`access_token=`、`authorization_header=` 等文本形态，不覆盖 JSON/冒号形态，例如上游返回 `{ "access_token": "bare-token-value" }`、`{ "client_secret": "plain-secret" }` 时，`errorMessage` 会变成包含明文值的 JSON 字符串；route 的二次 `sanitizeText(result.errorMessage)` 也无法兜住。该路径会同时返回给客户端并写入 `generationJob.errorMessage`。 | 不要在 errorMessage 兜底中序列化未脱敏原始对象。可改为 `JSON.stringify(sanitizeErrorMetadata(data)).slice(0, 300)`，或更安全地返回固定泛化文案（如 `Upstream error response did not include a message`）并只在 `errorMetadata` 存放递归脱敏后的结构。同时补充回归测试：无 message 的 JSON 错误体包含 `access_token`/`client_secret` 裸值时，响应和 DB error_message 均不含明文。 |

#### Minor（建议修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| m1 | server/src/services/openrouter-provider.ts:307-320 | 敏感 key 集合覆盖了 snake_case OAuth 字段，但仍缺少常见别名/形态，如 `accessToken`、`refreshToken`、`idToken`、`clientSecret`、`authorization_header`、`authorizationHeader`。这些 key 若携带不符合 `sk-`/`Bearer`/`xxx=` 正则的裸 token，会依赖值格式而漏脱敏。 | 将敏感 key 统一规范化后匹配，建议 lower-case 后移除 `_`/`-` 再比较，覆盖 `accesstoken`、`refreshtoken`、`idtoken`、`clientsecret`、`authorizationheader` 等别名；补充 key 命中“不依赖值格式”的回归测试。 |

### 质量对比结论
| 维度 | 基准状态 | 新状态 | 对比结论 |
|------|---------|--------|---------|
| 代码质量 | 第一轮复审指出 metadata 与 errorMessage 存在脱敏缺口 | 递归 sanitizer 已统一，route 增加二次兜底，但 errorMessage JSON 兜底仍使用原始对象语义 | 提升但仍有阻塞缺口 |
| 测试覆盖率 | 缺少 metadata 裸 token key、嵌套数组、network catch、非 audio 文本测试 | security-gate 增至 31 个测试并覆盖主要修复路径 | 提高，但缺少无 message JSON 兜底和 key 别名覆盖 |
| 性能指标 | 无明显风险 | 递归脱敏只处理错误对象，开销可忽略 | 维持 |
| 安全风险 | 存在敏感信息泄露风险 | 主流 message/network/non-audio 路径已缓解，但 JSON fallback 仍可泄露裸 token/secret | 仍有新增/残留风险 |

### 安全审计结果
| 发现 | OWASP 分类 | 置信度 | 严重性 | 修复建议 |
|------|-----------|--------|--------|---------|
| 无 message JSON 错误体经 `JSON.stringify(data)` 进入 errorMessage 时可泄露裸 `access_token`/`client_secret` 等值 | A02 Cryptographic Failures / Sensitive Data Exposure | 85% | Major | errorMessage fallback 使用已脱敏对象或泛化文案，并验证响应与 DB 均不含明文 |

### 验证记录
| 命令 | 结果 |
|------|------|
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm run test -- security-gate` | PASS：1 个测试文件，31 passed；测试内 fetch 均为 mock/无 key blocked，未发真实 OpenRouter 请求 |
| 代码审查 | PASS/FAIL 混合：metadata 任意深度对象/数组递归处理已落地；provider 非 audio 与 network catch errorMessage 已调用 `sanitizeText()`；TTS route 入库/返回已二次 `sanitizeText()`；但 errorMessage JSON 兜底仍存在明文泄露路径 |

### 正向反馈
- `sanitizeEntry()` 对对象、数组、字符串的统一递归处理方向正确，已覆盖任意深度 JSON-like metadata 的主路径。
- TTS route 对 provider failure 与 unexpected catch 的入库/返回做了二次兜底，防御纵深比第一轮明显提升。
- 新增 security-gate 用例覆盖了裸 snake_case token key、嵌套数组、fetch rejection、2xx 非 audio 文本响应和 route belt-and-suspenders，不属于过度脆弱测试。

### 建议下一步
不通过。请修复 M1 后补充对应回归测试，并保留当前 security-gate、typecheck、build 全部通过后再进入下一轮复审。
