# 设计实现报告 -- Phase 3 谛听轻量审核修复

## 概要

| 项目 | 内容 |
|------|------|
| 任务 | 修复 Phase 3 轻量审核发现的两个 Major 阻塞 |
| 变更范围 | 3 个文件 |
| 设计方向 | 补齐 Gemini TTS 五要素 Sample Context UI；修复 assemblePrompt 错误码透传 |

## Major 1: DirectorPage 缺少 Sample Context 编辑/提交入口

### 问题
后端 PromptAssemblyService 按 Gemini TTS 五要素设计：Audio Profile / Scene / Director's Notes / **Sample Context** / Transcript。类型定义 `AssemblePromptRequest` 和后端 Zod schema 均包含 `sampleContext` 字段。但 `DirectorPage.tsx` 的 edit 步骤只渲染了四个 Section，缺少 Sample Context 的输入区域，提交到 assemblePrompt 的 request 也不包含该字段，preview 步骤未展示 normalized 后的 sampleContext 值。

### 修复内容

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/app/pages/DirectorPage.tsx` | 修改 | 新增 `sampleContext` state 变量；edit 步骤在 Director's Notes 和 Transcript 之间新增 Sample Context Section（含 placeholder 提示背景信息/角色背景/世界观细节等）；`handleAssemble` 请求体增加 `sampleContext` 字段；`handleGenerate` 的 directorSnapshot 增加 `sampleContext` 字段；preview 步骤新增「五要素概要」展示区，列出所有五个 normalized 元素（Audio Profile / Scene / Director's Notes / Sample Context / Transcript） |
| `src/app/types/index.ts` | 修改 | `GenerateRequest` 接口新增 `sampleContext?: string` 可选字段 |
| `src/app/services/httpAdapter.ts` | 修改 | `generateSpeech` 的 directorSnapshot 条件和对象均增加 `sampleContext` 字段 |

### 设计决策

1. **Section 位置**：放在 Director's Notes 之后、Transcript 之前，与 Gemini TTS 五要素顺序一致（Audio Profile -> Scene -> Director's Notes -> Sample Context -> Transcript）
2. **五要素概要**：在 preview 步骤新增紧凑的概要面板，同时展示所有五个 normalized 元素，让用户在确认前快速检查各要素内容
3. **空值处理**：空值在概要中显示为 italic "(empty)"，与其他要素保持一致的视觉处理

## Major 2: httpAdapter.assemblePrompt 对非 2xx 响应丢失后端错误码

### 问题
`httpAdapter.assemblePrompt` 使用通用 `apiFetch` helper 处理 HTTP 请求。`apiFetch` 在非 2xx 时抛出 `Error("API Error 400: ...")`，导致 `assemblePrompt` 的 catch 块将所有错误统一替换为 `{ code: "NETWORK_ERROR" }`。后端返回的结构化错误（`VALIDATION_ERROR`、`DIRECTOR_SPEAKER_LIMIT_EXCEEDED`、invalid JSON body 等）的错误码和 message 完全丢失，前端 DirectorPage 的错误展示区始终显示 `NETWORK_ERROR` 而非后端真实错误码。

### 修复内容

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/app/services/httpAdapter.ts` | 修改 | `assemblePrompt` 方法不再使用 `apiFetch`，改为直接调用 `fetch`。无论 HTTP 状态码如何，均尝试解析 JSON body。如果 body 包含 `ok` 字段（后端统一响应格式），直接返回。只有真正的网络异常（DNS/CORS/连接拒绝/超时）才映射为 `NETWORK_ERROR`。非 JSON 响应（代理/CDN）映射为 `NETWORK_ERROR` 但标记 `retryable: false` |

### 修复后错误码映射

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| 后端 400 + VALIDATION_ERROR | NETWORK_ERROR | VALIDATION_ERROR（保留后端 code/message/category/retryable） |
| 后端 400 + DIRECTOR_SPEAKER_LIMIT_EXCEEDED | NETWORK_ERROR | DIRECTOR_SPEAKER_LIMIT_EXCEEDED（保留完整错误信息） |
| 后端 200 + ok:true | 正常 | 正常（无变化） |
| 后端 400 + 非 JSON body | NETWORK_ERROR | NETWORK_ERROR + "non-JSON body" + retryable:false |
| 网络异常（fetch throw） | NETWORK_ERROR | NETWORK_ERROR（无变化，保留 retryable:true） |

### 设计决策

1. **不修改 apiFetch**：`apiFetch` 被其他方法（generateSpeech、probeVoice 等）广泛使用，这些方法对非 2xx 的处理语义不同（有的返回 error result，有的 catch 后返回 fallback）。修改 apiFetch 会引入回归风险。仅针对 `assemblePrompt` 做精确的错误码保留。
2. **catch 只捕获网络异常**：只有 fetch 本身抛出异常时才进入 catch 块返回 `NETWORK_ERROR`。非 2xx 但有 JSON body 的响应通过正常路径返回后端的错误结构。

## 代码变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/app/pages/DirectorPage.tsx` | 修改 | +1 state (sampleContext), +1 Section UI (Sample Context), +1 概要面板 (五要素), handleAssemble/handleGenerate 增加 sampleContext |
| `src/app/types/index.ts` | 修改 | GenerateRequest 新增 sampleContext? 字段 |
| `src/app/services/httpAdapter.ts` | 修改 | assemblePrompt 绕过 apiFetch 直接处理响应；generateSpeech directorSnapshot 增加 sampleContext |

## 自测报告

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 前端 build | PASS | `npm run build` 1622 modules, 0 error, 2.88s |
| 后端 build | PASS | `npm run server:build` tsc 编译通过 |
| 后端 typecheck | PASS | `npm run typecheck` 无错误 |
| 后端测试 | PASS | 154/154 通过（6 个测试文件） |
| 全 7 态覆盖 | N/A | 本次仅修复已有组件的数据流，未新增独立组件 |
| 视觉一致性 | PASS | Sample Context Section 与其他 Section 样式一致；五要素概要与 normalized speakers 样式一致 |
| 反 AI 垃圾 | PASS | 无新增渐变/圆角卡片/Inter 字体等 AI 默认套路 |
| 行动兑现 | PASS | 声明修复 sampleContext 缺失 -> 代码中确实新增了 state/UI/submit/preview |
| 交接标注 | 已标注 | 建议下一步：谛听（reviewer）复审 |

## 建议下一步

- 谛听（reviewer）复审两个 Major 修复的代码质量和边界覆盖
- 真实 OpenRouter smoke 仍为 Phase 4/P0 门禁，本次修复不涉及
