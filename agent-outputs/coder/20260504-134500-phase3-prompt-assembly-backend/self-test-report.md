# 自测报告：Phase 3 Director MVP 后端 - Prompt Assembly API

## 元信息
- **任务ID**: 20260504-134500-phase3-prompt-assembly-backend
- **执行时间**: 2026-05-04 13:45:00
- **执行Agent**: 鲁班（coder）
- **项目**: tts-voice-generator

## 实现摘要

实现 Phase 3 Director MVP 后端核心功能：`POST /api/prompts/assemble` 路由和 PromptAssemblyService。按 Gemini TTS 五要素（Audio Profile / Scene / Director's Notes / Sample Context / Transcript）组装 prompt 文本，支持最多 2 个 Speaker（含 voice canonicalization），返回 `{ prompt, warnings, normalized }` 结构化响应。所有 speaker.voice 经过 canonicalizeVoice（alloy -> Zephyr legacy 兼容）。speakers 超限返回 400 `DIRECTOR_SPEAKER_LIMIT_EXCEEDED`；空 transcript 返回 400 `VALIDATION_ERROR`。

## 变更文件
| 文件路径 | 变更类型 | 变更说明 |
|----------|----------|----------|
| server/src/services/prompt-assembly.ts | 新增 | PromptAssemblyService：五要素 prompt 组装、voice canonicalization、warnings 生成 |
| server/src/routes/prompts.ts | 新增 | POST /api/prompts/assemble 路由：Zod 校验、speaker limit、错误响应 |
| server/src/index.ts | 修改 | 注册 promptsRoutes 到 Hono app |
| server/__tests__/prompts-api.test.ts | 新增 | 36 项测试：prompt 组装、speaker limit、legacy alias、空 transcript、路由注册、warnings |
| Gemini-OpenRouter-TTS-Web应用架构规划.md | 修改 | API 表更新、服务层表更新、Phase 3 后端状态记录 |

## 测试结果
| 测试项 | 结果 | 说明 |
|-------|------|------|
| server typecheck | PASS | tsc --noEmit 无错误 |
| server build | PASS | tsc 编译通过 |
| 新增测试 (36) | PASS | prompts-api.test.ts 全部通过 |
| 全量测试 (154) | PASS | 6 个测试文件，154 项全部通过（118 旧 + 36 新） |
| root server:build | PASS | npm run server:build 通过 |
| root npm test | PASS | 等价 server 测试，154/154 通过 |

## 测试详情

### 功能测试
- 路由注册与响应格式：验证 POST /api/prompts/assemble 返回 200 + { ok, requestId, prompt, warnings, normalized }
- Prompt 组装（完整五要素）：验证 prompt 包含 Audio Profile / Scene / Director's Notes / Sample Context / Transcript / Speaker 定义
- Prompt 组装（仅 transcript）：验证最小输入正常工作
- 空可选字段：验证空 audioProfile/scene/directorNotes 不在 prompt 文本中出现

### 边界测试
- Speaker 限制：0 speaker PASS / 1 speaker PASS / 2 speaker PASS / 3 speaker 返回 400 / 5 speaker 返回 400
- 空 transcript：返回 400 VALIDATION_ERROR
- 缺失 transcript 字段：返回 400 VALIDATION_ERROR
- 无效 JSON body：返回 400 VALIDATION_ERROR
- 空 speaker voice：返回 400 VALIDATION_ERROR
- 缺失 speaker id：返回 400 VALIDATION_ERROR

### Legacy alias 测试
- alloy -> Zephyr canonicalization：normalized.speakers.voice = "Zephyr"
- LEGACY_VOICE_ALIAS warning：提示 alloy 已被 canonicalize
- prompt 文本中使用 canonical 名：[Voice: Zephyr]
- 混合 speaker（alloy + Puck）：仅 alloy 产生 warning
- 非别名 voice（Zephyr）：不产生 LEGACY_VOICE_ALIAS warning

