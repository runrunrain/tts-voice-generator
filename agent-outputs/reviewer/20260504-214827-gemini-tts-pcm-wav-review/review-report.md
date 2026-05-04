## 审核报告

### 审核概要
| 项目 | 内容 |
|------|------|
| 审核时间 | 2026-05-04 |
| 审核轮次 | 第 1 轮 |
| 变更范围 | 18 个已跟踪文件 + 新增 audio-format/security/data-consistency/smoke 测试 |
| 审核结论 | 不通过：存在 1 个 Major；后端 PCM/WAV 核心链路验证通过，但前端 legacy mp3 成功结果仍可能伪装为 mp3 |

### 问题清单

#### Critical（必须修复，阻断发布）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| 无 | - | 未发现 Critical 问题 | - |

#### Major（必须修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| M1 | `src/app/services/httpAdapter.ts:108-138`、`src/app/components/RightPanel.tsx:288-293` | 后端成功响应已返回 `outputFormat`，但前端 `httpAdapter.generateSpeech()` 仍把 `GenerateResult.format` 固定为请求值 `req.format`。legacy 调用传 `mp3` 时，后端实际输出 `audio/wav` 和 `.wav` 资产，右侧面板却会显示 `mp3`，下载按钮也会设置 `download="{jobId}.mp3"`，导致 WAV 内容被保存成 mp3 扩展名。 | 将 `/api/tts/generate` 成功响应类型补充 `outputFormat?: AudioFormat`、`contentType?: string`，成功映射时使用 `format: result.outputFormat ?? req.format`。补充适配器测试：请求 `format: "mp3"` 时 mock 后端返回 `outputFormat: "wav"`，断言 GenerateResult/UI 下载扩展名均为 `wav`。 |

#### Minor（建议修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| m1 | `server/src/utils/audio-format.ts:121-157`、`server/__tests__/tts-api.test.ts:501-508` | 测试验证了 RIFF/WAVE 与数据拼接，但未直接断言 WAV header 的 chunk size、fmt size、sampleRate=24000、channels=1、bitDepth=16、data size 等关键字段。实现本身看起来正确。 | 增加 `audio-format` 单元测试，使用固定 PCM Buffer 断言 offset 4/16/20/22/24/28/32/34/40 等字段。 |
| m2 | `server/src/services/openrouter-provider.ts:20-26`、`:139-141` | 底层 Provider 类型仍允许 `responseFormat: "wav"` 且会原样发送给 OpenRouter。当前路由层已规避，但 Provider 公共接口存在误用空间。 | 将 Provider 入参收紧为上游格式 `"mp3" | "pcm"`，或在 Provider 内拒绝/转换 `wav`。 |

### 质量对比结论
| 维度 | 基准状态 | 新状态 | 对比结论 |
|------|---------|--------|---------|
| 代码质量 | Gemini TTS 曾可能向上游请求 mp3 | 后端统一 Gemini 上游 pcm，本地 wav 封装；前端 legacy 展示仍有缺口 | 部分提升，但存在 Major |
| 测试覆盖率 | 无完整 PCM/WAV 回归 | 209 passed/1 skipped，覆盖 wav 成功、资产一致性、安全脱敏、无 key smoke 阻塞 | 提高 |
| 性能指标 | 无明显基准 | WAV 封装为 Buffer.concat，一次性内存开销可接受 | 维持 |
| 安全风险 | 已有 key 存储/脱敏要求 | 新增递归脱敏与错误出口脱敏测试，未发现新增高置信安全漏洞 | 无新增 |

### 安全审计结果（如有发现）
| 发现 | OWASP 分类 | 置信度 | 严重性 | 修复建议 |
|------|-----------|--------|--------|---------|
| 未发现需报告的高置信 OWASP Top10 安全问题 | - | - | - | - |

### 验证记录
| 命令 | 结果 |
|------|------|
| `$env:OPENROUTER_API_KEY=''; npm run typecheck --prefix server` | PASS |
| `$env:OPENROUTER_API_KEY=''; npm run build --prefix server` | PASS |
| `$env:OPENROUTER_API_KEY=''; npm test --prefix server` | PASS：9 files passed，209 passed / 1 skipped；真实 OpenRouter smoke 因无 key 跳过真实调用并写 blocked 报告 |
| `$env:OPENROUTER_API_KEY=''; npm run build` | PASS |

### 正向反馈
- `resolveTtsFormat()` 对 Gemini TTS 的上游 `pcm`、输出 `wav/pcm` 分离清晰，legacy `mp3` 在后端会落到实际 `wav`。
- `wrapPcm16LeToWav()` 使用 24kHz、16-bit、mono，header 结构与官方 PCM 参数一致。
- `tts` 路由在 DB job、audio_asset、文件扩展名、MIME、hash、sizeBytes 上记录的是实际输出 Buffer，后端未发现把成功 WAV 资产伪装成 mp3 的问题。
- settings/voices 默认值已从 mp3 改为 wav，probe 上游使用 pcm，错误脱敏有测试覆盖。

### 建议下一步
打回修复 M1 后复审。非代码阻塞：真实 OpenRouter key 的 e2e smoke 仍需在主流程中显式执行，本轮按要求未读取密钥文件、未发真实 OpenRouter 请求。
