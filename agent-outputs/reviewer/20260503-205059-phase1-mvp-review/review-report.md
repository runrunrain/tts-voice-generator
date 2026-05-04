## 审核报告

### 审核概要
| 项目 | 内容 |
|------|------|
| 审核时间 | 2026-05-03T20:50:59 |
| 审核轮次 | 第 1 轮 |
| 变更范围 | 后端 server、前端 src/app、后端测试 39 用例 |
| 审核结论 | 不通过 |

### P0/P1/P2 问题清单

#### P0（阻塞 Phase 1 MVP）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| P0-01 | `src/app/pages/SettingsPage.tsx:41-53`, `src/app/state/AppContext.tsx:179-193` | 设置页首次保存 API Key 实际没有写入后端，却显示“已保存”。浏览器验证：输入 `sk-review-fake-key-12345678` 后点击保存，页面显示“已保存”，但 `GET /api/settings` 仍为 `hasOpenRouterApiKey:false`，`/api/health` 仍为 `openRouterConfigured:false`。根因是 `updateSettings()` 异步更新 React state，随后 `saveSettings()` 读取旧闭包 `settings`。这会阻断真实 OpenRouter 闭环。 | 不要通过全局 settings state 中转明文 Key。`handleSave` 直接向 `/api/settings` 提交当前表单快照，成功后清空本地 `apiKey`；或将 `saveSettings(nextSettings)` 改为显式接收最新值并等待结果。保存失败必须显示失败，不能无条件显示“已保存”。 |

#### P1（必须修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| P1-01 | `server/src/routes/history.ts:58-80`, `src/app/pages/HistoryPage.tsx:181-190` | 历史列表未按计划 LEFT JOIN `audio_asset`，`duration` 固定为 `null`，列表也不返回 `assetId/audioUrl`；前端历史页“播放/下载”按钮没有任何处理逻辑。成功生成后的 history 数据态无法完成回放/下载闭环，音频资产和历史记录字段不一致。 | history 查询联表 `audio_asset`，返回 `assetId/audioUrl/duration/sizeBytes/mimeType`；前端列表播放使用 `<audio src=/api/audio/{assetId}>`，下载按钮指向同一音频 URL。 |
| P1-02 | `server/src/utils/audio-fs.ts:14`, `server/src/utils/audio-fs.ts:66-73` | 音频路径防护使用 `resolvedPath.startsWith(normalizedBase)`，存在典型前缀绕过风险，例如同盘 `.../data/audio_evil/...` 可通过字符串前缀判断；同时 `AUDIO_BASE_DIR` 固定 `./data/audio`，未使用 `env.audioOutputDir` 或 settings 中的 `audioOutputDir`。 | 使用 `path.relative(base, resolved)` 校验：`!relative.startsWith('..') && !path.isAbsolute(relative)`；baseDir 从 env/settings 解析并固定为绝对路径。 |
| P1-03 | `server/__tests__/tts-api.test.ts:88-105` | TTS 路由测试 mock 掉 `audio-fs`，导致成功路径没有真实验证目录创建、文件写入、sha256、后续 `/api/audio/{assetId}` 可读。测试注释声称覆盖文件写入，但实际只验证 mock 返回值，存在过度 mock。 | 保留 provider mock，但使用临时目录真实写文件并通过 history/audio 路由读回；补充 200 + `application/json` 被分流为 `UNEXPECTED_RESPONSE_TYPE` 且不写文件的测试。 |

