## 审核报告

### 审核概要
| 项目 | 内容 |
|------|------|
| 审核时间 | 2026-05-04 13:25 |
| 审核轮次 | 第 2 轮（Phase 1 修复后最终复审） |
| 变更范围 | 后端 Phase 1 稳定化修复、测试、计划/架构文档回填 |
| 审核结论 | 有条件通过（PASS；仅剩文档 Minor） |

### 审核范围
本轮按主上指定重点复审上轮 Major：AudioFS 路径契约、`/api/audio/{assetId}` 默认路径 round-trip、Provider timeout 覆盖 body 读取、并发 slot 释放、重试严格性、错误 metadata 脱敏、Phase 1 文档状态。未读取真实 API Key 文件，未执行真实 OpenRouter 调用。

### 问题清单

#### Critical（必须修复，阻断发布）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| 无 | -- | 未发现置信度超过 80% 的 Critical 安全漏洞。 | -- |

#### Major（必须修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| 无 | -- | 上轮 3 个 Major 阻塞项均已修复并通过本轮验证。 | -- |

#### Minor（建议修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| m1 | `D:/workpace-maorun/Database/AI技术/AI语音生成工具/Gemini-OpenRouter-TTS-Web项目后续开发执行计划.md:37,73,201,362`; `D:/workpace-maorun/Database/AI技术/AI语音生成工具/Gemini-OpenRouter-TTS-Web应用架构规划.md:13,88,371,448` | 文档主体已将 Phase 1 标记为 completed，并正确保留真实 OpenRouter smoke 未执行门禁；但少量旧段落仍写“需补重试、超时”“并发控制、重试未完成”或 `maxRetries=3`，与当前 `maxAttempts` 和已完成状态不一致。 | 提交前做一次全文状态清理：将 provider 内置重试/超时/并发控制标记为 Phase 1 completed；若保留 `RetryQueue`，明确它是未来队列化能力，不是当前 provider retry 缺口；将 `maxRetries` 旧词统一为 `maxAttempts`。 |

### 质量对比结论
| 维度 | 基准状态 | 新状态 | 对比结论 |
|------|---------|--------|---------|
| 代码质量 | 上轮默认 AudioFS 路径会产生 `data/audio/data/audio`，Provider body hang 可能占用 slot | AudioFS 改为 audio-base-relative；Provider timeout 覆盖 headers+body；route-level requestId 统一 | 提升 |
| 测试覆盖率 | 5 files / 103 tests passed，但核心路径测试存在假通过风险 | 5 files / 118 tests passed，新增路径契约、重试严格性、body hang timeout、metadata 脱敏、slot 释放测试 | 提高 |
| 性能指标 | body hang 可长期占用并发 slot | Provider timeout 后返回 `REQUEST_TIMEOUT`，route failure/catch 路径释放 slot | 提升 |
| 安全风险 | 路径契约错误影响资产可用性；metadata 脱敏覆盖不足 | 路径穿越校验保留；metadata 中 authorization/api_key/token 等敏感键递归脱敏 | 无新增高置信安全风险 |

### 安全审计结果
| 发现 | OWASP 分类 | 置信度 | 严重性 | 修复建议 |
|------|-----------|--------|--------|---------|
| 未发现生产代码硬编码真实 API Key；本轮未读取 `.env` 或真实 Key 文件。测试中的 `sk-test-*` 为测试假值。 | A02 Sensitive Data Exposure | >90% | 无 | 保持真实 smoke 单独执行并产出脱敏报告。 |
| `/api/audio/{assetId}` 仍通过 DB assetId 定位并由 `readAudioFile()` 做 base-dir 边界校验，未发现任意路径读取高置信漏洞。 | A01 Broken Access Control | >85% | 无 | 保持 DB 存储 audio-base-relative，禁止外部传路径。 |

### 验证命令结果
| 命令 | 目录 | 结果 |
|------|------|------|
| `npm test` | 根目录 | PASS：server vitest 5 files / 118 tests passed，约 22.91s |
| `npm run build` | 根目录 | PASS：Vite production build 成功，1622 modules transformed，约 2.47s |
| `npm run server:build` | 根目录 | PASS：转发到 `npm run build --prefix server`，tsc 成功 |
| `npm run build` | `server` | PASS：tsc 成功 |
| `npm run typecheck` | `server` | PASS：tsc --noEmit 成功 |
| `npm test` | `server` | PASS：server vitest 5 files / 118 tests passed，约 20.13s |

### 复审要点结论
| 要点 | 证据 | 结论 |
|------|------|------|
| `/api/audio/{assetId}` 默认路径 round-trip | `writeAudioFile()` 返回 `path.relative(getAudioBaseDir(), finalPath)`；`readAudioFile()` 以 `getAudioBaseDir()` 解析；测试覆盖 `YYYY/MM/DD/jobId.ext`、round-trip、磁盘路径 | 通过，不再产生 `data/audio/data/audio` |
| `writeAudioFile/readAudioFile/scanOrphanFiles/readiness` 路径契约 | `audio-fs.ts` 写、读、孤儿扫描均以 audio base 为边界；`health.ts` readiness 用返回的 relPath 读回并按 baseDir 清理 | 通过 |
| Provider timeout 覆盖 body 读取 | `openrouter-provider.ts` 将 timer clear 放入 body 读取后的 `finally`；新增 body hang AbortError 测试 | 通过 |
| 失败时并发 slot 释放 | `tts.ts` provider failure 和 catch 均 releaseSlot；新增 network/429/timeout slot 释放断言 | 通过 |
| 重试次数、Retry-After、non-retryable | `maxAttempts` 语义清晰；401/400 单次返回；429/500/network 精确重试到 maxAttempts；Retry-After 秒值被使用并封顶 | 通过 |
| 错误 metadata 脱敏 | `sanitizeErrorMetadata()` 递归替换 authorization/api_key/token 等敏感键；测试断言响应不含伪 Key/token | 通过 |
| 文档回填 | Phase 1 completed 和真实 smoke Phase 4/P0 门禁已在顶部、路线图、Phase 1 状态表中成立；仍有少量旧词/旧状态段落 | 有 Minor，非发布阻断 |

### 文档对照结果
| 文档 | Phase 1 状态 | 真实 OpenRouter smoke 状态 | 结论 |
|------|-------------|---------------------------|------|
| 执行计划 | 顶部、路线图、Phase 1 任务表、Phase 1 完成记录均标记 completed | 明确“未完成，MVP/P0/Phase 4 门禁” | 主结论准确；少量旧段落需清理 |
| 架构规划 | 重要状态、服务层表、Phase 1 状态表均说明稳定化 completed | 11.2、15、19 节均保留未执行门禁 | 主结论准确；少量旧段落需清理 |

### 正向反馈
- 上轮最关键的 AudioFS 双重 `data/audio` 问题已从存储契约层修复，而不是在读取端临时兼容，方向正确。
- Provider timeout 修复覆盖完整 attempt，新增 body hang 测试能防止回归。
- 并发 slot 释放测试覆盖 network、429、timeout 多类失败路径，降低成本型阻塞风险。
- 文档没有把真实 OpenRouter smoke 写成已通过，Phase 4/P0 门禁仍保留。

### 建议下一步
PASS。允许进入下一 Phase。进入下一 Phase 前或提交前建议清理上述文档 Minor；真实 OpenRouter smoke 仍未执行，必须继续保留为 Phase 4/MVP/P0 门禁，不能作为 Phase 1 已验收项。
