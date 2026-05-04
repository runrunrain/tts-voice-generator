## 审核报告

### 审核概要
| 项目 | 内容 |
|------|------|
| 审核时间 | 2026-05-04 13:02 |
| 审核轮次 | 第 1 轮 |
| 变更范围 | 14 个已修改文件 + 4 个新增文件（按 git status） |
| 审核结论 | 不通过 |

### 审核范围
本轮按主上指定重点审核 Phase 1 后端稳定化：并发控制、指数退避重试、原子音频写入、错误响应规范化、`/api/ready`、测试覆盖、执行计划与架构文档对照。未读取真实 API Key 文件，未执行真实 OpenRouter 调用。

### 问题清单

#### Critical（必须修复，阻断发布）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| 无 | -- | 未发现置信度超过 80% 的 Critical 安全漏洞。 | -- |

#### Major（必须修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| M1 | `server/src/utils/audio-fs.ts:123-124`, `server/src/routes/history.ts:221-222`, `server/src/routes/health.ts:96-106` | `writeAudioFile()` 返回的是相对项目根目录的 `data/audio/YYYY/...`，但 `readAudioFile()` 把入参当作相对 audio base dir 解析。默认配置 `audioOutputDir=./data/audio` 下，`/api/audio/{assetId}` 会读取 `data/audio/data/audio/...`，导致生成后的播放/下载失败；`/api/ready` 的 audio round-trip 也会失败并且清理逻辑不会执行，留下 readiness probe 文件。已用 Node 路径推导演示确认默认路径会被解析为双重 `data/audio`。 | 统一文件路径契约。优先让 DB 只存 audio base 相对路径（`YYYY/MM/DD/{jobId}.mp3`），或让 `readAudioFile()` 明确兼容项目根相对路径且仍保持路径穿越校验。`/api/ready` probe 清理应放入 `finally`，且只删除本次 probe 的确定路径。补充默认 `./data/audio` 配置下的 generate -> `/api/audio` 集成测试和 `/api/ready` 不留 probe 的测试。 |
| M2 | `server/src/services/openrouter-provider.ts:149-164`, `171-199`, `220-231` | 请求超时只覆盖 `fetch()` 等待响应头阶段，`clearTimeout(timeoutId)` 在读取 `arrayBuffer()` / `json()` / `text()` 之前执行。若上游返回响应头后 body 长时间不结束，TTS 请求会无限等待，并持有并发 slot；`cleanupStaleSlots()` 也未在运行时定时调用，无法自动兜底释放。 | 将 AbortController 的 deadline 覆盖完整 attempt（包括 body 读取），在 `finally` 中清理 timer。可使用 `AbortSignal.timeout()` 或保留 timer 到 body 消费结束。补充“headers returned but body never closes/超时 abort”的测试，并断言 route 返回 `REQUEST_TIMEOUT` 且 activeJobs 回到 0。 |
| M3 | `server/__tests__/phase1-stabilization.test.ts:332-374`, `600-698`; `server/__tests__/tts-api.test.ts:336-357` | Phase 1 测试存在假通过风险：AudioFS/readiness 测试使用绝对临时 `audioOutputDir`，掩盖默认相对路径下的读写契约错误；429 重试测试只断言调用次数 `>=1`，未验证实际重试次数、Retry-After 延迟、非 retryable 不重试、超时路径和 Authorization 不进入错误 metadata。 | 增加默认相对路径场景测试；Provider 单测使用 fake timers 明确断言 401/400 不重试、429/5xx/network 按期望重试、Retry-After 被尊重且封顶、超时不挂起、响应与 metadata 不包含 `Authorization` 或 API Key。 |

#### Minor（建议修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| m1 | `server/src/routes/tts.ts:57`, `159-164` | 并发拒绝分支返回 `slotResult.requestId`，不是路由入口生成的 `requestId`，同一请求的追踪 ID 语义不一致。 | 复用入口 `requestId`，或字段命名区分 throttle event id。 |
| m2 | `server/src/services/openrouter-provider.ts:51`, `90-124` | `DEFAULT_MAX_RETRIES=3` 实际表示总 attempt 数为 3，而不是“初始请求 + 3 次 retry”。命名和文档容易误解。 | 将字段改为 `maxAttempts`，或循环调整为 1 次初始 + `maxRetries` 次重试，并同步文档和测试。 |
| m3 | 执行计划：`Gemini-OpenRouter-TTS-Web项目后续开发执行计划.md:36,72,361`; 架构规划：`...应用架构规划.md:13,371` | 文档部分段落仍写“并发控制、重试待补/仍是缺口/RetryQueue 待实现”，与 Phase 1 completed 状态冲突。`/api/ready` 也未进入已实现端点表。 | 修正文档状态：并发控制与 provider 内置 retry 已完成但需按本报告修复；若保留 RetryQueue，应说明是未来队列化能力，不是 Phase 1 必需项。 |

