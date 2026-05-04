# 设计实现报告

## 概要

| 项目 | 内容 |
|------|------|
| 任务 | 修复设置页保存 API Key 失败（P0 stale-closure bug） |
| 变更范围 | 2 个文件 |
| 设计方向 | 纯逻辑修复，无视觉变更 |

## 根因分析

`SettingsPage.handleSave` 调用链：

```
updateSettings({ openRouterApiKey: apiKey.trim(), ... })  // 1. setSettings 异步调度
await saveSettings()                                       // 2. 立即读取旧闭包 settings
```

`updateSettings` 通过 `setSettings(prev => ...)` 调度 React 状态更新，但在同一渲染周期内 `saveSettings` 的闭包仍持有旧的 `settings` 引用。因此 PUT /api/settings 发送的是旧值（空字符串或 `***configured***`），而非用户刚输入的新 Key。

## 修复方案

### 核心变更：saveSettings 接受显式 payload

**AppContext.tsx**:
- `saveSettings(payload?: Partial<AppSettings>)` 签名新增可选参数
- 当传入 payload 时，合并为 `{ ...settings, ...payload }` 作为 PUT body 的数据源
- 过滤哨兵值 `***configured***` 和空字符串为 `undefined`，防止误覆盖后端已存的 Key
- PUT 成功后自动 GET /api/settings 刷新状态，确保 UI 展示权威的 `hasOpenRouterApiKey` / `keyMask`

**SettingsPage.tsx**:
- `handleSave` 不再调用 `updateSettings`，改为直接将表单值组装为 payload 传给 `saveSettings(payload)`
- 保存成功后清空本地 `apiKey` 状态，标记 `apiKeyMasked = true`
- 若用户未输入新 Key（空字段），检查后端实际状态决定 UI 展示

## 代码变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/app/state/AppContext.tsx` | 修改 | saveSettings 签名扩展为接受 payload；PUT 后自动 GET 刷新；过滤哨兵值 |
| `src/app/pages/SettingsPage.tsx` | 修改 | handleSave 直接传 payload 给 saveSettings，移除 updateSettings 调用 |

## 自测报告

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 构建通过 | PASS | `npm run build` 无错误 |
| PUT + GET 验证 | PASS | PUT fake key -> GET hasOpenRouterApiKey:true, keyMask:"sk-***...***cdef" |
| Health 验证 | PASS | PUT key 后 GET /api/health -> openRouterConfigured:true |
| 清空 Key 验证 | PASS | PUT openRouterApiKey:"" -> GET hasOpenRouterApiKey:false |
| 前端无 localStorage | PASS | API Key 仅暂存在组件 state，保存后清空 |

### 后端 API 验证详情

```
1. 初始状态:   GET /api/settings -> hasOpenRouterApiKey: false
2. PUT fake key: PUT /api/settings {openRouterApiKey: "sk-or-v1-fake-test-key-..."}
3. 验证保存:   GET /api/settings -> hasOpenRouterApiKey: true, keyMask: "sk-***...***cdef"
4. 验证健康:   GET /api/health   -> openRouterConfigured: true
5. 清空 Key:   PUT /api/settings {openRouterApiKey: ""}
6. 验证清空:   GET /api/settings -> hasOpenRouterApiKey: false, keyMask: null
```

## 建议下一步

谛听（reviewer）审核前端代码变更，确认 stale-closure 修复完整性。