### Warnings 测试
- audioProfile 为空 -> SUGGEST_AUDIO_PROFILE warning
- scene 为空 -> SUGGEST_SCENE warning
- directorNotes 为空 -> SUGGEST_DIRECTOR_NOTES warning
- 三项全部为空 -> 3 个 warnings
- 全部提供 -> 0 个 suggest warnings
- sampleContext 为空不产生 warning（符合预期）

## API 契约

### POST /api/prompts/assemble

**Request Body:**
```json
{
  "audioProfile": "string (optional, default '')",
  "scene": "string (optional, default '')",
  "directorNotes": "string (optional, default '')",
  "sampleContext": "string (optional, default '')",
  "transcript": "string (required, min 1)",
  "speakers": [
    {
      "id": "string (required)",
      "label": "string (required)",
      "name": "string (optional)",
      "voice": "string (required)",
      "style": "string (optional)"
    }
  ]
}
```

**Constraints:**
- `speakers`: max 2 (DIRECTOR_SPEAKER_LIMIT_EXCEEDED)
- `transcript`: required, non-empty (VALIDATION_ERROR)

**Success Response (200):**
```json
{
  "ok": true,
  "requestId": "uuid",
  "prompt": "assembled prompt text",
  "warnings": [
    { "code": "LEGACY_VOICE_ALIAS", "message": "...", "field": "..." },
    { "code": "SUGGEST_AUDIO_PROFILE", "message": "...", "field": "audioProfile" }
  ],
  "normalized": {
    "speakers": [
      { "id": "a", "label": "Host", "name": "Alice", "voice": "Zephyr", "style": "cheerful", "wasLegacyAlias": false }
    ],
    "audioProfile": "...",
    "scene": "...",
    "directorNotes": "...",
    "sampleContext": "...",
    "transcript": "..."
  }
}
```

**Error Response (400):**
```json
{
  "ok": false,
  "requestId": "uuid",
  "error": {
    "code": "DIRECTOR_SPEAKER_LIMIT_EXCEEDED | VALIDATION_ERROR",
    "message": "...",
    "category": "validation",
    "retryable": false,
    "metadata": {}
  }
}
```

## 前端对接说明

1. httpAdapter 需新增 `assemblePrompt` 方法，调用 `POST /api/prompts/assemble`
2. 请求体与 `GenerateRequest` 的 `speakers`/`audioProfile`/`scene`/`directorNotes` 字段对齐
3. 响应中 `prompt` 字段可直接作为 `POST /api/tts/generate` 的 `input` 使用
4. `normalized.speakers` 包含 canonicalized voice 和 `wasLegacyAlias` 标记，可用于 UI 提示
5. `warnings` 数组可展示在 Director 页面，提醒用户补充可选元素
6. 前端 `SpeakerConfig` 类型（src/app/types/index.ts）与后端 `SpeakerInput` 兼容：`id`/`label`/`name`/`voice`/`style` 字段一一对应

## 文档回填摘要

- 架构规划文档 Section 6.1：`POST /api/prompts/assemble` 从待实现移至已实现
- 架构规划文档 Section 6.2：原条目标记为已实现
- 架构规划文档 Section 9.2：PromptAssembler 从待实现改为已实现
- 架构规划文档新增 Section 20：Phase 3 Director MVP 后端状态记录

## 遗留问题

1. **前端对接未完成**：Director 页面和 httpAdapter 的 assemblePrompt 调用由洛神实现
2. **真实效果未验证**：assembled prompt 传给 Gemini TTS 的实际生成效果依赖真实 OpenRouter smoke test（Phase 4 门禁）
3. **Token 估算未实现**：PromptAssemblyService 当前不估算 prompt token 数，可后续补充
4. **Phase 3 完整闭环**：需等待前端 Director 页面接入 + 谛听审核通过后才能标记为 completed

## 建议下一步
reviewer 审核

---
*本报告由鲁班（coder）Agent 生成*
*任务ID: 20260504-134500-phase3-prompt-assembly-backend*
