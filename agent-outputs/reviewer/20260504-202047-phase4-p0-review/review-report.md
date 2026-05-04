## 审核报告

### 审核概要
| 项目 | 内容 |
|------|------|
| 审核时间 | 2026-05-04 20:20:47 |
| 审核轮次 | 第 1 轮 |
| 变更范围 | 4 个目标文件（1 个源码变更，3 个新增测试） |
| 审核结论 | 不通过 |

### 问题清单

#### Critical（必须修复，阻断发布）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| - | - | 未发现 Critical 问题 | - |

#### Major（必须修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| M1 | server/__tests__/smoke-real-openrouter.test.ts:145-166, 200-277 | 无 key 场景仍有 1 个测试通过、6 个 skip，Vitest 汇总显示整个文件 passed，未生成 realOpenRouterVerified=false 的落盘报告；有 key 场景下 beforeEach 每个用例都会删除并重建 DB，但后续 job detail/audio/history 用例依赖前一用例捕获的 jobId/assetId，真实 smoke 会因为状态被清空而失败或通过空 return 绕过验证。 | 将无 key 分支改为明确写入未验证报告并让真实验证用例全部 skip，不把 suite 结果表述为真实 PASS；有 key 分支应在同一个 it 内完成生成、文件、job detail、audio、history、报告全链路验证，或移除 beforeEach DB 重置并严禁空 return。 |
| M2 | server/src/services/openrouter-provider.ts:206-217；server/src/routes/tts.ts:290-296 | 仅 errorMetadata 做字段级脱敏，errorMessage 直接来自上游 error.message 并返回给客户端/写入 job。实测当上游返回 `error.message="Bearer sk-upstream-leak-secret"` 时，响应体包含该 key 片段。安全 gate 未覆盖该路径。 | 对所有外部错误文本统一脱敏后再返回和持久化，至少覆盖 Bearer token、sk-*、api key/token/password 等模式；或对上游错误使用受控通用文案，把原始消息仅在脱敏后放入 metadata。补充覆盖 error.message、数组、camelCase/下划线敏感字段的测试。 |

#### Minor（建议修复）
| 编号 | 文件:行号 | 问题 | 修复建议 |
|------|----------|------|---------|
| m1 | server/src/index.ts:37-55；server/__tests__/security-gate.test.ts:482-538 | CORS 未给非白名单 Origin 设置 Access-Control-Allow-Origin，这一点正确；但 Hono cors 在 credentials=true 时仍会给非白名单和无 Origin 请求设置 Access-Control-Allow-Credentials，并在非白名单预检中返回 Allow-Methods/Allow-Headers。现有测试只检查 allow-origin，注释“无 CORS headers/无 allow headers”与实际不一致。 | 若策略只要求浏览器阻断，则更新注释和测试断言为“无 ACAO”；若要求非白名单完全无 CORS allow headers，则改为自定义中间件：仅白名单 Origin 才执行 cors/设置 credentials、methods、headers。 |
| m2 | server/__tests__/security-gate.test.ts:151-156,269-304 | key 检测覆盖了 `sk-` 与 `Bearer sk-`，但对 `apiKey`、`access_token`、`authorization_header`、数组内敏感值、非敏感字段中嵌入的 key 等模式覆盖不足。 | 扩展脱敏函数和测试样本，使用字段名归一化和字符串值正则脱敏双层防护。 |
| m3 | server/__tests__/smoke-real-openrouter.test.ts:324-330 | smoke 报告路径使用 `process.cwd()/agent-outputs/...`；在 `npm test --prefix server` 或 server 目录运行时会落到 `server/agent-outputs/...`，不一定是项目根 `agent-outputs/tester/...`。 | 明确报告根路径，使用项目根解析或可配置 `PROJECT_META_ROOT`，无 key/有 key 都写入结构化报告。 |
| m4 | server/__tests__/data-consistency.test.ts | 数据一致性测试真实走路由、DB 和文件系统，且使用 os.tmpdir 隔离，不会污染项目 data 目录；但未覆盖“文件写入成功后 DB 更新/asset 插入失败”导致可见 mp3 孤儿文件的故障注入场景。 | 增加针对 writeAudioFile 后 DB 异常的故障注入测试，并确认失败时清理已写入的最终文件或保证 DB/file 事务一致性。 |

