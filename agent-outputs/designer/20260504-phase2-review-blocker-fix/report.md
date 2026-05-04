# Phase 2 谛听审核阻塞修复报告

> 执行者：洛神（designer）
> 日期：2026-05-04
> 任务类型：前端代码修复（Major 阻塞）

---

## 概要

| 项目 | 内容 |
|------|------|
| 任务 | 修复 Phase 2 谛听审核发现的 4 个 Major + 1 个 Minor 阻塞项 |
| 变更范围 | 4 个文件 |
| 设计方向 | 错误不再静默吞掉，请求防乱序，四态完整化，TDZ 修复 |

---

## Major 修复说明

### Major-1: httpAdapter.listHistoryAsync/listVoicesAsync 不再静默吞错

**问题**：`httpAdapter.listHistoryAsync` 和 `httpAdapter.listVoicesAsync` 内部 try-catch 在失败时返回空数组（`[]` 或 `{ records: [], totalPages: 1 }`），导致 AppContext 的 `.then()` 永远走到成功分支，catch 块永远不触发，`historyError` 永远不会被设置。

**修复**：移除两个方法的 try-catch 包装，让 `apiFetch` 抛出的异常自然向上传播到 AppContext 的 `.catch()` 处理，确保 `historyError`/`voicesError` 能被正确设置。

### Major-2: refreshHistory/loadVoices 请求防乱序

**问题**：当用户快速切换 history filter 或快速触发 voices 刷新时，多个并发请求可能乱序返回。先发出的慢请求后返回会覆盖新请求的正确结果，导致界面显示过期数据。

**修复**：AppContext 新增 `historyRequestIdRef` 和 `voicesRequestIdRef`（useRef 递增计数器）。每次调用时递增 requestId，回调中校验 `requestId === ref.current`，只有最后一次请求可更新 state。先到的过期请求被静默丢弃。

### Major-3: VoicesPage TDZ 崩溃

**问题**：VoicesPage 中 `voicesLoaded` useState 在第 23 行声明，但第 17 行的 useEffect 就引用了它。JavaScript 的 TDZ（Temporal Dead Zone）机制意味着 const/let 声明前的引用会抛出 ReferenceError。虽然 React hooks 的实际运行顺序可能不触发此问题（useState 在首次渲染时就执行），但这是一个代码正确性缺陷。

**修复**：完全移除 VoicesPage 内部的 `voicesLoading`/`voicesLoaded` 状态，改为从 AppContext 统一获取 `voicesLoading`/`voicesError`/`voicesLoaded`/`refreshVoices`。状态管理集中化，消除 TDZ 风险。

### Major-4: voices 四态完整化 + 移除不安全 3 秒兜底

**问题**：
1. 原代码 voices API 失败被 catch 静默吞掉，返回空数组，用户永远看不到错误。
2. 3 秒 setTimeout 兜底会在 3 秒后将 `voicesLoaded` 设为 true，即使后端返回了错误也会显示"空列表"而非错误信息，掩盖了真实错误。

**修复**：
1. AppContext 新增 `voicesLoading`/`voicesError`/`voicesLoaded`/`refreshVoices` 四个状态，通过 context 暴露。
2. `loadVoices` 使用与 `refreshHistory` 相同的 requestId 防乱序模式。
3. VoicesPage 展示完整四态：
   - 首次加载中（spinner，仅在 `voicesLoading && !voicesLoaded` 时显示）
   - 首次加载失败（错误图标 + 消息 + 重试按钮，仅在 `voicesError && !voicesLoaded` 时显示）
   - 后端返回空数组成功（空态提示 + 配置建议，仅在 `voicesLoaded && voices.length === 0 && !voicesError` 时显示）
   - 筛选无匹配（调整筛选提示）
4. 移除不安全的 3 秒 setTimeout 兜底。

---

## Minor 修复说明

### Minor-5: HistoryPage 异步加载后自动选中第一条

**修复**：新增 `useEffect`，当 `activeRecord` 为空且 `historyRecords` 有记录时，自动 `setActiveRecord(historyRecords[0].id)`。确保用户首次进入 HistoryPage 或清除筛选后能看到右侧面板有选中状态。

---

## 代码变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/app/services/httpAdapter.ts` | 修改 | `listVoicesAsync` 移除 try-catch，异常自然抛出；`listHistoryAsync` 移除 try-catch，异常自然抛出 |
| `src/app/state/AppContext.tsx` | 修改 | AppState 新增 voicesLoading/voicesError/voicesLoaded/refreshVoices；新增 loadVoices 函数含 requestId 防乱序；refreshHistory 新增 requestId 防乱序；context value 暴露新增字段 |
| `src/app/pages/VoicesPage.tsx` | 修改 | 移除本地 voicesLoading/voicesLoaded useState 和 3 秒兜底 setTimeout；从 AppContext 获取 voicesLoading/voicesError/voicesLoaded/refreshVoices；新增首次加载失败态（错误图标+消息+重试）；新增后端返回空数组成功态（配置建议）；新增 AlertCircle/RefreshCw 图标 import |
| `src/app/pages/HistoryPage.tsx` | 修改 | 新增 useEffect 自动选中第一条记录（当 activeRecord 为空且 historyRecords 有数据时）；新增 useEffect import |

---

## 自测报告

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 构建通过 | PASS | `npm run build` 1622 modules, 0 error, 1.92s |
| 后端测试 | PASS | `npm test` 161/161 tests passed, 6 test files |
| server:build | PASS | `npm run server:build` tsc 编译无错误 |
| server typecheck | PASS | `npm run typecheck` tsc --noEmit 无错误 |
| TDZ 修复 | PASS | voicesLoaded 不再在 VoicesPage 中声明，全部从 AppContext 获取 |
| 错误传播 | PASS | httpAdapter 不再吞错，AppContext catch 可正确设置 error state |
| 请求防乱序 | PASS | historyRequestIdRef 和 voicesRequestIdRef 递增校验 |
| 四态完整 | PASS | VoicesPage 有 loading/error/empty/filter-empty/data 五种渲染路径 |
| 3 秒兜底移除 | PASS | 不再有不安全 setTimeout |

---

## 遗留

1. 真实 OpenRouter smoke test 未执行 -- Phase 4/P0 门禁，不属本轮修复范围。
2. 浏览器 E2E 验证未执行 -- 需浏览器真实交互验证四态渲染效果，不属本轮代码修复范围。
3. Git 未提交 -- 等待谛听复审通过后再提交。

---

## 建议下一步

- 谛听（reviewer）复审本轮 4 个 Major 修复
- 浏览器验证 Phase 2 四态渲染效果
- Phase 4 真实 OpenRouter smoke test（P0 门禁）
