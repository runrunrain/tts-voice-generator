## 审核报告

### 审核概要
| 项目 | 内容 |
|------|------|
| 审核时间 | 2026-05-04 21:58:12 |
| 审核轮次 | 复审 |
| 变更范围 | 1 个直接变更文件：src/app/services/httpAdapter.ts；另检查生成结果、历史列表、历史详情、下载相关前端链路 |
| 审核结论 | 不通过 |

### 复审结论
- `src/app/services/httpAdapter.ts` 的成功分支已把 `GenerateResult.format` 从 `req.format` 改为 `resolveActualFormat(result.outputFormat, result.contentType, req.format)`；因此当 legacy mp3 请求收到后端 `outputFormat="wav"` 时，当前生成结果会显示为 `wav`，RightPanel 下载文件名 `${jobId}.${generateResult.format}` 也会随之变为 `.wav`。
- `contentType="audio/wav"` 时兜底映射会命中 `contentType.includes("wav")`，不会继续回退为请求的 `mp3`。
- 但历史列表、右侧历史预览、历史详情仍存在使用请求格式展示成功资产格式的位置；后端 `/api/history` 已返回 `assetFormat`，前端映射却仍把 `format` 设为 `job.responseFormat`。因此“其他前端位置用请求格式伪装成功资产格式”的风险仍未关闭。
- 本轮未读取 API key/secret，未设置真实 key；未发起真实 OpenRouter 请求。

### 问题清单

#### Critical（必须修复，阻断发布）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| 无 | - | 未发现 Critical 问题 | - |

#### Major（必须修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| M1 | `src/app/services/httpAdapter.ts:339`; `server/src/routes/history.ts:105,117`; `src/app/pages/HistoryPage.tsx:269`; `src/app/components/RightPanel.tsx:628`; `src/app/pages/HistoryDetailPage.tsx:224,291` | 历史链路仍可能把请求格式显示为成功资产格式。后端历史列表 `format` 是 `job.responseFormat`，同时提供实际资产 `assetFormat`；但前端 `HistoryRecord.format` 仍使用 `r.format`，历史列表和右侧预览显示 `record.format`。历史详情下载按钮和参数快照仍显示 `job.responseFormat`，即 legacy `mp3` 请求实际产出 WAV 时，历史 UI 仍可显示 MP3。 | 历史列表映射应对成功且存在资产的记录优先使用 `r.assetFormat`，例如 `format: (r.assetFormat || r.format) as AudioFormat`，并在 UI 中明确区分“请求格式”和“实际文件格式”（如确需展示请求参数）。历史详情应基于 `audio.mimeType` 或 `audio.fileName` 推断/展示实际文件格式，下载按钮文案使用实际格式；参数快照可保留 `responseFormat` 但应标注为“请求格式”。 |
| M2 | `server/__tests__/data-consistency.test.ts:388`; `server/src/routes/tts.ts:336` | 复审运行 `npm run server:test` 未通过：`network error creates no audio_asset` 超时，且 stderr 出现 `TypeError: The database connection is not open`，说明自动化质量门禁当前无法稳定通过。 | 稳定网络错误路径测试和路由异步清理逻辑，确保网络错误时不会在测试 teardown 后继续访问已关闭 DB；修复后重新运行完整 server 测试并通过。 |

#### Minor（建议修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| m1 | `src/app/services/httpAdapter.ts:76-80` | `Content-Type` 兜底判断是大小写敏感的，且未覆盖 `audio/mp3`。当前后端常量 `audio/wav` 可以命中，不影响本轮主路径，但 MIME type 按规范大小写不敏感。 | 先 `const normalized = contentType.toLowerCase()`，再匹配 `wav/wave/x-wav`、`pcm`、`mpeg/mp3`，提高兼容性。 |

### 质量对比结论
| 维度 | 基准状态 | 新状态 | 对比结论 |
|------|---------|--------|---------|
| 代码质量 | 成功结果格式直接使用请求格式，存在伪装风险 | 即时生成结果已改为使用实际格式；历史链路仍残留请求格式展示 | 部分提升，但未完全关闭 |
| 测试覆盖率 | 上游报告称前端 build、server typecheck/build/tests 通过 | 本轮前端 build、server typecheck 通过；server:test 失败 1 项 | 下降/验证未通过 |
| 性能指标 | 无相关变更 | 无新增性能风险 | 维持 |
| 安全风险 | 要求不读取密钥、不发真实请求 | 未读取密钥，未设置真实 key；server real OpenRouter smoke 1 skipped | 无新增 |

### 安全审计结果（如有发现）
| 发现 | OWASP 分类 | 置信度 | 严重性 | 修复建议 |
|------|-----------|--------|--------|---------|
| 未发现新增安全问题 | - | - | - | - |

### 验证记录
| 命令 | 结果 | 说明 |
|------|------|------|
| `npm run build` | PASS | Vite production build 成功，1622 modules transformed |
| `npm run typecheck`（server 目录） | PASS | TypeScript `tsc --noEmit` 成功 |
| `npm run server:test` | FAIL | 8 files passed / 1 failed；208 passed / 1 failed / 1 skipped；失败项为 `Data Consistency: failed jobs do NOT create audio assets > network error creates no audio_asset` 超时 |

### 正向反馈
- 即时生成成功结果的核心修复方向正确：优先后端 `outputFormat`，再用 `contentType` 推断，最后才回退请求格式。
- RightPanel 成功态下载文件名使用 `generateResult.format`，因此主生成路径的 `.wav` 扩展名联动已成立。
- 未发现本轮修改引入读取密钥或真实 OpenRouter 调用的代码路径。

### 建议下一步
不通过。请继续修复历史链路的实际资产格式展示，以及当前失败的自动化测试门禁；修复完成后再发起下一轮复审。
