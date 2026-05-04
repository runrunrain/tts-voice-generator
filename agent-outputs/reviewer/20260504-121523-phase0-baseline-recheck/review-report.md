## 审核报告

### 审核概要
| 项目 | 内容 |
|------|------|
| 审核时间 | 2026-05-04 |
| 审核轮次 | 第 1 轮 |
| 变更范围 | Phase 0 架构同步与基线复核补验；未修改项目业务代码 |
| 审核结论 | partial |

### Phase 0 状态结论

Phase 0 当前为 partial，不应标记 completed。架构文档与执行计划已同步到新基线，但 defaultVoice 全项目复核发现仍有新路径输出或保留 `alloy`，且 legacy alias 输入兼容未在服务层落地；真实 OpenRouter smoke test 具备后端 API 基础入口，但缺少专用自动化脚本、报告落点和 Key 注入安全操作清单。

### 问题清单

#### Critical（必须修复，阻断发布）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| 无 | - | 未发现置信度 >80% 的新增 Critical 安全问题。真实 Key 未提供，未执行真实外部调用。 | - |

#### Major（必须修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| M-01 | `server/src/routes/settings.ts:21-29`, `server/src/routes/settings.ts:107-109` | `PUT /api/settings` 接受任意 `defaultVoice` 并原样保存；如果输入 `alloy`，后续 `GET /api/settings` 会输出 `alloy`，违反“新配置统一 Zephyr，alloy 仅 legacy alias 输入兼容，不作为新配置输出”。 | 增加 canonical voice 归一化：保存 settings.defaultVoice 前将 `alloy` 映射为 `Zephyr`，并对未知音色做候选校验或明确错误；GET 不输出 `alloy` 作为新默认。 |
| M-02 | `server/src/routes/tts.ts:65-161`, `server/src/services/openrouter-provider.ts:67-75`, `server/src/routes/voices.ts:62-76` | `alloy` legacy alias 输入兼容未落地：TTS 和 voice probe 会把 `alloy` 原样传给 OpenRouter，也会把 `generation_job.voice` 记录为 `alloy`。这既不是兼容映射，也可能导致真实上游调用失败。 | 在服务层统一处理 alias：请求入口可接受 `alloy`，但调用 OpenRouter 前映射为 `Zephyr`；历史快照可保留原始输入字段，同时新增 canonicalVoice 或 metadata 标明 legacy alias。 |
| M-03 | `src/app/pages/DirectorPage.tsx:26`, `src/app/pages/DirectorPage.tsx:30`, `src/app/pages/DirectorPage.tsx:78` | Director 新建 Speaker 和后端音色未加载时的 fallback 仍默认 `alloy`，属于新 UI 配置输出。 | 将新建 speaker 默认 voice 改为 `Zephyr` 或当前 settings.defaultVoice；fallback 音色列表改为 Gemini 官方候选且以 `Zephyr` 开头；如展示 `alloy`，必须标为 legacy alias 且只用于历史兼容。 |
| M-04 | `src/app/pages/VoicesPage.tsx:12`, `src/app/pages/GeneratePage.tsx:27`, `src/app/services/demoAdapter.ts:38-53` | Voices 初始选中、Generate fallback、demoAdapter 默认与历史样例仍使用 `alloy`。虽然 demoAdapter 当前未被 AppContext 主路径引用，但全项目复核要求下仍会误导默认音色基线。 | 将新 fallback/default/demo 示例改为 `Zephyr`；如果保留旧演示历史，应显式标为 legacy alias，不作为新默认。 |
| M-05 | 项目脚本与文档 | 未发现真实 OpenRouter smoke 专用脚本或一键命令；现有 `POST /api/settings/test` 只验证 `/models`，不能完成短 MP3 生成、文件、历史、播放/下载、`X-Generation-Id` 全链路报告。 | 增加受控 smoke 脚本或命令文档，使用环境变量或后端 settings 注入 Key，自动执行 health/settings/test/tts/history/audio 校验并输出脱敏报告。 |

#### Minor（建议修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| m-01 | `src/app/pages/HistoryPage.tsx:116-121` | 历史筛选固定列出 `alloy/nova/echo/shimmer` 等旧音色，未标注 legacy，也不从后端 voice catalog 动态生成。 | 历史筛选从后端音色与历史聚合动态生成；`alloy` 仅在历史数据存在时显示为 legacy alias。 |
| m-02 | `package.json:10`, root devDependencies | 根脚本 `npm run server:build` 调用根目录 `tsc`，但根 devDependencies 未安装 TypeScript，导致构建门禁脚本失败。server 子项目内 `npm run build` 可通过。 | 根脚本改为 `npm run build --prefix server` 或在根 devDependencies 声明 TypeScript，保证计划中的一键门禁可用。 |

### defaultVoice / alloy / Zephyr 复核证据

