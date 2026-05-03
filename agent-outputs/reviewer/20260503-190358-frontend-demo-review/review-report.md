## 审核报告

### 审核概要
| 项目 | 内容 |
|------|------|
| 审核时间 | 2026-05-03 |
| 审核轮次 | 第 1 轮 |
| 变更范围 | 前端演示交互：Generate / Voices / History / Settings / RightPanel / Adapter |
| 审核结论 | 不通过 |

### 总体结论
未发现源码中仍硬编码 `sk-or-v1-abc123def456`、`sk-or-v1` 或其他明显 API Key；`npm run build` 通过；Generate 主流程、错误态、Voices 探针、Settings 测试连接在浏览器中可操作。

但当前仍有 P1 级质量问题：历史页绕过 adapter 导致右侧预览为空，RightPanel 错误态重试会生成 0 字符“成功”结果，顶部/底部 API 状态存在硬编码伪真实状态。这些问题会误导演示验收，也破坏未来真实 API adapter 的边界。

### 阻塞问题（Major，必须修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| M1 | `src/app/pages/HistoryPage.tsx:7-35`, `src/app/components/RightPanel.tsx:430-438`, `src/app/state/AppContext.tsx:151-171` | HistoryPage 使用本地 `SAMPLE_RECORDS`，而 RightPanel 从 context 的 `historyRecords` 读取；`historyRecords` 初始为空且没有自动刷新。浏览器验证结果：历史列表显示 5 条记录，但右侧“记录预览”显示“暂无历史记录预览”。这破坏历史页面基本交互，也绕过 `TtsServiceAdapter.listHistory` 边界。 | 将历史数据单一来源收敛到 AppContext/adapter；HistoryPage 使用 `historyRecords/historyFilter/setHistoryFilter/refreshHistory`；页面加载和筛选变化时触发刷新；activeRecord 与 RightPanel 共用同一条记录。 |
| M2 | `src/app/components/RightPanel.tsx:171-184`, `src/app/state/AppContext.tsx:71-100`, `src/app/services/demoAdapter.ts:120-159` | RightPanel 错误态“重试”调用 `generate({ text: "" ... })`，绕过 GeneratePage 的空文本校验。浏览器验证结果：输入 `[error]` 后点击右侧“重试”，生成成功但字符数为 0，属于伪成功结果。 | 重试应携带原始请求文本，或在没有原始文本时禁用重试并提示回到输入区；同时在 `generate` 或 adapter 层增加 `text.trim()` 校验，避免任何入口生成空文本成功结果。 |
| M3 | `src/app/components/TopBar.tsx:49-52`, `src/app/components/BottomBar.tsx:5-16`, `src/app/services/demoAdapter.ts:171-174` | 顶部始终显示 `API: OK`，底部始终显示 `127.0.0.1:3000 / 服务运行中 / 今日生成: 3`，Settings 测试连接对任意非空 key 总是返回 `connected`。这些状态没有统一标注为演示模拟，容易被理解为真实 API/服务状态。 | 顶部/底部状态从 AppContext 的 connectionStatus 和统计数据派生；演示模式下明确显示“Demo API: simulated”；Settings 测试连接返回文案应标注“模拟连接成功”，避免伪装真实连通性。 |

### 非阻塞建议（Minor）
| 编号 | 文件:行号 | 问题 | 建议 |
|------|----------|------|------|
| m1 | `src/app/pages/SettingsPage.tsx:23-37`, `src/app/state/AppContext.tsx:129-138` | `handleSave` 先 `updateSettings` 再调用闭包中的 `saveSettings`，可能保存旧 settings；且存在把用户输入 API Key 放入 app state/localStorage 的路径。 | `saveSettings(nextSettings)` 显式传入最新值；演示模式不要持久化 API Key，真实 key 仅由后端保存。 |
| m2 | `src/app/pages/HistoryPage.tsx:1-5` | `useEffect/useCallback/useAppState/Filter/Loader2` 等导入未使用。 | 清理未使用导入，避免后续开启 lint/CI 后失败。 |
| m3 | `src/app/components/RightPanel.tsx:218-224` | mp3 格式下载文件名实际使用 `.wav`，用户容易误解。 | 演示音频统一标注并使用 `.wav`，或根据格式生成一致 MIME/扩展名。 |

### 安全审计结果
| 发现 | OWASP 分类 | 置信度 | 严重性 | 修复建议 |
|------|-----------|--------|--------|---------|
| 未发现硬编码 OpenRouter/OpenAI API Key 或伪 key | Sensitive Data Exposure | 95% | 通过项 | 已通过源码 grep 验证；继续保持。 |
| 用户输入 API Key 可能进入前端 state/localStorage | Sensitive Data Exposure | 85% | Minor（演示阶段） | 演示环境不要保存真实 key；生产必须后端密钥管理。 |

### 质量对比结论
| 维度 | 基准状态 | 新状态 | 对比结论 |
|------|---------|--------|---------|
| 代码质量 | 静态演示为主 | 引入 adapter/context，但 HistoryPage 仍绕过 adapter | 部分提升但存在关键断点 |
| 测试覆盖率 | 未见自动化测试脚本 | 构建通过，浏览器手工验证发现缺陷 | 维持 |
| 性能指标 | 小型 Vite 前端 | 构建产物约 315 kB JS gzip 93.84 kB | 维持 |
| 安全风险 | 曾有伪 API Key | 伪 key 已移除；仍有前端保存 key 风险 | 改善但需收口 |

### 验证命令与结果
| 命令 | 结果 |
|------|------|
| `npm run build` | 通过，Vite 6.3.5 构建成功，1622 modules transformed。 |
| `agent-browser open http://127.0.0.1:5173` | 成功打开应用。 |
| Generate 空文本校验 | 初始“生成语音”按钮 disabled，通过。 |
| Generate 正常生成 | 输入“你好，这是一次浏览器级演示生成验证。”后生成成功，RightPanel 显示成功、jobId、字符数 18、演示音频提示，通过。 |
| Generate `[error]` 错误态 | 输入“请触发 [error] 错误态”后显示 `DEMO_ERROR` 和“演示模式 -- 错误信息为模拟数据”，通过。 |
| RightPanel 错误态重试 | 点击右侧“重试”后出现字符数 0 的成功结果，不通过。 |
| Settings 测试连接 | 输入任意非空 key 后状态变“已连接”，交互可用；但文案易误导真实连接状态。 |
| Voices 探针 | 点击“探针验证”后显示“验证成功，延迟 2.4s”，通过。 |
| History 页面 | 列表显示记录，但 RightPanel 显示“暂无历史记录预览”，不通过。 |

### 浏览器验证证据
- 文本证据：历史页 body text 包含记录列表，同时包含“记录预览 / 暂无历史记录预览”。
- 文本证据：RightPanel 重试后 body text 包含“成功 ... 字符数 0 ... 演示音频，不代表真实模型输出”。
- 截图证据：`C:\Users\run.mao\.agent-browser\tmp\screenshots\screenshot-1777806141033.png`，标注了历史页列表和右侧记录预览区域。

### 正向反馈
- 原硬编码伪 API Key 已移除，API Key 输入默认空值且有安全提示。
- `TtsServiceAdapter` / `demoAdapter` 已形成未来接真实后端的初步接口边界。
- Generate/Director 输出区域均有演示模式提示，成功和错误态的右侧面板信息较完整。

### 建议下一步
打回修复以上 Major 问题后再次审核。重点先修历史数据源统一、RightPanel 重试空文本、全局 API 状态模拟标注三项。
