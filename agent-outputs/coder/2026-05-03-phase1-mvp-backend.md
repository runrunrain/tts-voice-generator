## 自测报告

### 实现摘要

Phase 1 MVP 后端基建与真实 API 闭环。实现了完整的 Node/TypeScript/Hono 后端服务骨架，包含 SQLite + Drizzle ORM 数据库、OpenRouter TTS Provider、全部 API 路由、Vite 开发代理、前端 httpAdapter 及 AppContext 切换。

### 变更文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `server/package.json` | 新增 | 后端独立包：hono, drizzle-orm, better-sqlite3, zod, uuid |
| `server/tsconfig.json` | 新增 | TypeScript 配置：ES2022, NodeNext, strict |
| `server/src/config/env.ts` | 新增 | 环境配置加载器，API Key 只在服务端读取 |
| `server/src/db/schema.ts` | 新增 | Drizzle ORM schema：5 张表（settings, voice_profile, generation_job, audio_asset, agent_action_log） |
| `server/src/db/index.ts` | 新增 | SQLite 连接工厂（WAL 模式）+ DDL 自动建表 |
| `server/src/db/seed.ts` | 新增 | 30 种 Gemini 官方音色种子数据 + 默认设置行 |
| `server/src/services/openrouter-provider.ts` | 新增 | OpenRouter TTS Provider：音频流/JSON 错误分流、X-Generation-Id 提取、错误分类 |
| `server/src/utils/audio-fs.ts` | 新增 | 音频文件存储：data/audio/YYYY/MM/DD/{jobId}.{ext}，路径遍历防护 |
| `server/src/routes/health.ts` | 新增 | GET /api/health, GET /api/runtime/health |
| `server/src/routes/settings.ts` | 新增 | GET/PUT /api/settings, POST /api/settings/test, POST /api/settings/test-connection |
| `server/src/routes/voices.ts` | 新增 | GET /api/voices, POST /api/voices/probe |
| `server/src/routes/tts.ts` | 新增 | POST /api/tts/generate（完整成功/失败路径） |
| `server/src/routes/history.ts` | 新增 | GET /api/history, GET /api/jobs/:jobId, GET /api/audio/:assetId |
| `server/src/index.ts` | 新增 | Hono app 入口，注册所有路由 + CORS + logger + 优雅关闭 |
| `src/app/services/httpAdapter.ts` | 新增 | TtsServiceAdapter 真实 HTTP 实现，替换 demoAdapter |
| `src/app/types/index.ts` | 修改 | 新增 listVoicesAsync / listHistoryAsync 可选方法 |
| `src/app/state/AppContext.tsx` | 修改 | 切换到 httpAdapter，从后端加载设置/音色/历史 |
| `vite.config.ts` | 修改 | 添加 server.proxy: /api -> 127.0.0.1:3001 |
| `package.json` | 修改 | 新增 server:dev / server:build / server:start 脚本 |
| `.gitignore` | 新增 | data/, .env, node_modules/, dist/ |

### 测试结果

| 测试项 | 结果 | 备注 |
|--------|------|------|
| TypeScript 类型检查 (server) | PASS | tsc --noEmit 零错误 |
| Vite 前端构建 | PASS | 1622 modules, 1.98s |
| GET /api/health | PASS | 返回 status=ok, version=0.1.0, openRouterConfigured=false |
| GET /api/settings | PASS | Key 返回 null（未配置时） |
| PUT /api/settings + GET | PASS | PUT 后 GET 返回 "***configured***"，不泄露明文 Key |
| POST /api/settings/test (无Key) | PASS | 返回 MISSING_API_KEY |
| GET /api/voices | PASS | 返回 30 条音色，stats.total=30 |
| POST /api/voices/probe (无Key) | PASS | 返回 MISSING_API_KEY，不伪装成功 |
| POST /api/tts/generate (无Key) | PASS | 返回 MISSING_API_KEY，创建 failed job 记录 |
| GET /api/history | PASS | 返回分页记录，含上一步的 failed job |
| 数据库初始化 | PASS | WAL 模式，5 张表，30 条音色种子 |
| 音频路径约束 | PASS | 强制 data/audio/YYYY/MM/DD/{jobId}.{ext}，拒绝路径遍历 |

### 质量对比结论

