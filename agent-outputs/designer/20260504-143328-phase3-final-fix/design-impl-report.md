# 设计实现报告 -- Phase 3 最终检查修复

## 概要

| 项目 | 内容 |
|------|------|
| 任务 | 修复谛听 Phase 3 最终检查发现的 4 个问题 |
| 变更范围 | 7 个文件（前端 3 + 后端 1 + 测试 1 + 文档 2） |
| 设计方向 | 补齐 directorSnapshot 五要素+speakers 完整性，确保历史快照结构化可追溯 |

---

## 设计决策

1. **directorSnapshot 补齐 transcript + speakers**: 前端 httpAdapter 在构建 directorSnapshot 时，原先只传 audioProfile/scene/directorNotes/sampleContext 四字段。现补齐 transcript（从 req.text 映射）和 speakers（从 req.speakers 映射），确保后端持久化的 JSON 快照包含完整的六要素。
2. **后端 Zod schema 扩展 speakers**: 在 GenerateSchema 的 directorSnapshot 中新增 `speakers` 字段（可选数组），与前端发送结构对齐。Zod 默认 `.strip()` 行为保证向后兼容。
3. **HistoryDetailPage 展示补齐 sampleContext + speakers**: 接口类型补齐 sampleContext 和 speakers 字段；渲染区新增 `<sample_context>` 和 `<speakers>` 段落；重新生成时传递 speakers 参数。
4. **文档清理**: 删除执行计划末尾重复的 stale section 10/11，保留已有的 updated 版本，消除前后矛盾。

---

## 代码变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `server/src/routes/tts.ts` | 修改 | GenerateSchema.directorSnapshot 新增 speakers 数组定义 |
| `src/app/services/httpAdapter.ts` | 修改 | generateSpeech 中 directorSnapshot 补齐 transcript + speakers；优化触发条件检查 |
| `src/app/pages/HistoryDetailPage.tsx` | 修改 | 接口补齐 sampleContext + speakers；Director Prompt 渲染补齐 sampleContext + speakers 展示；handleRegenerate 补齐 speakers 传递 |
| `server/__tests__/tts-api.test.ts` | 修改 | 新增 3 个测试：speakers 持久化、transcript-only 持久化、GET /api/jobs/:jobId speakers 可检索 |
| `Gemini-OpenRouter-TTS-Web项目后续开发执行计划.md` | 修改 | 删除 397-412 行重复 stale section 10/11 |

---

## 自测报告

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 前端构建 | PASS | `npm run build` 成功，无报错 |
| 后端构建 | PASS | `npm run server:build` (tsc) 成功，无报错 |
| 后端类型检查 | PASS | `npm run typecheck` (tsc --noEmit) 成功 |
| 测试套件 | PASS | 6 test files, 160 tests passed (含 3 个新增测试) |
| 文档一致性 | PASS | 执行计划文档无重复段落，section 10/11 内容与实际状态一致 |

---

## 测试新增明细

| 测试名 | 验证内容 |
|--------|---------|
| `persists speakers in directorSnapshot` | 完整五要素 + 2 speakers 持久化到 DB |
| `persists directorSnapshot with transcript but no speakers` | transcript 持久化，speakers 字段可选 |
| `directorSnapshot speakers are retrievable via GET /api/jobs/:jobId` | 通过 job detail API 检索 speakers |

---

## 遗留项

| 编号 | 描述 | 严重程度 | 说明 |
|------|------|---------|------|
| - | 无遗留阻塞项 | - | 本次修复全部闭环，所有测试通过 |

---

## 建议下一步

谛听（reviewer）审核本次变更，确认 directorSnapshot 完整性和历史展示修复。
