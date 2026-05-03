## 设计实现报告

### 概要
| 项目 | 内容 |
|------|------|
| 任务 | 修复谛听审核发现的 3 个 Major 阻塞问题 |
| 变更范围 | 7 个文件 |
| 设计方向 | 数据流修复 + 防御性编程 + Demo 文案纠正 |

### 阻塞问题修复说明

#### Issue 1: History 数据源不一致

**问题**：`HistoryPage.tsx` 使用本地硬编码 `SAMPLE_RECORDS`，RightPanel 从 context 读取 `historyRecords`（初始为空数组，从未触发 refresh），导致历史列表有数据但右侧预览为空。

**修复**：
- **AppContext.tsx**：添加 `useEffect` 在组件挂载及 `historyFilter` 变化时自动调用 `refreshHistory()`，从 `demoAdapter.listHistory()` 加载数据。
- **HistoryPage.tsx**：完全移除本地 `SAMPLE_RECORDS`，改为从 context 读取 `historyRecords` / `historyTotalPages` / `historyFilter` / `setHistoryFilter` / `refreshHistory`。筛选通过 `setHistoryFilter` 驱动 adapter 的 `listHistory`。仅保留客户端搜索（`searchQuery`）为本地过滤。
- **RightPanel HistoryPreviewPanel**：现在从 context 的 `historyRecords` 取数据，不再为空，显示第一条成功记录的预览。添加了"演示模式"标注。

#### Issue 2: RightPanel 错误态"重试"绕过校验

**问题**：错误态重试调用 `generate({ text: "", voice, format })`，空文本传入 adapter 后生成 charCount=0 的成功结果。

**修复**：
- **AppContext.tsx**：`generate()` 函数开头增加空文本防御检查，`!req.text.trim()` 时直接设置 error 状态并返回，不调用 adapter。同时新增 `lastRequest` state，在每次成功调用 generate 前保存原始请求。
- **demoAdapter.ts**：`generateSpeech()` 开头同样增加空文本防御，返回 EMPTY_TEXT error result。
- **RightPanel.tsx**：错误态重试按钮改为使用 `lastRequest`（原始完整请求）。当 `lastRequest` 为 null 时，按钮显示"无原始请求"并禁用，提示用户返回输入区。

#### Issue 3: Demo API 状态文案误导

**问题**：TopBar 显示"API: OK"带绿色圆点、BottomBar 显示"服务运行中"、Settings 任意非空 key 显示"已连接"，均误导为真实连接。

**修复**：
- **TopBar.tsx**：改为"Demo API: simulated"，绿色圆点改为黄色（warning），暗示非真实。
- **BottomBar.tsx**：改为"演示服务（未调用真实 OpenRouter API）"，黄色圆点。"今日生成"改为"演示生成数"从 context 的 `demoTodayCount` 读取，版本号加 `-demo` 后缀。
- **SettingsPage.tsx**：连接状态"已连接"改为"演示连接已就绪（未调用真实 OpenRouter）"；测试按钮加"（模拟）"；"插件 Token"状态改为"已启用（演示）"。

### 顺带修复的非阻塞问题

| 问题 | 修复 |
|------|------|
| API Key 持久化风险 | SettingsPage `handleSave` 中不再保存明文 key，改为布尔标记 `"__filled__"` / `""` |
| 下载扩展名不一致 | RightPanel 下载使用 `.wav` 扩展名，与 demoAdapter 实际产出的 WAV blob 一致；历史预览下载按钮标注"下载 WAV (演示)" |
| 未使用导入 | HistoryPage 移除未使用的 `useEffect`、`AudioFormat` 类型导入 |

### 代码变更清单
| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/app/state/AppContext.tsx` | 修改 | 添加 useEffect 自动加载 history；添加 lastRequest state；generate() 增加空文本防御；添加 demoTodayCount |
| `src/app/services/demoAdapter.ts` | 修改 | generateSpeech() 增加空文本防御 |
| `src/app/pages/HistoryPage.tsx` | 重写 | 移除 SAMPLE_RECORDS，全部改用 context 数据源 |
| `src/app/components/RightPanel.tsx` | 修改 | 错误重试用 lastRequest；下载扩展名 .wav；历史预览加 demo 标注 |
| `src/app/components/TopBar.tsx` | 重写 | "Demo API: simulated" 文案 |
| `src/app/components/BottomBar.tsx` | 重写 | "演示服务"文案，demoTodayCount |
| `src/app/pages/SettingsPage.tsx` | 修改 | 连接状态文案、测试按钮文案、API Key 不存明文、Token 状态标注 |

### 自测报告
| 检查项 | 状态 | 说明 |
|--------|------|------|
| 构建通过 | PASS | `npm run build` 成功，0 错误 0 警告 |
| 全 7 态覆盖 | PASS | idle/loading/success/error 四态完整；error 态有重试/返回；empty text 有独立错误 |
| 视觉一致性 | PASS | 所有 Demo 标注使用统一的 text-text-tertiary 或 warning 色调 |
| 响应式适配 | N/A | 本次修改未改变布局结构 |
| 数据一致性 | PASS | HistoryPage 和 RightPanel 均从 context/historyRecords 读取，数据源统一 |

### 建议下一步
- 建议谛听（reviewer）审核本次修复的 7 个文件变更
- 如需浏览器交互验证，可启动 `npm run dev` 检查 History 右侧预览、错误重试行为、Top/Bottom/Settings 文案
