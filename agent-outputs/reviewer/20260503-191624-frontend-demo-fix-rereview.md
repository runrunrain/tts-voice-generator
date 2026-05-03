## 审核报告

### 审核概要
| 项目 | 内容 |
|------|------|
| 审核时间 | 2026-05-03 |
| 审核轮次 | 复审 |
| 变更范围 | AppContext、demoAdapter、RightPanel、HistoryPage、SettingsPage、TopBar、BottomBar、GeneratePage 等 |
| 审核结论 | 通过 |

### 问题清单

#### Critical（必须修复，阻断发布）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| 无 | - | 未发现 Critical 问题 | - |

#### Major（必须修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| 无 | - | 上一轮 3 个 Major 阻塞项已复审通过 | - |

#### Minor（建议修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| M-01 | src/app/state/AppContext.tsx:157-166 / src/app/pages/SettingsPage.tsx:23-35 | saveSettings 使用当前 render 的 settings 快照，首次保存 API Key 标记时 localStorage 仍保存旧值；未保存明文，但会影响 has-key 标记持久化准确性 | 将 saveSettings 改为接收 nextSettings 参数，或在同一个 setSettings updater 中计算并持久化脱敏后的设置 |
| M-02 | src/app/components/BottomBar.tsx:9-14 | 底栏固定显示 127.0.0.1:3000，与实际 Vite 端口 5173 不一致，属于可移植性和状态准确性问题 | 改为显示 window.location.host 或更抽象的“本地演示服务” |
| M-03 | src/app/pages/HistoryPage.tsx:13,18-20 | refreshHistory 未使用；activeRecord 初始值在历史异步加载后不会自动同步 | 移除未使用变量；在 historyRecords 更新后同步默认选中项，或将选中记录提升到上下文 |

### 质量对比结论
| 维度 | 基准状态 | 新状态 | 对比结论 |
|------|---------|--------|---------|
| 代码质量 | 存在硬编码展示与分散状态 | 引入 AppContext 和 demoAdapter，生成、历史、设置状态更集中 | 提升 |
| 测试覆盖率 | 无自动化测试 | 无新增自动化测试；完成构建与浏览器交互验证 | 维持 |
| 性能指标 | 静态页面为主 | 新增少量本地状态和模拟延迟，无明显性能退化 | 维持 |
| 安全风险 | Settings 曾展示明文示例 API Key | 不再保存 API Key 明文，UI 明确提示前端不应存储真实密钥 | 无新增 |

### 安全审计结果
| 发现 | OWASP 分类 | 置信度 | 严重性 | 修复建议 |
|------|-----------|--------|--------|---------|
| 未发现需阻断的安全问题 | - | - | - | - |

### 验证证据
- 构建验证：`npm run build` 通过，Vite 完成 1622 modules transformed，产物生成成功。
- 静态代码复审：HistoryPage 使用 `useAppState()` 的 historyRecords/historyFilter；RightPanel HistoryPreviewPanel 使用 `useAppState()` 的 historyRecords；AppContext 通过 demoAdapter.listHistory 加载历史数据。
- 静态代码复审：RightPanel 错误态重试按钮调用 `generate(lastRequest)`；AppContext 与 demoAdapter 均对空白文本做防御性错误返回。
- 静态代码复审：TopBar 显示 `Demo API: simulated`，BottomBar 显示“演示服务（未调用真实 OpenRouter API）”，Settings 连接测试与状态均标注模拟/演示。
- 静态代码复审：Settings 保存 API Key 时仅写入 `__filled__` 或空字符串，未发现源码中存在 OpenRouter 明文 Key。
- 浏览器验证：正常生成成功，RightPanel 显示成功 jobId、演示提示、音色/格式/字符数/成本。
- 浏览器验证：输入 `[error]` 后进入 DEMO_ERROR 错误态；点击 RightPanel “重试”后生成新的错误 jobId，证明使用 lastRequest 重试。
- 浏览器验证：History 页面展示 3 条 demoAdapter 历史记录，RightPanel 记录预览非空，显示 demo-abc123、成功、音色/格式/字符数/成本。
- 浏览器验证：Settings 页面显示“测试（模拟）”“演示连接已就绪（未调用真实 OpenRouter）”“演示模式 -- 设置仅保存在本地会话中”。输入测试 Key 并保存后，localStorage `tts-demo-settings` 未包含明文 Key。

### 正向反馈
- 本轮修复将生成、历史、设置相关状态收敛到 AppContext/demoAdapter，解决了上一轮“左侧列表与右侧预览数据不一致/预览为空”的核心问题。
- Demo/模拟状态在 TopBar、BottomBar、Settings、RightPanel、GeneratePage 中均有明确文案，降低了误认为真实 OpenRouter 调用的风险。
- 错误态重试路径从构造空请求改为复用 lastRequest，浏览器验证表现符合预期。

### 建议下一步
通过。可进入后续提交/沉淀流程；Minor 项可在后续优化中处理，不阻断本次修复。
