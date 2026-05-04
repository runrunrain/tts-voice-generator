# Phase 2 浏览器四态验收报告

生成时间：2026-05-04 19:45 UTC+8

## 结论

PASS。

Phase 2 浏览器四态验收已完成。History 与 Voices 的成功态、筛选空态、后端不可达错误态均通过浏览器验证；Director 页面提示词组装流程通过；Voices 右侧详情面板在后端不可达且 voices 为空时未再出现 `Unexpected Application Error` 或 `Cannot read properties of undefined (reading 'name')` 崩溃。

允许将 Phase 2 标记为 completed。

## 环境

- 项目路径：`D:/workpace-maorun/tts-voice-generator`
- 前端：`http://127.0.0.1:5173`
- 后端：`http://127.0.0.1:3001`
- 浏览器工具：官方 `agent-browser.cmd`，动态发现：`Get-Command agent-browser.cmd`
- 浏览器会话：`--session phase2-four-state`
- OpenRouter：未配置真实 Key，`openRouterConfigured:false`，未执行真实 OpenRouter 成功生成

预检结果：

```text
frontend_status=200
health_status=200
{"status":"ok","version":"0.1.0","openRouterConfigured":false,"providerConfigured":false,"localPluginTokenEnabled":false,"activeJobs":0}
ready_status=200
{"ready":false,"checks":[{"name":"keyConfigured","ok":false,"detail":"No API key configured in DB or env"}, ...],"realOpenRouterVerified":false}
agent-browser session list: No active sessions
```

## 验收步骤与证据

### 1. Director 初始状态

命令：

```powershell
$ab=(Get-Command agent-browser.cmd).Source
& $ab --session phase2-four-state open "http://127.0.0.1:5173/generate/director"
& $ab --session phase2-four-state snapshot -i
```

关键证据：

```text
heading "Director 模式"
Backend OK / Key missing
textbox "Type the exact transcript here..."
button "组装提示词" [disabled]
```

说明：按钮禁用是业务预期，因为 transcript 必填且当时为空，不是浏览器卡住。

### 2. Director 提示词组装

操作：填写 transcript 后点击“组装提示词”。

关键证据：

```text
textbox "Type the exact transcript here...": Host: Welcome to the voice lab. Guest: Thank you, I am ready to test the director flow.
button "组装提示词"
提示词组装结果
Request ID: aa38a0fa-6f72-4ecf-9...
heading "规范化 Speaker 信息"
heading "五要素概要"
heading "组装后的提示词"
button "确认并生成语音" [disabled]
heading "未配置 API Key"
```

结论：提示词组装成功；未配置 Key 时生成按钮禁用，未触发真实生成。

### 3. Voices 成功态

命令：

```powershell
& $ab --session phase2-four-state open "http://127.0.0.1:5173/voices"
& $ab --session phase2-four-state snapshot -i
```

关键证据：

```text
heading "音色管理"
Backend OK / Key missing
button "全部 (30)"
Zephyr默认当前选中
Puck
Charon
...
heading "音色详情"
heading "Zephyr"
```

结论：Voices 成功加载 30 个音色，右侧详情面板正常显示选中音色。

### 4. Voices 筛选空态

操作：在搜索框输入 `zzzz-no-such-voice`。

关键证据：

```text
textbox "搜索音色...": zzzz-no-such-voice
没有匹配的音色
尝试调整筛选条件
```

DOM 确认证据：

```text
voices_empty_present=true
```

结论：筛选空态展示正确。

### 5. History 成功态

命令：

```powershell
& $ab --session phase2-four-state open "http://127.0.0.1:5173/history"
& $ab --session phase2-four-state snapshot -i
```

关键证据：

```text
heading "历史记录"
Backend OK / Key missing
textbox "搜索记录..."
这是一段无 Key 错误态验证文本
Puck错误: MISSING_API_KEY
你好，这是无 Key 状态审核测试。
test textalloy错误: MISSING_API_KEY
testZephyr错误: MISSING_API_KEY
heading "记录预览"
button "查看完整详情 →"
```