| 区域 | 证据 | 结论 |
|------|------|------|
| DB schema | `server/src/db/schema.ts:19-21`、`server/src/db/index.ts:54` 默认 `default_voice` 为 `Zephyr` | 符合新默认要求 |
| Seed | `server/src/db/seed.ts:20-51` 30 个 Gemini voice，`Zephyr` 为 `source=default` | 符合新默认要求 |
| Settings GET 默认 | `server/src/routes/settings.ts:37-47` 无 row 时返回 `defaultVoice: "Zephyr"` | 符合新默认要求 |
| Settings PUT/GET 已存值 | `server/src/routes/settings.ts:107-109` 原样保存 defaultVoice，`server/src/routes/settings.ts:72-74` 原样输出 | 不符合，输入 `alloy` 会成为新配置输出 |
| 前端 AppContext 默认 | `src/app/state/AppContext.tsx:141-145` 默认 `defaultVoice: "Zephyr"` | 符合新默认要求 |
| Generate fallback | `src/app/pages/GeneratePage.tsx:24-28` 后端 voices 未加载时 fallback 以 `alloy` 开头 | 不符合新 fallback 输出要求 |
| Director speaker | `src/app/pages/DirectorPage.tsx:29-31` 与 `src/app/pages/DirectorPage.tsx:74-79` 新建 speaker 使用 `alloy` | 不符合新配置输出要求 |
| Voices selected | `src/app/pages/VoicesPage.tsx:12` 初始选中 `alloy` | 不符合新默认显示要求 |
| Provider alias | `server/src/services/openrouter-provider.ts:67-75` 原样发送 voice | legacy alias 未实现映射 |

### 真实 OpenRouter smoke 前置清单

| 检查项 | 当前证据 | 结论 |
|--------|----------|------|
| 可用基础入口 | `server/src/routes/settings.ts:136-165` 有 `POST /api/settings/test`；`server/src/routes/tts.ts:49-263` 有 `POST /api/tts/generate`；`server/src/routes/history.ts` 有 history/audio 查询 | 基础 API 具备 |
| 可用脚本/命令 | `package.json` 只有 dev/build/test/server 脚本；未发现 smoke 专用脚本；文档只列验收标准 | 不完备 |
| Key 注入方式 | `server/src/config/env.ts:23-31` 支持 `.env` 或进程环境 `OPENROUTER_API_KEY`；`server/src/routes/settings.ts:83-131` 支持 `PUT /api/settings` 后端加密保存；`server/src/services/key-resolver.ts:21-47` DB-first、env fallback | 具备两种注入路径 |
| Key 泄露防护 | `GET /api/settings` 只返回 `hasOpenRouterApiKey/keyMask`；`OpenRouterProvider` 只在服务端设置 Authorization；启动日志只输出 yes/no | 设计基本合格；但 smoke 脚本必须避免打印 Key |
| 报告记录位置 | 项目已有 `agent-outputs/`；执行计划要求每阶段报告，但没有 smoke 专属报告路径或模板 | 不完备，建议写入 `agent-outputs/tester/<timestamp>-openrouter-smoke/` 或同等路径 |
| 真实执行状态 | 本轮未提供真实 API Key，未执行真实外部调用 | 未验收，不得标记通过 |

### 质量对比结论
| 维度 | 基准状态 | 新状态 | 对比结论 |
|------|---------|--------|---------|
| 代码质量 | 仅复核，不改业务代码 | 发现 defaultVoice alias 缺口 | 维持，未改代码 |
| 测试覆盖率 | 后端已有 44 项测试 | 本轮复跑 44/44 通过 | 维持 |
| 性能指标 | 未测真实外部 API | 未执行真实 API smoke | 待验证 |
| 安全风险 | Key 后端存储和脱敏基础存在 | smoke 脚本缺失，未泄露真实 Key | 无新增，仍需最终扫描 |

### 验证命令与结果
| 命令 | 结果 | 说明 |
|------|------|------|
| `npm run build` | PASS | 前端 Vite production build 通过，1622 modules transformed |
| `npm test` | PASS | server vitest：3 files / 44 tests passed |
| `npm run server:build` | FAIL | 根脚本调用 `tsc -p server/tsconfig.json`，根目录缺少 `tsc` 可执行文件：`'tsc' 不是内部或外部命令` |
| `npm run build`（workdir: `server/`） | PASS | server 子项目 TypeScript build 通过 |
| `npm run typecheck`（workdir: `server/`） | PASS | server 子项目 `tsc --noEmit` 通过 |

### 正向反馈

- DB schema、schema 初始化、seed 和 AppContext 已把新默认值切到 `Zephyr`，说明架构方向已落地到核心基线。
- KeyResolver 已形成 DB-first + env fallback，GET settings 也没有返回明文 Key，满足 smoke 前置中的密钥隔离基础。
- 后端测试覆盖 settings、tts、audio security 三组核心路径，本轮复跑全部通过。

### 建议下一步

1. 将本轮 Major 清单交由后续编码修复：统一 canonical voice 映射、settings 保存归一化、前端新默认/fallback 改为 `Zephyr`，并明确 `alloy` legacy 展示。
2. 增加真实 OpenRouter smoke 自动化脚本与脱敏报告模板；在真实 Key 可用时执行短 MP3 生成、文件/历史/audioUrl/下载头/`X-Generation-Id` 全链路验证。
3. 修复根目录 `server:build` 门禁脚本，使执行计划中的自动化命令从根目录可稳定运行。
