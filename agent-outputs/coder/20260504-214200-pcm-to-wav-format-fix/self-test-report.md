## 自测报告

### 实现摘要

修复 Gemini/OpenRouter TTS 真实链路兼容性问题。Gemini TTS 仅支持 `response_format="pcm"`（24kHz/16-bit/mono），旧的默认 `mp3` 导致真实请求 400 错误。

**核心策略**：浏览器主路径改为 WAV（由上游 PCM 封装 RIFF WAV header）。保留 `mp3` 作为 legacy 输入兼容，内部自动映射为：上游请求 `pcm`，本地输出 `wav`。

### 变更文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `server/src/utils/audio-format.ts` | 新增 | 音频格式解析、PCM-to-WAV 封装工具 |
| `server/src/utils/audio-fs.ts` | 无功能变更 | 保持现有 getMimeType/getExtension（audio-format.ts 自行实现避免循环依赖） |
| `server/src/routes/tts.ts` | 修改 | Zod schema 接受 wav/pcm/mp3，默认 wav；格式解析 + PCM 封装 WAV；DB 记录实际输出格式 |
| `server/src/routes/settings.ts` | 修改 | Zod schema 接受 wav/pcm/mp3；GET 规范化旧 mp3 为 wav；PUT 规范化格式 |
| `server/src/routes/voices.ts` | 修改 | probe 默认 wav 格式，内部上游 pcm；错误消息脱敏（sanitizeText） |
| `server/src/services/openrouter-provider.ts` | 修改 | responseFormat 类型接受 wav |
| `server/src/db/schema.ts` | 修改 | defaultFormat 默认值改为 "wav" |
| `server/src/db/index.ts` | 修改 | DDL default_format DEFAULT 'wav' |
| `src/app/types/index.ts` | 修改 | AudioFormat 扩展为 "wav" \| "pcm" \| "mp3" |
| `src/app/state/AppContext.tsx` | 修改 | 默认 defaultFormat 改为 "wav" |
| `src/app/services/httpAdapter.ts` | 修改 | probeVoice format 从 "mp3" 改为 "wav" |
| `src/app/pages/GeneratePage.tsx` | 修改 | 格式按钮从 mp3/pcm 改为 WAV/PCM(raw) |
| `src/app/pages/DirectorPage.tsx` | 修改 | 格式按钮从 mp3/pcm 改为 WAV/PCM(raw) |
| `src/app/pages/SettingsPage.tsx` | 修改 | 默认格式从 mp3/pcm 改为 WAV(推荐)/PCM(raw) |
| `src/app/pages/HistoryDetailPage.tsx` | 修改 | format 类型断言扩展 |
| `server/__tests__/smoke-real-openrouter.test.ts` | 修改 | 真实 e2e 改为 responseFormat:"wav"，断言 audio/wav |
| `server/__tests__/tts-api.test.ts` | 修改 | mock 返回 PCM，断言 WAV 输出；验证 WAV header、upstreamFormat |
| `server/__tests__/settings-api.test.ts` | 修改 | defaultFormat 默认值断言改为 "wav" |
| `server/__tests__/data-consistency.test.ts` | 修改 | mock 返回 PCM，断言 WAV MIME/size |
| `server/__tests__/security-gate.test.ts` | 修改 | mock 返回 PCM，所有 audio/mpeg 改为 audio/pcm |
| `server/__tests__/phase1-stabilization.test.ts` | 修改 | mock 返回 PCM，扩展名改为 .wav |
| `server/__tests__/smoke-preflight.test.ts` | 修改 | 文件写入扩展名改为 .wav |

### 测试结果

| 测试项 | 结果 | 备注 |
|--------|------|------|
| `npm run typecheck --prefix server` | PASS | TypeScript 编译无错误 |
| `npm run build --prefix server` | PASS | 服务端构建成功 |
| `npm test --prefix server` | PASS | 209 passed, 1 skipped (无 key smoke) |
| `npm run build` (前端) | PASS | Vite 构建成功 |

### 核心变更逻辑

1. **`resolveTtsFormat(model, requestedFormat)`**：
   - Gemini TTS + wav/mp3 请求 -> upstream pcm + output wav + wrapPcmToWav=true
   - Gemini TTS + pcm 请求 -> upstream pcm + output pcm + wrapPcmToWav=false
   - 其他模型 -> passthrough

2. **`wrapPcm16LeToWav(buffer, {sampleRate:24000, channels:1, bitDepth:16})`**：
   - 生成标准 44-byte RIFF WAV header
   - 返回 Buffer.concat([header, pcmBuffer])

3. **TTS Route 成功路径**：
   - provider 调用使用 upstreamFormat
   - 成功后如 wrapPcmToWav=true，将 PCM 封装为 WAV
   - DB 记录实际输出格式（wav/pcm），不记录 legacy mp3

4. **Settings Route**：
   - GET 规范化旧 DB 中的 "mp3" 为 "wav"
   - PUT 规范化 "mp3" 输入为 "wav" 存储

5. **Voices Probe**：
   - 默认 format="wav"，内部使用 resolveTtsFormat 获取 upstream pcm
   - 错误消息使用 sanitizeText 脱敏

### 质量对比结论

| 检查维度 | 基准状态 | 新状态 | 对比结果 |
|---------|---------|--------|---------|
| 代码质量 | mp3 硬编码，与真实 API 不兼容 | 动态格式解析，完整兼容 | 提升 |
| 测试覆盖 | 209 tests pass | 209 tests pass | 维持 |
| 性能指标 | 无 WAV 封装开销 | 44-byte header 内存拷贝（微不足道） | 维持 |
| 安全扫描 | 无新增 | 无新增 | 无新增 |
| 真实链路 | 400 错误（Gemini 不支持 mp3） | 待主 Agent 用授权 key 验证 | 预期修复 |

### 遗留问题

- 真实 OpenRouter smoke 需要主 Agent 用授权 key 复跑（OPENROUTER_API_KEY 环境变量）
- 旧 DB 行中存储的 "mp3" 不会被自动迁移，GET 时在输出层规范化为 "wav"（不影响功能）
- providerOptions 类型中 responseFormat 仍接受 "wav"（通过 openrouter-provider 类型），实际发送到上游时由 resolveTtsFormat 映射为 "pcm"

### 建议下一步

1. 主 Agent 使用授权 key 执行真实 smoke 验证
2. reviewer 审核代码变更