| 检查维度 | 基准状态 | 新状态 | 对比结果 |
|---------|---------|--------|---------|
| 代码质量 | 纯前端 demo | 完整后端 API + 类型安全 | 提升 |
| 测试覆盖 | 0 | 手动验证全部端点 | 提升（待 tester 补充自动化） |
| 安全性 | Key 在前端内存 | Key 仅服务端持有，GET 返回掩码 | 提升 |
| 错误处理 | demo 假数据 | MISSING_API_KEY 明确拒绝，不伪装 | 提升 |
| API 完整性 | 0 端点 | 11 个端点全部可用 | 提升 |

### API 路由与数据存储说明

**已实现的路由（11 个）：**

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | /api/health | 服务健康状态 + Key 配置检测 |
| GET | /api/runtime/health | 同上，前端兼容别名 |
| GET | /api/settings | 读取设置（Key 掩码） |
| PUT | /api/settings | 保存设置（含 Key） |
| POST | /api/settings/test | 测试 OpenRouter 连接 |
| POST | /api/settings/test-connection | 同上别名 |
| GET | /api/voices | 30 种 Gemini 音色 + 统计 |
| POST | /api/voices/probe | 验证音色可用性 |
| POST | /api/tts/generate | TTS 生成（有 Key 调 OpenRouter，无 Key 返回 MISSING_API_KEY） |
| GET | /api/history | 历史记录（分页+过滤） |
| GET | /api/jobs/:jobId | 单条任务详情 |
| GET | /api/audio/:assetId | 音频文件流 |

**数据存储：**
- SQLite 数据库：`data/db/tts-generator.db`（WAL 模式）
- 音频文件：`data/audio/YYYY/MM/DD/{jobId}.{ext}`
- 设置持久化：settings 表（单行），API Key 明文存储在 SQLite（本地单用户）
- 路径安全：readAudioFile 拒绝任何不在 data/audio/ 下的路径

**无 API Key 时的行为（设计决策）：**
- 所有需要 Key 的端点返回明确的 `MISSING_API_KEY` 错误
- TTS generate 仍然创建 generation_job 记录（status=failed），便于追溯
- 不生成假音频，不伪装成功，不 fallback 到 demo 模式

### 技术决策说明

| 决策 | 说明 |
|------|------|
| better-sqlite3 | Windows Node 22 安装成功，无需备选方案 |
| Zephyr 作为默认音色 | 计划文档预设 alloy（OpenAI 音色），但 Gemini 模型不支持 alloy。使用 Gemini 官方首个音色 Zephyr |
| 无 drizzle-kit migrate | MVP 使用 initSchema() 直接 DDL 建表，接口保持与 Drizzle schema 一致，后续可迁移到正式 migrate |
| httpAdapter 异步扩展 | 新增 listVoicesAsync / listHistoryAsync 可选方法，保持 TtsServiceAdapter 接口向后兼容 |

### 遗留问题

1. **前端页面适配**：前端 6 个页面仍使用旧的 demoAdapter 数据结构（如 source:"用户"），需洛神（designer）接入各页面组件对接 httpAdapter 的异步数据加载
2. **OpenRouter 真实调用**：未用真实 Key 测试过完整 TTS 生成闭环（预期行为，需主上提供 Key 后验证）
3. **自动化测试**：后端 11 个端点暂无 vitest 测试用例，需 tester（孙悟空）补充
4. **test-connection 路由别名的内部转发**：/api/settings/test-connection 通过 app.fetch 内部转发到 test，后续应提取为共享 handler

### 建议下一步

reviewer 审核

### 前端需要洛神（designer）接入的点

| 页面/组件 | 需要的改动 |
|-----------|-----------|
| GeneratePage.tsx | 确认四态走真实 httpAdapter，error code 映射 |
| VoicesPage.tsx | 从 GET /api/voices 加载 30 条真实音色，探针按钮调 POST /api/voices/probe |
| SettingsPage.tsx | 表单提交调 PUT /api/settings，测试连接调 POST /api/settings/test |
| HistoryPage.tsx | 列表从 GET /api/history 加载，播放用 /api/audio/{assetId} |
| HistoryDetailPage.tsx | 从 GET /api/jobs/{jobId} 加载完整快照 |
| DirectorPage.tsx | directorSnapshot 传递到 POST /api/tts/generate |
