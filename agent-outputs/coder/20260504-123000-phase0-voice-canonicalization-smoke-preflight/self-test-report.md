## 自测报告

### 实现摘要

Phase 0 修复实施：完成 voice canonicalization 统一（alloy -> Zephyr）、前端 fallback 更新、PUT settings 归一化、TTS/voices probe canonicalization、smoke preflight 脚本、根目录 server:build 门禁修复。

### 变更文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `server/src/utils/voice.ts` | 新增 | Voice canonicalization 模块：canonicalizeVoice()、isLegacyAlias()、getDefaultVoice() |
| `server/src/routes/settings.ts` | 修改 | PUT /api/settings 保存 defaultVoice 前调用 canonicalizeVoice() |
| `server/src/routes/tts.ts` | 修改 | TTS 生成前使用 canonicalVoice 替代 req.voice |
| `server/src/routes/voices.ts` | 修改 | voices probe 使用 canonicalizeVoice() 后发送到 provider 和 DB |
| `server/__tests__/smoke-preflight.test.ts` | 新增 | Smoke preflight 测试：27 测试覆盖 6 类检查项 |
| `package.json` | 修改 | server:build 脚本从 `tsc -p server/tsconfig.json` 改为 `npm run build --prefix server` |
| `src/app/pages/GeneratePage.tsx` | 修改 | Fallback 音色列表从 alloy 系改为 Zephyr 系 |
| `src/app/pages/DirectorPage.tsx` | 修改 | Speaker 默认 voice 和 addSpeaker 改为 Zephyr；fallback 列表更新 |
| `src/app/pages/VoicesPage.tsx` | 修改 | selectedVoice 初始值改为 Zephyr |
| `src/app/services/demoAdapter.ts` | 修改 | VOICE_CATALOG 和 DEMO_HISTORY 全部改为 Gemini 音色名 |
| `D:/.../Gemini-OpenRouter-TTS-Web项目后续开发执行计划.md` | 修改 | Phase 0 任务 0.3/0.4 状态更新为 completed；新增第二轮修复记录；Phase 路线图状态更新 |
| `D:/.../Gemini-OpenRouter-TTS-Web应用架构规划.md` | 修改 | Phase 0 补验状态更新为 completed |

### 测试结果

| 测试项 | 结果 | 备注 |
|--------|------|------|
| `npm run build` (前端) | PASS | 1622 modules, 1.88s |
| `npm run build` (server) | PASS | tsc 编译通过 |
| `npm run typecheck` (server) | PASS | tsc --noEmit 通过 |
| `npm run server:build` (根) | PASS | 修复后使用 npm run build --prefix server |
| `npm test` (server) | PASS | 4 files, 71 tests, 71 passed |
| smoke-preflight.test.ts | PASS | 27/27 tests passed |

### 质量对比结论

| 检查维度 | 基准状态 | 新状态 | 对比结果 |
|---------|---------|--------|---------|
| 代码质量 | 零散 defaultVoice，前端多 alloy 硬编码 | 统一 canonicalization 模块，全链路归一化 | 提升 |
| 测试覆盖 | 44 tests | 71 tests (+27 smoke preflight) | 提升 |
| 构建门禁 | 根 server:build 失败 | 全部 PASS | 提升 |
| 安全扫描 | 无新增风险 | Key 脱敏测试覆盖，无 API Key 泄露 | 维持 |

### defaultVoice 修复证据

| 位置 | 修复前 | 修复后 | 证据 |
|------|--------|--------|------|
| `server/src/utils/voice.ts` | 不存在 | 新增 canonicalizeVoice() | alloy -> Zephyr 映射 |
| `server/src/routes/settings.ts` | 原样保存 defaultVoice | canonicalizeVoice() 归一化后保存 | PUT+GET 测试验证 DB 为 Zephyr |
| `server/src/routes/tts.ts` | req.voice 原值 | canonicalVoice 归一化 | 合入已有 TTS 测试 |
| `server/src/routes/voices.ts` | voiceName 原值 | canonicalizeVoice(voiceName) | 合入已有 voices 测试 |
| `GeneratePage.tsx` fallback | `["alloy", "echo", ...]` | `["Zephyr", "Puck", ...]` | 前端 build 通过 |
| `DirectorPage.tsx` speaker | `voice: "alloy"` | `voice: "Zephyr"` | 前端 build 通过 |
| `VoicesPage.tsx` 初始 | `useState<string>("alloy")` | `useState<string>("Zephyr")` | 前端 build 通过 |
| `demoAdapter.ts` catalog | alloy 系音色 | Zephyr 系 Gemini 音色 | 前端 build 通过 |

### smoke 前置能力说明

新增 `server/__tests__/smoke-preflight.test.ts` 提供 6 类 27 项检查：

1. **Voice canonicalization**（11 项）：alloy -> Zephyr 映射、case-insensitive、pass-through、PUT 归一化、DB 验证
2. **Key injection and sanitization**（5 项）：PUT 存储、GET 不暴露明文、resolveApiKey 正确性、isOpenRouterConfigured、DB 加密
3. **Database accessibility**（4 项）：schema 初始化、settings 默认值、30 音色 seed、health 端点
4. **Audio output directory**（2 项）：可写验证、write+read round-trip
5. **Backend API endpoints**（4 项）：health、settings、voices、test-connection 端点响应
6. **Preflight report generation**（1 项）：结构化报告能力（验证所有检查项可聚合为一个 JSON 报告）

**真实 OpenRouter API 调用未执行**。smoke preflight 只验证环境准备就绪，不消耗 Token。真实调用留到 Phase 4 显式 smoke 阶段，限制为一次短文本 MP3。

### 文档回填摘要

| 文档 | 更新内容 |
|------|---------|
| 执行计划 Phase 路线图 | Phase 0 状态从 `partial` 更新为 `completed` |
| 执行计划 0.3/0.4 | 状态从 `partial` 更新为 `completed` |
| 执行计划第二轮修复记录 | 新增完整修复记录表（13 项修复） |
| 架构规划 Phase 0 补验状态 | defaultVoice 和 smoke 前置从 `partial` 更新为 `completed` |
| 架构规划摘要状态 | 更新为"Phase 0 代码修复已完成" |

### 遗留问题

1. **真实 OpenRouter API smoke test 仍未执行** -- Phase 4 MVP/P0 门禁，需要真实 Key 和显式执行
2. `/api/prompts/assemble` 未实现 -- Director 真实闭环阻塞项
3. Agent API/Token/授权/预算未实现 -- Phase 5 范围
4. 并发控制、指数退避重试未补强 -- Phase 1 范围
5. PCM WAV 封装未实现 -- Phase 6 范围
6. 前端四态真实 API 验证报告未补齐 -- Phase 2 范围

### 建议下一步

reviewer 审核