结论：History 成功态展示当前 DB 历史记录。历史记录均为无 Key 错误态数据，符合当前环境。

### 6. History 筛选空态

操作：在搜索框输入 `zzzz-no-history-record`。

关键证据：

```text
textbox "搜索记录...": zzzz-no-history-record
wait --text "暂无匹配的历史记录" 成功
history_empty_present=true
```

结论：筛选空态展示正确。

### 7. 后端不可达错误态

后端临时停止：

```text
stopping_backend_pid=35292
backend_still_listening=false
```

#### History 后端不可达

关键证据：

```text
heading "历史记录"
Backend: unreachable
加载历史记录失败
API Error 500:
button "重试"
暂无历史记录预览
127.0.0.1:5173
后端不可达
历史记录: 0
```

结论：History 后端不可达错误态正确展示，带重试入口。

#### Voices 后端不可达与 RightPanel 防崩溃

关键证据：

```text
heading "音色管理"
Backend: unreachable
button "全部 (0)"
加载音色列表失败
API Error 500:
button "重试"
heading "音色详情"
加载音色列表失败
API Error 500:
button "重试"
127.0.0.1:5173
后端不可达
历史记录: 0
```

未出现：

```text
Unexpected Application Error
Cannot read properties of undefined (reading 'name')
```

结论：RightPanel 修复有效。voices 为空且后端不可达时，主列表与右侧详情面板都进入错误态，不再崩溃。

### 8. 后端恢复

恢复命令：

```powershell
Start-Process -FilePath "node" -ArgumentList "server/dist/index.js" -WorkingDirectory "D:/workpace-maorun/tts-voice-generator"
```

关键证据：

```text
started_backend_pid=40252
health_status=200
{"status":"ok","version":"0.1.0","openRouterConfigured":false,"providerConfigured":false,"localPluginTokenEnabled":false,"uptime":0,"activeJobs":0}
```

浏览器恢复证据：

```text
heading "音色管理"
Backend OK / Key missing
button "全部 (30)"
heading "Zephyr"
```

## 浏览器环境卫生

开始前：

```text
agent-browser session list: No active sessions
```

过程中发现并处置的问题：

- 一次无 `--session` 的默认会话命令会创建 `default` session，属于污染风险。
- 已清理默认会话后改用固定 named session：`phase2-four-state`。
- 后续所有正式验证均使用 `--session phase2-four-state`。

结束清理：

```text
close --all --json: {"closed":1,"sessions":["phase2-four-state"],"success":true}
session list text retry: No active sessions
session list json retry: {"success":true,"data":{"sessions":[]}}
agent-browser managed residual processes: none
```

未清理用户级 Edge WebView 或系统 Chrome 进程，避免影响非测试进程。

## 问题与处置

| 问题 | 影响 | 处置 |
|------|------|------|
| 默认 session 污染风险 | 可能导致后续 snapshot 等待旧页面或旧 CDP 状态 | 清理后固定使用 `--session phase2-four-state` |
| Director 初始 `组装提示词` 禁用 | 非缺陷 | 填写必填 transcript 后按钮启用并组装成功 |
| 后端不可达时 Vite 代理返回 API Error 500 | 当前前端错误展示契约 | History/Voices 均正确显示错误态与重试入口 |

## 未执行项

- 未读取真实 API Key 文件。
- 未执行真实 OpenRouter 成功生成。
- 未执行音色探针或试听，避免触发真实 OpenRouter 调用。
- 未执行 Phase 4 真实 smoke；仍保留为 Phase 4/P0 门禁。

## Phase 2 完成判定

Phase 2 浏览器四态验收通过。结合此前静态复审 PASS 与测试门禁结果，建议将 Phase 2 标记为 completed，并进入 Phase 4：MVP 质量门禁与真实 OpenRouter smoke 准备。
