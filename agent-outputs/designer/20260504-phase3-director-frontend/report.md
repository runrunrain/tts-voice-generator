# Phase 3 Director MVP 前端闭环 -- 设计实现报告

## 概要

| 项目 | 内容 |
|------|------|
| 任务 | Phase 3 Director MVP 前端闭环：类型对齐、httpAdapter 扩展、AppContext 状态管理、DirectorPage 两步流程重构、RightPanel 更新 |
| 变更范围 | 5 个文件修改 + 2 个文档回填 |
| 设计方向 | 保持现有暗色终端主题，Director 页面从单步直连改为两步状态机（edit -> preview -> confirm），组装与生成分离 |

## 设计决策

1. **两步流程（核心）**：Director 操作拆分为「组装提示词」（调用 `/api/prompts/assemble`，不消耗 Token）和「确认并生成语音」（调用 `/api/tts/generate`，消耗额度）。用户在预览步骤可以看到后端返回的 prompt、warnings 和 normalized speakers 后再决定是否生成。

2. **类型层与后端契约严格对齐**：新增 `AssemblePromptRequest` 映射后端 Zod schema（`audioProfile/scene/directorNotes/sampleContext/transcript/speakers`），`AssemblePromptResponse` 使用联合类型区分 success（`ok: true` + prompt/warnings/normalized）和 error（`ok: false` + error.code/message/category/retryable）。不使用预案中的 `assembledPrompt/tokenEstimate` 字段。

3. **Speaker 限制 MVP 限制 MAX_SPEAKERS=2**：添加 Speaker 按钮在达到上限后禁用，同时显示黄色警告 banner（`"MVP 阶段最多支持 2 位说话者"`）。不静默截断到 2 后隐藏用户输入。

4. **API Key 门禁**：preview 步骤中检测 `settings.openRouterApiKey`，未配置时显示全屏半透明遮罩 + 明确提示（"生成语音需要调用 OpenRouter API，请先在设置页面配置 API Key"），不发起生成请求。组装步骤不受 Key 状态影响。

5. **RightPanel 从 sessionStorage 轮询改为 Context 驱动**：DirectorPreview 不再通过 `setInterval` 轮询 `sessionStorage.getItem("director-prompt")`，改为读取 AppContext 的 `assembleResult`，展示 idle/loading/error/success 四态。

## 代码变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/app/types/index.ts` | 修改 | 新增 AssembleSpeakerInput、AssemblePromptRequest、PromptWarning、NormalizedSpeaker、AssemblePromptSuccess、AssemblePromptError、AssemblePromptResponse、AssemblePhase、AssembleResult 共 9 个类型；TtsServiceAdapter 接口新增可选 `assemblePrompt()` 方法 |
| `src/app/services/httpAdapter.ts` | 修改 | import 新增 AssemblePromptRequest/Response；新增 `assemblePrompt()` 方法调用 POST `/api/prompts/assemble` |
| `src/app/state/AppContext.tsx` | 修改 | import 新增 Assemble 类型；AppState 新增 assembleResult/assemblePhase/assemblePrompt/resetAssemble；Provider 新增 assemble 状态管理逻辑；context value 新增 4 个 assemble 字段 |
| `src/app/pages/DirectorPage.tsx` | 重写 | 从单步直连改为三步状态机（edit/preview/confirm）；MAX_SPEAKERS=2 限制+警告；assemble 调用后端；preview 展示 prompt/warnings/normalized；API Key 门禁遮罩；生成使用 assembled prompt |
| `src/app/components/RightPanel.tsx` | 修改 | DirectorPreview 从 sessionStorage 轮询改为读取 AppContext assembleResult；import 新增 CheckCircle2；展示 idle/loading/error/success 四态 |

### 文档回填

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `Gemini-OpenRouter-TTS-Web应用架构规划.md` | 修改 | 更新 Phase 3 后端状态表（前端对接标记 completed）；新增 Section 21 Phase 3 前端状态表 |
| `Gemini-OpenRouter-TTS-Web项目后续开发执行计划.md` | 修改 | 版本升至 1.5；Phase 路线图 Phase 3 状态更新；Phase 3 任务表增加状态列和前端实现记录；已实现端点表新增 assemble；未完成事项更新；建议下一步更新 |

## 与后端契约对齐说明

