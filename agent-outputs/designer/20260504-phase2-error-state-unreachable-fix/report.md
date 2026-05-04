# Phase 2 VoicesPage 错误态不可达修复报告

> 执行者：洛神（designer）
> 日期：2026-05-04
> 任务类型：前端代码修复（Critical -- 错误态被空态吞掉）

---

## 概要

| 项目 | 内容 |
|------|------|
| 任务 | 修复 Phase 2 复审发现的 VoicesPage 错误态不可达问题 |
| 变更范围 | 2 个文件 |
| 设计方向 | 错误态优先于空态/成功态，与 HistoryPage 模式统一 |

---

## 问题分析

### 根因

AppContext `loadVoices` 失败路径（catch 块）同时设置 `voicesLoaded=true` 和 `voicesError`。

VoicesPage 条件链：

```
1. voicesLoading && !voicesLoaded  → loading
2. voicesError && !voicesLoaded   → error (不可达！voicesLoaded 在失败时也是 true)
3. voicesLoaded && voices.length === 0 && !voicesError  → empty
4. filteredVoices.length === 0    → no match (错误态落入此处！)
5. grid
```

条件 2 永远为 false，因为 `voicesLoaded` 在失败时为 true。错误态穿透到条件 4，显示"没有匹配的音色 - 尝试调整筛选条件"而非错误信息。

### 状态真值表验证

| 场景 | voicesLoading | voicesLoaded | voicesError | voices | 原始代码走向 | 修复后走向 |
|------|:---:|:---:|:---:|:---:|------|------|
| 首次加载中 | T | F | null | [] | loading (正确) | loading (正确) |
| 首次加载失败 | F | T | "msg" | [] | no match (错误!) | full error (正确) |
| 加载成功空列表 | F | T | null | [] | empty (正确) | empty (正确) |
| 加载成功有数据 | F | T | null | [x] | grid (正确) | grid (正确) |
| 刷新失败有旧数据 | F | T | "msg" | [x] | grid (无错误提示) | grid + inline banner (正确) |
| 重试加载中 | T | T | null | [] | empty (不佳) | loading (正确) |

---

## 修复方案

### 1. VoicesPage 条件链重构

跟随 HistoryPage 成熟模式，使用 `voices.length` 作为数据可用性判断（而非 `voicesLoaded` 标志）：

```
1. voicesLoading && voices.length === 0    → loading spinner
2. voicesError && voices.length === 0      → full-screen error + retry
3. voicesLoaded && voices.length === 0 && !voicesError → empty state
4. else (data section):
   a. voicesError && voices.length > 0     → inline error banner + retry
   b. voicesLoading && voices.length > 0   → inline loading indicator
   c. filteredVoices.length === 0           → no match
   d. grid                                  → voice cards
```

核心原则：**错误态（条件 2）基于数据有无判断，不依赖 voicesLoaded 标志**。

### 2. 新增两种 inline 模式

- **Inline error banner**：刷新失败但有旧数据时，在 grid 上方显示红色错误横幅 + 重试按钮（与 HistoryPage 样式一致）
- **Inline loading indicator**：有旧数据时刷新中，在 grid 上方显示加载指示条

### 3. AppContext docstring 更新

`voicesLoaded` 注释从"Whether voices have been loaded at least once (even if empty array)"改为"Whether voices fetch has completed at least once (success or failure; even if empty array)"，明确说明失败时也为 true。

AppContext 逻辑本身不需要修改 -- `voicesLoaded=true` 的语义是"至少完成过一次 fetch 尝试"而非"成功加载过"，这是合理的。

---

## 代码变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/app/pages/VoicesPage.tsx` | 修改 | 条件链重构：`!voicesLoaded` 改为 `voices.length === 0` 判断；新增 inline error banner 和 inline loading indicator；no-match 状态移入 data section |
| `src/app/state/AppContext.tsx` | 修改 | `voicesLoaded` docstring 更新，明确含 failure 语义 |

---

## 自测报告

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 前端构建 | PASS | `npm run build` 1622 modules, 0 error, 1.92s |
| 后端测试 | PASS | `npm test` 161/161 tests passed, 6 test files |
| Server typecheck | PASS | `npm run typecheck` (server) tsc --noEmit 零错误 |
| 错误态可达性 | 逻辑验证 | voicesError && voices.length === 0 条件在首次加载失败时为 true |
| 空态不污染 | 逻辑验证 | 成功空列表时 voicesError=null，走 voices.length === 0 && !voicesError |
| 条件链与 HistoryPage 一致 | 确认 | 两个页面使用相同模式：loading → error → empty → data+inline |
| API Key 未暴露 | 确认 | 未读取/配置/硬编码任何 API Key |

---

## 遗留

| 项目 | 状态 | 说明 |
|------|------|------|
| 浏览器 E2E 验证 | 待执行 | 需浏览器验证错误态、inline banner、loading 指示器渲染效果 |
| 真实 OpenRouter smoke | Phase 4 范围 | 不属本轮修复 |
| Git 提交 | 等待复审 | 等谛听通过后再提交 |
| VoiceStatus type import 未使用 | 低优先级 | 第 4 行 import 了 VoiceStatus 但未引用，非阻塞 |

---

## 建议下一步

1. 谛听（reviewer）复审本轮修复
2. 浏览器验证 VoicesPage 六态渲染（loading / full error / empty / inline error / inline loading / grid）
3. 清理未使用的 VoiceStatus type import（低优先级）