### 质量对比结论
| 维度 | 基准状态 | 新状态 | 对比结论 |
|------|---------|--------|---------|
| 代码质量 | 已有后端基线，AudioFS 存取契约原本存在风险 | 增加并发、重试、ready，但默认路径读写链路仍会失败 | 下降（暴露并扩大到 readiness） |
| 测试覆盖率 | 71 项后端测试 | 103 项测试全部通过 | 数量提高，但核心路径存在假通过 |
| 性能指标 | 无并发 slot 观测 | 增加 activeJobs 和拒绝式并发 | 部分提升，但 body hang 会导致 slot 长期占用 |
| 安全风险 | Key 后端隔离、路径校验基线 | metadata 有递归脱敏，未发现新增 Key 明文泄露 | 无明确新增 Critical；路径契约需修复 |

### 安全审计结果
| 发现 | OWASP 分类 | 置信度 | 严重性 | 修复建议 |
|------|-----------|--------|--------|---------|
| 默认路径读写契约错误可能导致音频资产不可用，但未发现可越权读取任意文件的高置信漏洞。 | A01 Broken Access Control / 路径安全相关 | 80% | Major（可用性/一致性） | 统一 DB 路径契约并保留 `path.relative` 边界校验。 |

### 验证命令结果
| 命令 | 目录 | 结果 |
|------|------|------|
| `npm test` | 根目录 | PASS：server vitest 5 files / 103 tests passed，约 12.74s |
| `npm run build` | 根目录 | PASS：Vite production build 成功，约 2.67s |
| `npm run server:build` | 根目录 | PASS：转发到 `npm run build --prefix server`，tsc 成功 |
| `npm run build` | server | PASS：tsc 成功 |
| `npm run typecheck` | server | PASS：tsc --noEmit 成功 |
| `npm test` | server | PASS：5 files / 103 tests passed，约 12.82s |
| 路径推导 `node -e ...` | 根目录 | CONFIRMED：默认 `./data/audio` 下 stored=`data/audio/...` 会解析为 `data/audio/data/audio/...` |

### 文档对照结果
| 文档 | Phase 1 状态 | 门禁与风险状态 | 结论 |
|------|-------------|---------------|------|
| 执行计划 | 顶部与 Phase 1 完成记录标记 completed，真实 OpenRouter smoke 未执行且保留 Phase 4/P0 门禁 | Phase 4 真实 smoke 仍明确未完成；但 1.1/1.4/10 节仍有“并发控制、重试待补强/未完成”的 stale 表述 | 部分准确，需修正文档 stale |
| 架构规划 | Phase 1 稳定化状态标记 completed，真实 OpenRouter smoke 未执行且保留门禁 | 11.2、15 节仍正确保留真实 smoke P0 门禁；但摘要和 RetryQueue 表述与 provider 内置 retry 状态不完全一致 | 部分准确，需修正文档 stale |

### 正向反馈
- 并发 slot acquire/release 基本路径清晰，releaseSlot 幂等，路由 success/provider failure/unexpected catch 路径均显式释放。
- Provider 已区分 retryable 与 non-retryable，429/5xx/network 的基础重试策略和 Retry-After 封顶方向正确。
- 错误响应保留 `status/jobId/error.code/error.message/audioUrl` 等旧字段，同时新增 `ok/requestId/category/retryable`，总体向后兼容。
- `/api/ready` 未调用 OpenRouter，不消耗 Token，且明确返回 `realOpenRouterVerified=false`。

### 建议下一步
审核结论：FAIL。存在 Major 阻塞项，不允许进入下一 Phase。请先修复默认音频路径契约、完整 attempt 超时与对应测试假通过问题，再复跑本报告中的全部验证命令并复审。