### 质量对比结论
| 维度 | 基准状态 | 新状态 | 对比结论 |
|------|---------|--------|---------|
| 代码质量 | CORS 开放；缺少 Phase 4 gate | CORS 收紧有效但注释/测试语义不完全准确；新增测试有 smoke 结构缺陷 | 部分提升但存在阻塞缺陷 |
| 测试覆盖率 | 未覆盖新增 gate | 新增数据一致性/security/smoke 测试；本地全量 192 passed, 6 skipped | 数量提高，但真实 smoke 有效性不足 |
| 性能指标 | 无新增性能基准 | 新增 500/network 重试测试导致部分测试较慢但可接受 | 维持 |
| 安全风险 | 存在开放 CORS 风险 | CORS ACAO 收紧；但发现上游 error.message 脱敏漏洞 | 有新增/遗留未关风险 |

### 安全审计结果
| 发现 | OWASP 分类 | 置信度 | 严重性 | 修复建议 |
|------|-----------|--------|--------|---------|
| 上游错误 message 中的 Bearer/sk-* 片段会原样进入 API 响应和 DB errorMessage | 敏感数据暴露 | 90% | Major | 对 errorMessage 与 metadata 同步脱敏，补充回归测试。 |
| 非白名单 CORS 不含 ACAO，浏览器无法读取响应；但仍带 credentials/methods/headers 等无效但误导性的 CORS 头 | 访问控制/CORS 配置 | 85% | Minor | 根据策略选择更新注释/测试或改自定义 CORS 中间件。 |

### 验证记录
| 命令 | 结果 | 说明 |
|------|------|------|
| `npm run typecheck` | PASS | tsc --noEmit 通过 |
| `npm run build` | PASS | tsc 构建通过 |
| `npx vitest run __tests__/security-gate.test.ts __tests__/data-consistency.test.ts` | PASS | 30 passed |
| `cmd /c "set OPENROUTER_API_KEY=& npx vitest run __tests__/smoke-real-openrouter.test.ts"` | PASS/UNVERIFIED | 1 passed, 6 skipped；未发真实请求，但这正暴露“无 key suite 仍 passed”的语义问题 |
| `cmd /c "set OPENROUTER_API_KEY=& npm test"` | PASS/UNVERIFIED | 9 files passed；192 passed, 6 skipped；未发真实 OpenRouter 请求 |
| 自定义 CORS header 检查 | 发现 Minor | 非白名单无 ACAO，但仍有 AC-Allow-Credentials/Methods/Headers |
| 自定义上游错误 message 脱敏检查 | 发现 Major | `leaksUpstreamSecret=true`；未读取真实 secret，未发真实请求 |

### 正向反馈
- CORS 白名单覆盖 localhost/127.0.0.1 的 5173/5174，本地前端开发主路径可用；非白名单未获得 Access-Control-Allow-Origin，浏览器读取被阻断。
- 数据一致性测试不是纯 mock：请求走 Hono 路由，断言了 SQLite 记录、audio_asset、sha256、文件存在和 /api/audio 读取；使用临时 DB/audio 目录，未污染真实 data 目录。
- 安全 gate 已覆盖 GET settings、history/job detail、health、常见 upstream metadata 敏感字段，以及白名单/非白名单/预检 CORS 基础行为。

### 建议下一步
结论为不通过。请先修复 Major 问题 M1/M2，并补充对应回归测试后再复审。真实 OpenRouter smoke 在没有 Key 的环境中仍只能标记为未验证，不能作为真实链路 PASS。