| 后端契约 | 前端实现 | 对齐状态 |
|---------|---------|---------|
| Request: `audioProfile?: string` | `AssemblePromptRequest.audioProfile?: string` | 完全对齐 |
| Request: `scene?: string` | `AssemblePromptRequest.scene?: string` | 完全对齐 |
| Request: `directorNotes?: string` | `AssemblePromptRequest.directorNotes?: string` | 完全对齐 |
| Request: `sampleContext?: string` | `AssemblePromptRequest.sampleContext?: string` | 完全对齐 |
| Request: `transcript: string` | `AssemblePromptRequest.transcript: string` | 完全对齐 |
| Request: `speakers?: Array<{id, label, name?, voice?, style?}>` | `AssembleSpeakerInput` 完全映射 | 完全对齐 |
| Response 200: `{ ok: true, requestId, prompt, warnings, normalized }` | `AssemblePromptSuccess` | 完全对齐 |
| Response 400: `DIRECTOR_SPEAKER_LIMIT_EXCEEDED` | 前端 MAX_SPEAKERS=2 限制 + 后端返回时展示错误 | 完全对齐 |
| Response 400: `VALIDATION_ERROR` | 前端在 assemble 失败时展示错误 code+message | 完全对齐 |
| warnings: `PromptWarning[]`（code, message, field） | 前端展示每条 warning，区分 LEGACY_VOICE_ALIAS（黄色）和 SUGGEST_*（金色） | 完全对齐 |
| normalized.speakers: `wasLegacyAlias` | preview 步骤展示 "legacy alias 已映射" 标签 | 完全对齐 |
| POST `/api/tts/generate` input 字段 | DirectorPage 使用 assembled prompt 作为 `text` 参数传入 `generate({text: assembledPrompt})`，httpAdapter 映射为 `input` | 完全对齐 |
| POST `/api/tts/generate` directorSnapshot | httpAdapter.generateSpeech 已有将 audioProfile/scene/directorNotes 传入 directorSnapshot 的逻辑 | 完全对齐 |

**后端契约与文档不一致说明**：未发现不一致。后端实际实现与架构规划文档中的契约完全匹配。`PromptWarning` 结构为 `{code, message, field?}`，`NormalizedSpeaker` 包含 `wasLegacyAlias` 标记，均已在后端 `prompt-assembly.ts` 中确认。

## 自测报告

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 构建通过 | PASS | 前端 `npm run build` 通过（1622 modules, 0 error, 1.87s） |
| 全 7 态覆盖 | PASS | DirectorPage: edit(idle)/assemble-loading/preview(success)/assemble-error/generate-loading/generate-success/generate-error |
| 视觉一致性 | PASS | 保持现有暗色终端主题（bg-bg-base/bg-bg-sunken/bg-bg-surface），accent 色用于组装按钮和关键词高亮 |
| 反 AI 垃圾 | PASS | 使用项目已有设计系统变量，未引入渐变/Inter/千篇一律卡片 |
| 交互真实 | PASS | assemble 调用真实后端 API，generate 使用现有 httpAdapter.generateSpeech |
| 响应式 | N/A | 按要求不做移动端 |
| 无障碍 | PASS | 使用原生 HTML 元素（button/select/textarea），颜色对比度符合暗色主题标准 |
| 行动兑现 | PASS | 说了"两步流程" -> 实现了 edit->preview->confirm 三步状态机 |
| 交接标注 | PASS | 报告标注"建议下一步：谛听（reviewer）审核" |

### 验证命令与结果

| 命令 | 结果 |
|------|------|
| `npm run build` | PASS（0 error） |
| `npm run server:build` | PASS（tsc 通过） |
| `npm test`（server 154 项测试） | PASS（154/154） |

## 遗留风险

| 风险 | 等级 | 说明 |
|------|------|------|
| 真实 OpenRouter smoke 未执行 | P0 | Phase 4 门禁。前端 Director 两步闭环已实现但未在真实 API 环境中验证生成步骤。组装步骤已通过后端 36 项测试覆盖。 |
| 浏览器 E2E 未执行 | P0 | Phase 4 门禁。Director 页面交互流程（组装->预览->确认->生成）需要浏览器自动化验证。 |
| Director 历史快照展示 | P2 | 后端 TTS route 的 `directorSnapshot` 字段已支持保存。HistoryDetail 页面展示 directorSnapshot 数据未在本次修改范围内，属于 Phase 2 前端四态验证的范畴。 |
| 旧 sessionStorage 残留 | 低 | 旧版 DirectorPage 在 sessionStorage 写入 `director-prompt`。新版本不使用 sessionStorage，但已有数据不会自动清除，不影响功能。 |

## 建议下一步

- 谛听（reviewer）审核前端代码变更和类型对齐
- Phase 2 前端四态真实 API 验证（6 页面真实后端交互）
- Phase 4 真实 OpenRouter smoke（MVP 验收门禁）
