<div align="center">

# TTS Voice Generator

**本地优先的 AI 语音生成桌面应用，将文本、对白和生产列表转换为可播放、可下载的语音文件**

[![Version](https://img.shields.io/badge/version-0.0.2-blue)](https://github.com/runrunrain/tts-voice-generator/releases/tag/v0.0.2)
[![License](https://img.shields.io/badge/license-Proprietary-lightgrey)](#许可证)
[![React](https://img.shields.io/badge/React-18.3-61DAFB?logo=react)](https://react.dev)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js)](https://nodejs.org)
[![Electron](https://img.shields.io/badge/Electron-31-47848F?logo=electron)](https://www.electronjs.org)

[下载](#下载桌面应用) | [快速开始](#快速开始) | [开发者指南](#开发者指南) | [安全说明](#安全说明)

</div>

---

## 功能特性

- **文本转语音**：通过 OpenRouter Gemini TTS 生成 WAV 音频。
- **任务工作流**：从需求文档生成生产列表，支持版本管理、导入导出和批量生成。
- **导演模式**：按角色组织多说话人脚本，适合对白、旁白和场景化语音。
- **音色管理**：浏览、验证并复用不同 voice profile。
- **生成历史**：记录任务状态、费用估算、错误信息和音频文件，支持回放与下载。
- **Agent 审批流程**：为外部 Agent 提供受控 API，支持逐次确认和会话自动批准。
- **OpenCode 管理**：在可信本机环境中检测、安装和安全编辑 OpenCode 配置。
- **桌面优先**：Electron 应用内嵌 Hono 服务和 React 前端，用户数据保存在本机目录。

---

## 快速开始

### 下载桌面应用

普通用户请优先下载桌面安装包，不需要先部署源码：

- **GitHub Release**：[v0.0.2](https://github.com/runrunrain/tts-voice-generator/releases/tag/v0.0.2)
- **macOS Apple Silicon**：下载 `.dmg`，打开后将 `TTS Voice Generator.app` 拖入 `Applications`。
- **Windows x64**：下载 `Setup.exe`，按安装向导完成安装。
- **校验文件**：下载同一 Release 中的 `SHA256SUMS.txt`，用于核对安装包完整性。

GitHub 自动生成的 Source code zip/tar.gz，以及项目脚本生成的 `tts-voice-generator-v*.tar.gz`，只适合开发者检查、构建或部署源码，不是普通用户的一键安装包。

当前桌面安装包未签名、未公证。macOS 首次打开可能出现 Gatekeeper 提示；Windows 可能出现 SmartScreen 提示。请只从本项目 GitHub Release 下载，并在确认校验和后继续使用。校验和只能证明文件完整性，不能替代代码签名。

### 首次使用

1. 安装并打开桌面应用。
2. 进入 `Settings`，保存自己的 OpenRouter API Key，并使用连接测试确认可用。
3. 进入 `Tasks`，新建语音生产任务。
4. 导入或粘贴需求文档，使用 Agent/Normalize 流程生成生产列表。
5. 检查文本、说话人、音色和备注，确认无误后开始生成语音。
6. 到 `History` 播放或下载生成的音频文件。

不要把 API Key 写进 README、截图、日志、命令参数或 Agent 输出。界面和诊断信息只应显示掩码或脱敏结果。

### 环境要求

| 使用方式 | 要求 |
| --- | --- |
| macOS 桌面版 | Apple Silicon 设备，使用 `.dmg` 安装包 |
| Windows 桌面版 | Windows x64，使用 `Setup.exe` 安装包 |
| 源码开发 | Node.js 20 及以上，npm 10 及以上 |
| 真实语音生成 | 可用的 OpenRouter API Key |

---

## 使用说明

### 任务状态

| 状态 | 含义 |
| --- | --- |
| 草稿 | 任务刚创建，内容还不完整 |
| 就绪 | 已有需求文档或生产列表，可以继续处理 |
| 生产中 | 已开始生成，部分语音可能已经完成 |
| 阻塞 | 任务被标记为暂不能继续，需要先处理问题 |
| 完成 | 生产列表中的语音都已成功生成 |
| 失败 | 至少有语音行生成失败，需要查看错误并重试 |

### 数据保存位置

- 桌面版数据保存在系统 userData 目录，例如 macOS 的 `~/Library/Application Support/TTS Voice Generator/`。
- Web/Node 运行默认使用项目内 `data/` 保存数据库和音频。
- 不要手动删除 userData 或 `data/`。这些目录保存 SQLite 数据库、生成音频、部署备份和用户设置，误删会造成历史记录和配置丢失。

### OpenCode 管理

`Settings` 页面包含 OpenCode 管理面板，可用于本机 OpenCode 能力检测、配置读取、配置写入、打开配置文件和受控安装。

配置路径规则：

- 如果 `XDG_CONFIG_HOME` 是绝对路径，使用 `$XDG_CONFIG_HOME/opencode/opencode.json`。
- 否则使用 `~/.config/opencode/opencode.json`。

安全边界：

- 只有桌面版，或显式启用本机能力的可信 loopback 请求，才能读写 OpenCode 配置。
- 远程访问、非本机 Host、非本机 Origin 或可疑 forwarded header 会禁用本地 OpenCode 能力。
- Web 开发模式默认不启用本机 OpenCode 能力；需要通过环境变量 `OPENCODE_LOCAL_CAPABILITIES=enabled` 显式开启。
- API Key 在界面中只回显掩码，不回显明文。
- 写入配置使用 revision 校验，避免覆盖外部修改。
- 只允许安全编辑 model、provider baseURL 和 provider API Key 动作，不会重写未知高级配置。
- 受控安装需要用户确认短语 `INSTALL_OPENCODE`。

OpenCode CLI 与 TTS 服务交互时，默认连接 `http://127.0.0.1:3001`。不要把 OpenRouter API Key 传给 CLI；CLI 只需要连接 TTS 服务，Agent 端点使用独立的 local plugin token。

更多细节见 [OpenCode Agent 集成文档](docs/opencode-agent-integration.md)。

---

## 开发者指南

### 技术栈

- [React](https://react.dev) 18.3 + [Vite](https://vite.dev) 6.3 - 前端应用
- [Hono](https://hono.dev) 4.7 - Node.js 后端服务
- [Drizzle ORM](https://orm.drizzle.team) + better-sqlite3 - 本地 SQLite 数据层
- [Electron](https://www.electronjs.org) 31 - 桌面应用外壳
- OpenRouter Gemini TTS - 语音生成上游能力

### 本地开发

推荐一键启动开发环境：

```bash
npm run quickstart
```

也可以分别启动前后端：

```bash
npm run dev:all
```

默认地址：

- 前端开发服务：`http://localhost:5173`
- 后端 API：`http://localhost:3001`
- 健康检查：`http://localhost:3001/api/health`
- 就绪检查：`http://localhost:3001/api/ready`

生产构建与启动：

```bash
npm run start:all
```

生产模式下，Hono 会从 `dist/` 提供 React SPA 静态文件，并同时提供 `/api/*` 路由。

### 常用脚本

以下命令来自根目录 `package.json`：

| 命令 | 作用 |
| --- | --- |
| `npm run quickstart` | 使用 `scripts/start.js` 一键启动开发环境 |
| `npm run dev:all` | 同时启动后端 watch 和前端 Vite |
| `npm run dev` | 启动前端 Vite |
| `npm run server:dev` | 启动后端 watch |
| `npm run build` | 构建前端 |
| `npm run server:build` | 构建后端 |
| `npm run build:all` | 构建前端和后端 |
| `npm run server:start` | 启动已构建的后端生产服务 |
| `npm run start:all` | 构建前后端并启动生产服务 |
| `npm test` | 运行后端测试 |
| `npm run server:test` | 运行后端测试 |
| `npm run smoke` | 启动服务并执行冒烟检查 |
| `npm run package:release` | 打包发布归档 |
| `npm run electron:build` | 构建 Electron main/preload |
| `npm run desktop:target` | 构建当前桌面目标 |
| `npm run desktop:package:mac` | 构建当前 macOS 架构包 |
| `npm run desktop:dist:mac:x64` | 构建 macOS x64 包 |
| `npm run desktop:dist:mac:arm64` | 构建 macOS arm64 包 |
| `npm run desktop:dist:win:x64` | 构建 Windows x64 包 |
| `npm run desktop:print-electron-version` | 打印 Electron 版本 |
| `npm run deploy:current` | 执行 macOS quick deploy |

`server/package.json` 还提供服务端脚本：

| 命令 | 执行位置 | 作用 |
| --- | --- | --- |
| `npm run dev` | `server/` | 后端 watch 开发 |
| `npm run build` | `server/` | TypeScript 编译 |
| `npm run start` | `server/` | 启动 `server/dist/index.js` |
| `npm run test` | `server/` | Vitest run |
| `npm run test:watch` | `server/` | Vitest watch |
| `npm run typecheck` | `server/` | `tsc --noEmit` |

### 桌面构建与发布

桌面构建脚本：

```bash
npm run desktop:target
npm run desktop:dist:mac:arm64
npm run desktop:dist:win:x64
```

构建产物默认写入 `release/desktop/<platform>-<arch>/`，中间 staging 目录为 `dist-desktop/app-<platform>-<arch>/`。

发布自动化会在 tag `v*` 或手动触发时构建并上传 macOS DMG 与 Windows NSIS `Setup.exe`。这些安装包才是普通用户的推荐下载入口。工作流会上传安装包和对应 blockmap，并生成 `SHA256SUMS.txt` 与 `release-manifest-<version>.json`。

生成自包含源码归档：

```bash
npm run package:release
```

发布包不会包含 `.env`、`APIkey.md`、`data/`、`node_modules/`、`agent-outputs/`、`.git/`、`.opencode/` 和 `release/`。

### macOS 快速部署

快速部署入口：

```bash
npm run deploy:current
```

quick deploy 的安全边界：

- 只允许替换 `/Applications/TTS Voice Generator.app`。
- 不会静默安装系统依赖。
- 替换前会校验 bundle id，替换失败或冒烟失败时尝试从备份回滚。
- 不执行 git 命令。
- 不会删除或移动 userData 目录。

### 项目结构

```text
tts-voice-generator/
  src/                         React 前端源码
    app/                       页面、组件、状态和服务
  server/                      Hono 后端
    src/
      routes/                  API 路由
      services/                TTS、OpenRouter、OpenCode、审批、并发等服务
      db/                      Drizzle schema 和数据库初始化
      config/                  环境变量与配置
    __tests__/                 后端测试
    package.json               后端依赖与脚本
  electron/                    Electron main/preload 源码
  scripts/                     启动、打包、桌面构建、quick deploy、CLI 脚本
  docs/                        集成和参考文档
  guidelines/                  开发规范
  data/                        本地 Web 运行数据，已 gitignore
  dist/                        前端构建产物
  dist-electron/               Electron 构建产物
  dist-desktop/                桌面 staging 目录
  release/                     发布和桌面打包产物
  package.json                 根项目脚本与前端依赖
  start.bat                    Windows 一键启动脚本
```

---

## 故障排查

### 启动后打不开页面

1. 确认 `npm run quickstart` 或 `npm run dev:all` 没有报错。
2. 打开 `http://localhost:5173`。
3. 如果前端能打开但请求失败，检查 `http://localhost:3001/api/ready`。

### 端口 3001 被占用

关闭已有后端进程，或设置新的 `PORT` 后重新启动。开发环境中前端代理默认指向后端 API，需要保持地址一致。

### `/api/ready` 返回 `keyConfigured=false`

说明后端没有可用 OpenRouter API Key。到 `Settings` 页面保存 API Key，或检查本地回退配置。

### 生成失败或 OpenRouter 返回授权错误

1. 使用 `Settings` 页面测试连接。
2. 确认 API Key、账户权限、余额和模型访问权限。
3. 不要把 API Key 传给前端、CLI 或 Agent 请求。

### Agent 端点返回 401

1. 在 `Settings` 页面生成或旋转 local plugin token。
2. 确认请求带有 `Authorization: Bearer <LOCAL_PLUGIN_TOKEN>`。
3. token 被清除或旋转后，旧 token 会立即失效。

### OpenCode 管理面板不可用

可能原因：当前不是桌面版、Web 运行时未设置 `OPENCODE_LOCAL_CAPABILITIES=enabled`、请求不是可信 loopback 访问，或远程部署环境禁止访问本机 OpenCode 配置。这是安全限制，不要为了远程访问而放宽本机配置读写边界。

---

## 安全说明

- 不提交 `.env`、API Key、local plugin token、SQLite 数据库、音频文件或 userData。
- `.env.example` 只能包含占位符，不能包含真实凭据。
- Settings 接口返回敏感信息时必须保持掩码或指纹形式。
- OpenCode 配置读写只允许可信本机环境，远程环境默认禁用。
- 桌面 quick deploy 只替换应用包，不删除 userData。
- 日志、错误响应和诊断信息应保持敏感信息脱敏。
- Agent 端点需要 `Authorization: Bearer <LOCAL_PLUGIN_TOKEN>`；local plugin token 只在创建或旋转时显示一次，后端只保存 SHA-256 hash。
- 当前没有配置代码签名或公证凭据，发布说明必须继续标注 unsigned 风险；不要在仓库中提交签名证书、API Key 或其他 secret。

---

## 文档

- [OpenCode Agent 集成](docs/opencode-agent-integration.md)
- [第三方组件许可](ATTRIBUTIONS.md)

---

## 许可证

Proprietary。第三方组件许可见 [ATTRIBUTIONS.md](ATTRIBUTIONS.md)。
