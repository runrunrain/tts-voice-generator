## 审核报告

### 审核概要
| 项目 | 内容 |
|------|------|
| 审核时间 | 2026-05-04 12:30 |
| 审核轮次 | Phase 0 修复审核第 1 轮 |
| 变更范围 | 10 个业务/测试文件 + 2 个外部规划文档对照 |
| 审核结论 | 通过 |

### 审核范围

- 代码变更：`package.json`、`server/src/utils/voice.ts`、`server/src/routes/settings.ts`、`server/src/routes/tts.ts`、`server/src/routes/voices.ts`、`server/__tests__/smoke-preflight.test.ts`、`src/app/pages/GeneratePage.tsx`、`src/app/pages/DirectorPage.tsx`、`src/app/pages/VoicesPage.tsx`、`src/app/services/demoAdapter.ts`。
- 文档对照：执行计划与架构规划两份文档的 Phase 0 状态、真实 OpenRouter smoke 状态。
- 禁止项遵守：未读取 `.env` 或真实 API Key 文件；未修改业务代码。

### 问题清单

#### Critical（必须修复，阻断发布）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| 无 | - | 未发现 Critical 问题 | - |

#### Major（必须修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| 无 | - | 未发现 Major 问题 | - |

#### Minor（建议修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| m-01 | `Gemini-OpenRouter-TTS-Web项目后续开发执行计划.md:5`, `:92-93` | 执行计划顶部仍写“Phase 0 补验：partial”，MVP 范围表仍写 defaultVoice “需全项目复核”、alloy “待补明确映射”，与后文第二轮修复记录和当前代码状态不完全一致。 | 将顶部状态和 MVP 范围表同步为“Phase 0 代码修复与 smoke 前置 completed；真实 OpenRouter smoke 未执行，仍为 Phase 4/MVP 门禁”。 |
| m-02 | `server/src/routes/settings.ts:68-79` | `GET /api/settings` 对已存在的旧 DB 行不做输出归一化；若历史 settings.default_voice 已是 `alloy`，首次读取仍会返回 `alloy`。当前 PUT、TTS、probe 已能归一化，因此不阻塞 Phase 1，但未完全覆盖旧配置迁移体验。 | 在 GET 输出层或启动迁移中对 settings.defaultVoice 执行 `canonicalizeVoice()`，必要时回写 DB；保留历史 job 查询原始 voice 不做破坏性迁移。 |
| m-03 | `src/app/pages/HistoryPage.tsx:117` | History 过滤器仍硬编码旧音色 `alloy`，这是历史兼容入口而非新 fallback 默认；不影响本次 Phase 0 主修复，但容易和新默认基线混淆。 | 仅当历史数据存在 legacy voice 时展示 `alloy (legacy)`，或改为从后端历史聚合/voice catalog 动态生成过滤项。 |

### 质量对比结论
| 维度 | 基准状态 | 新状态 | 对比结论 |
|------|---------|--------|---------|
| 代码质量 | defaultVoice/alloy 处理分散，前端多处 fallback 旧音色 | 新增 `server/src/utils/voice.ts`，settings PUT、TTS、voices probe 统一 canonical voice；前端新 fallback 改为 Gemini 音色 | 提升 |
| 测试覆盖率 | 44 项后端测试，缺少 smoke preflight | 71 项后端测试通过，新增 27 项 preflight 检查 | 提高 |
| 性能指标 | 无直接性能基线变化 | 仅常量映射与测试脚本，无运行时显著开销 | 维持 |
| 安全风险 | Key 加密/脱敏已有基线，真实 smoke 未执行 | preflight 不调用真实 OpenRouter，不消耗 Token；未发现 Key 硬编码或输出 | 无新增 |

### 安全审计结果
| 发现 | OWASP 分类 | 置信度 | 严重性 | 修复建议 |
|------|-----------|--------|--------|---------|
| 未发现真实 API Key 读取、输出、硬编码 | 敏感数据暴露 | >90% | 无 | 保持禁止读取 `.env`/真实 Key 文件；真实 smoke 必须单独显式执行并产出脱敏报告。 |
| `server/__tests__/smoke-preflight.test.ts` 不触发真实 OpenRouter 请求 | 成本/外部服务滥用控制 | >90% | 无 | 保持 `realApiCallMade=false`，真实调用仅在单独 smoke 阶段执行。 |

### 正确性核查

- `server/src/utils/voice.ts`：`alloy`/`Alloy` 映射为 `Zephyr`，`Zephyr` 与其他 Gemini 音色透传。
- `server/src/routes/settings.ts`：PUT 保存 `defaultVoice` 前执行 `canonicalizeVoice()`，新配置写入不再保存 `alloy`。
- `server/src/routes/tts.ts`：缺 Key、文本过长、running job、provider 调用均使用 `canonicalVoice`，OpenRouter 请求不再收到 legacy `alloy`。
- `server/src/routes/voices.ts`：probe 调 provider 和更新 DB 均使用 `canonicalName`。
- 前端 Generate/Director/Voices/demo fallback 已改为 `Zephyr` 系音色；未发现新生成默认 fallback 为 `alloy`。
- 兼容性：API 响应结构未做破坏性变更；历史记录查询不被迁移破坏；`alloy` 作为输入仍兼容到 canonical voice。

### 验证命令结果
| 命令 | 工作目录 | 结果 |
|------|----------|------|
| `npm test` | `D:/workpace-maorun/tts-voice-generator` | PASS，4 个 test files，71 tests passed |
| `npm run build` | `D:/workpace-maorun/tts-voice-generator` | PASS，Vite production build 成功 |
| `npm run server:build` | `D:/workpace-maorun/tts-voice-generator` | PASS，根脚本成功委托 `npm run build --prefix server` |
| `npm run build` | `D:/workpace-maorun/tts-voice-generator/server` | PASS，`tsc` 成功 |
| `npm run typecheck` | `D:/workpace-maorun/tts-voice-generator/server` | PASS，`tsc --noEmit` 成功 |
| `npm test` | `D:/workpace-maorun/tts-voice-generator/server` | PASS，4 个 test files，71 tests passed |

### 文档对照结论

- 架构规划文档：准确标注 Phase 0 代码修复已完成，同时明确真实 OpenRouter API smoke test 尚未执行，符合要求。
- 执行计划文档：主体 Phase 路线图、Phase 0 第二轮修复记录、MVP 门禁均正确保留“真实 OpenRouter smoke 未执行”；但顶部和 MVP 范围表有少量 stale 状态，列为 Minor 文档修正。
- 真实 OpenRouter smoke test：仍应保持“未执行/Phase 4 MVP/P0 门禁”，不得标为通过。

### 正向反馈

Phase 0 修复方向正确：把 alias 规则集中到 `voice.ts`，避免在页面和路由中散落分支；新增 preflight 测试覆盖 Key 脱敏、DB、音频目录、后端 API 与 voice canonicalization，并明确不做真实 API 调用，符合安全和成本控制要求。根目录 `server:build` 修复后门禁可复跑。

### 建议下一步

结论 PASS。允许进入 Phase 1。进入 Phase 1 前建议修正执行计划中的 Minor 文档状态不一致；真实 OpenRouter smoke 仍保持未执行，不作为 Phase 0 已通过项，只能在后续显式 smoke 阶段验证。