#### P2（建议修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| P2-01 | `package.json:10` | 根脚本 `npm run server:build` 失败：`tsc` 在根依赖不可解析。已验证 `server` 目录内 `npm run build` 和 `npm run typecheck` 通过。 | 根脚本改为 `npm run build --prefix server` 或 `npx tsc -p server/tsconfig.json`，保证一键构建可用。 |
| P2-02 | `server/src/routes/tts.ts:67-95` | 无 Key 时返回 HTTP 200 + failed body，与执行计划 Task 1.4 验收“返回 400”不一致。前端当前能处理，但 API 契约偏离。 | 若坚持同步失败响应，建议改为 400 并让 `httpAdapter` 正确解析 JSON 错误；或更新契约并测试说明 200+failed 的设计理由。 |
| P2-03 | `src/app/pages/VoicesPage.tsx:28-43` | 候选 Tab/计数用 `status === success` 判断，后端初始候选音色为 `unknown -> pending`，导致“候选”计数为 0，不等于后端 stats.candidate。 | 前端保留后端 `source` 字段，候选/自定义/默认计数按 `source` 而非验证状态计算。 |
| P2-04 | `src/app/pages/GeneratePage.tsx:7`, `src/app/pages/GeneratePage.tsx:35` | 前端字符限制硬编码 5000，未使用后端 settings 的 `maxCharsPerRequest`。 | 使用 `settings.maxChars` 派生 UI 限制，并处理后端 400 `TEXT_TOO_LONG`。 |

### 质量对比结论
| 维度 | 基准状态 | 新状态 | 对比结论 |
|------|---------|--------|---------|
| 代码质量 | 前端 Demo，无后端 | 后端/前端真实 API 已搭建，但设置保存和历史闭环有阻塞缺陷 | 下降（存在 P0/P1） |
| 测试覆盖率 | 无后端测试 | `server:test` 39/39 通过，但成功文件链路与 200 JSON 错误分流未真实覆盖 | 提高但不足 |
| 性能指标 | 无后端 | SQLite/WAL、本地同步写文件，MVP 可接受 | 维持 |
| 安全风险 | Key 曾在前端 Demo | 后端加密保存、GET 不返明文、localStorage 为空；音频路径校验有前缀绕过风险 | 有新增需修复 |

### 安全审计结果
| 发现 | OWASP 分类 | 置信度 | 严重性 | 修复建议 |
|------|-----------|--------|--------|---------|
| 音频文件读取路径使用字符串 `startsWith` 做目录边界判断，可被同前缀目录绕过 | A01 Broken Access Control / Path Traversal | 85% | P1 | 使用 `path.relative` 边界校验并绑定配置化 baseDir。 |
| API Key 通过后端 PUT 加密存储，GET 仅返回 mask；浏览器 localStorage 验证为空 | Sensitive Data Exposure | 90% | 通过项 | 保持 Key 只在提交表单瞬间存在，修复 P0 时避免进入全局 Context。 |

### 验证记录
| 命令/方式 | 结果 |
|-----------|------|
| `npm run build` | 通过，Vite 构建成功 |
| `npm run server:test` | 通过，3 files / 39 tests passed |
| `npm run server:build`（根目录） | 失败：`tsc` 不可识别 |
| `npm run build`（server 目录） | 通过 |
| `npm run typecheck`（server 目录） | 通过 |
| 浏览器无 Key 主流程 | 通过错误态验证：Top/Bottom 显示 Key missing，生成后 RightPanel 显示 `MISSING_API_KEY` 与设置页引导 |
| 浏览器设置保存 | 失败：输入 fake key 后 UI 显示已保存，但后端仍未配置 Key |
| `localStorage` 检查 | `{}`，未发现 Key 保存到 localStorage |

### 正向反馈
- 后端骨架、Hono 路由、SQLite schema、DB-first key resolver、OpenRouter provider 主路径已形成可运行结构。
- 39 个后端测试覆盖了无 Key、加密保存、DB-first resolver、主要 provider 错误码、基础音频路径拒绝。
- 前端默认 httpAdapter，TopBar/BottomBar 能显示后端与 Key 状态；无 Key 生成错误态和设置页跳转引导可用。

### 建议下一步
结论为不通过。优先修复 P0-01；随后修复历史音频闭环与 audio path 边界校验；补齐真实文件链路与 200 JSON 错误分流测试后重新审核。
