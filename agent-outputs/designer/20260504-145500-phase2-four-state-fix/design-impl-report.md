# Phase 2 前端四态修复 -- 设计实现报告

## 概要

| 项目 | 内容 |
|------|------|
| 任务 | Phase 2：前端真实 API 四态验收 -- 代码修复与文档回填 |
| 变更范围 | 3 个文件修改（AppContext, HistoryPage, VoicesPage），1 个文档更新（执行计划） |
| 设计方向 | 四态全覆盖，错误不静默吞掉，加载/错误/重试交互完整 |

## 设计决策

1. **AppContext 新增 historyLoading/historyError**：refreshHistory 在 API 调用期间设置 loading=true，失败时设置 error 消息，不再 catch 后静默忽略。保留 stale 数据不 wipe，允许 inline 错误 banner。
2. **HistoryPage 四态分支渲染**：loading（无数据时 spinner 全屏）-> error（无数据时全屏错误+重试按钮）-> 空态 -> 筛选空态 -> 成功列表。有 stale 数据时叠加 inline 错误 banner 和刷新指示器。
3. **VoicesPage 加载超时兜底**：原逻辑仅在 voices.length > 0 时设 loaded=false 会卡死，新增 3 秒超时兜底 + voicesLoaded 独立状态。
4. **不破坏现有四态**：Generate/Director/HistoryDetail/Settings 页面已有完整四态，仅做确认无缺口，不修改。
5. **不配置真实 API Key**：错误态通过 MISSING_API_KEY 或本地后端不可达验证，真实成功生成留 Phase 4。

## 代码变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/app/state/AppContext.tsx` | 修改 | AppState 新增 historyLoading/historyError/clearHistoryError；refreshHistory 设置 loading/error 状态；context value 暴露新字段 |
| `src/app/pages/HistoryPage.tsx` | 修改 | 新增 import (Loader2, AlertCircle, RefreshCw)；消费 historyLoading/historyError/clearHistoryError；四态渲染：loading spinner、error 全屏+重试、inline error banner+重试、inline 刷新指示器 |
| `src/app/pages/VoicesPage.tsx` | 修改 | 修复加载超时：新增 voicesLoaded 状态 + 3 秒 setTimeout 兜底，防止后端返回空数组时卡死 |
| `D:/workpace-maorun/Database/AI技术/AI语音生成工具/Gemini-OpenRouter-TTS-Web项目后续开发执行计划.md` | 修改 | Phase 2 状态更新为"代码修复完成/待浏览器验收"；新增 Phase 2 代码修复记录表格；变更日志+版本号+最后更新 |

## 自测报告

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 前端构建通过 | PASS | `npm run build` 1622 modules, 0 error |
| 后端测试通过 | PASS | 161/161 tests passed |
| Server typecheck | PASS | `npm run typecheck --prefix server` 零错误 |
| Server build | PASS | `npm run server:build` 零错误 |
| HistoryPage 加载态 | 代码就绪 | historyLoading=true + 无 stale 数据时显示 spinner，需浏览器验证 |
| HistoryPage 错误态 | 代码就绪 | historyError 非 null 时显示错误+重试按钮，需浏览器验证 |
| HistoryPage inline 刷新 | 代码就绪 | 有 stale 数据 + loading/error 时显示 inline 指示器，需浏览器验证 |
| 现有四态不破坏 | 确认 | Generate/Director/Voices/HistoryDetail/Settings 已有四态无修改 |
| API Key 不暴露 | 确认 | 未读取/配置/硬编码任何 API Key |

## 浏览器验收建议

以下场景需浏览器真实交互验证（使用 agent-browser 或手动）：

1. **HistoryPage 加载态**：后端未启动时访问 /history，应显示 spinner 后切换为错误态+重试按钮
2. **HistoryPage 错误重试**：点击"重试"按钮应重新调用 API
3. **HistoryPage inline 刷新**：有历史记录后，断开后端，切换筛选，应显示 inline 错误 banner
4. **VoicesPage 加载态**：首次访问应显示 spinner，后端不可达时 3 秒后显示空态
5. **GeneratePage 错误态**：无 API Key 时点击生成，应显示 NETWORK_ERROR 或 MISSING_API_KEY 错误
6. **DirectorPage assemble 错误**：后端不可达时点击"组装提示词"，应显示组装失败错误+返回编辑按钮
7. **SettingsPage 连接测试**：无 Key 时点击测试连接，应显示"连接失败"

## 遗留风险

| 风险 | 影响 | 应对 |
|------|------|------|
| 浏览器验收未执行 | Phase 2 无法标 completed | 需 agent-browser 或手动验证上述场景 |
| 谛听审核未完成 | 代码质量未独立验证 | 需谛听（reviewer）审核 AppContext 和 HistoryPage 变更 |
| 真实 OpenRouter smoke 未执行 | MVP P0 门禁未通过 | 属于 Phase 4 范围，不阻塞 Phase 2 标记 |
| HistoryPage 的 activeRecord 依赖 historyRecords[0] | 首次加载 records 为空时 activeRecord 为空字符串 | 非新增问题，不影响功能，建议后续修复 |
| VoicesPage 3 秒超时为硬编码 | 用户可能在慢网络下提前看到空态 | 低风险，可在 Phase 6 优化为更智能的加载策略 |

## 建议下一步

1. 浏览器验收 Phase 2 四态（使用 agent-browser）
2. 谛听（reviewer）审核代码变更
3. 进入 Phase 4 MVP 质量门禁（真实 OpenRouter smoke）
