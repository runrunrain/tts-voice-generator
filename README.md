# TTS Voice Generator

TTS Voice Generator 是一个本地优先的 AI 语音生成工具。它使用 OpenRouter Gemini TTS 生成语音，前端为 React/Vite，后端为 Hono，数据落在本机 SQLite。项目同时支持 Web 开发模式、生产静态托管、Electron 桌面应用打包，以及面向 OpenCode 的本机设置管理和 Agent 调用能力。

## 快速上手（普通用户）

如果你只想尽快使用工具生成语音，按下面顺序操作即可。

### 1. 安装或打开应用

- 已安装桌面版：直接打开 `TTS Voice Generator.app`，数据会保存在本机用户目录。
- macOS 快速部署：在项目根目录运行 `npm run deploy:current`，脚本会构建、替换 `/Applications/TTS Voice Generator.app`，并默认执行冒烟检查后启动应用。
- 开发模式：首次从源码运行时先执行 `npm install` 和 `npm install --prefix server`，之后用 `npm run quickstart` 一键启动前端和后端。

### 2. 首次配置 OpenRouter API Key

1. 打开应用后进入 Settings。
2. 在 OpenRouter API Key 输入框粘贴自己的 Key。
3. 点击保存，并使用连接测试确认可用于真实音频生成。

不要把 API Key 写进 README、截图、日志、命令参数或 Agent 输出。界面和诊断信息只应显示掩码或脱敏结果。

### 3. 可选配置 OpenCode

如果需要让 OpenCode 辅助整理需求并生成生产列表，可在 Settings 的 OpenCode 管理面板中操作：

- 先刷新或检测 CLI 状态。
- 未安装时，按界面提示执行受控安装。
- 需要调整模型、provider baseURL 或 provider API Key 时，使用面板保存；也可以打开 `opencode.json` 检查 JSON 配置。

OpenCode 配置读写只在桌面版或可信本机环境可用。远程 Web 环境默认不可访问本机配置。

### 4. 创建任务并生成语音

1. 进入 Tasks，新建一个语音生产任务。
2. 在任务工作区导入或粘贴需求文档。
3. 使用 Agent/Normalize 流程生成生产列表，检查每一行的文本、说话人、音色和备注。
4. 确认列表无误后开始生成语音。
5. 到 History 查看生成记录，播放或下载生成的音频文件。

常见任务状态：

| 状态 | 含义 |
| --- | --- |
| 草稿 | 任务刚创建，内容还不完整 |
| 就绪 | 已有需求文档或生产列表，可以继续处理 |
| 生产中 | 已开始生成，部分语音可能已经完成 |
| 阻塞 | 任务被标记为暂不能继续，需要先处理问题 |
| 完成 | 生产列表中的语音都已成功生成 |
| 失败 | 至少有语音行生成失败，需要查看错误并重试 |

### 5. 用户数据与问题排查

- Web/开发模式的数据通常在项目 `data/` 目录。
- 桌面版数据在系统 userData 目录，例如 macOS 的 `~/Library/Application Support/TTS Voice Generator/`。
- 不要手动删除 `data/` 或 userData；它们保存数据库、历史记录、生成音频、设置和部署备份。
- 遇到问题时，先看 Settings 里的诊断信息，再检查 OpenCode 管理面板；如果是快速部署问题，优先运行 `npm run deploy:current -- --dry-run --skip-npm-install --no-launch --no-smoke` 或 `npm run smoke` 定位基础启动问题。

## 核心能力

- 文本转语音：通过 OpenRouter Gemini TTS 生成音频，默认输出 WAV。
- 多音色管理：浏览、验证和使用不同 voice profile。
- 导演模式：按角色组织多说话人脚本，适合对白和场景化语音。
- 生成历史：记录每次生成任务、状态、费用估算、错误信息和音频文件。
- 批量与生产列表：支持需求文档 normalize、生产列表版本管理、导入导出和批量生成。
- Agent 审批流程：为外部 Agent 提供受控 API，支持每次确认和会话自动批准两种模式。
- OpenCode 设置管理：在可信本机环境下检测、安装和安全编辑 OpenCode 配置。
- 桌面应用：Electron 包内嵌 Hono 服务和 React 前端，使用本机 userData 保存数据库与音频。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | React 18、TypeScript、Vite 6、Tailwind CSS 4、Radix UI、MUI |
| 后端 | Hono 4、Node.js、TypeScript |
| 数据库 | SQLite、better-sqlite3、Drizzle ORM |
| 桌面端 | Electron 31、electron-builder、esbuild |
| TTS 服务 | OpenRouter Gemini TTS |
| Agent 集成 | OpenCode CLI subprocess、受控 Agent API |

## 运行环境

- Node.js 20 及以上，quick deploy 要求 `>=20.0.0 <23.0.0`。
- npm 10 及以上。
- OpenRouter API Key，用于真实语音生成。
- macOS 桌面快速部署需要 Xcode Command Line Tools，以及系统自带的 `hdiutil`、`open`、`osascript`、`ditto`、`plutil`、`pgrep`。
- Windows 桌面包需要在 Windows x64 环境执行对应打包命令。

## 安装依赖

项目根目录和 `server/` 各有一套依赖：

```bash
npm install
npm install --prefix server
```

如果存在 lockfile，建议在自动化或发布环境中使用：

```bash
npm ci
npm ci --prefix server
```

## 配置 API Key

首次运行前，需要配置 OpenRouter API Key。推荐通过应用的 Settings 页面保存，后端会加密写入 SQLite。也可以使用 `.env` 作为回退配置：

```bash
OPENROUTER_API_KEY=<your_openrouter_api_key>
```

安全要求：

- 不要提交 `.env`、API Key、local plugin token 或任何凭据文件。
- 不要把 API Key 写进 README、脚本参数、日志、截图或 Agent 输出。
- OpenRouter API Key 只应保存在服务器侧 `.env` 或加密后的 Settings 存储中。

## 开发启动

推荐使用一键启动脚本：

```bash
npm run quickstart
```

该命令由 `scripts/start.js` 负责启动前端和后端，并统一输出日志。Windows 用户也可以双击 `start.bat`。

也可以使用 npm scripts 分开启动：

```bash
# 同时启动 Hono 后端和 Vite 前端
npm run dev:all

# 只启动前端 Vite
npm run dev

# 只启动后端 Hono
npm run server:dev
```

默认地址：

- 前端开发服务：`http://localhost:5173`
- 后端 API：`http://localhost:3001`
- 健康检查：`http://localhost:3001/api/health`
- 就绪检查：`http://localhost:3001/api/ready`

自动化冒烟检查：

```bash
npm run smoke
```

## 生产构建与启动

构建前端和后端：

```bash
npm run build:all
```

启动生产服务：

```bash
npm run server:start
```

也可以一条命令完成构建并启动：

```bash
npm run start:all
```

生产模式下，Hono 会从 `dist/` 提供 React SPA 静态文件，并同时提供 `/api/*` 路由，不需要单独启动前端服务。

## 桌面应用构建与部署

Electron 桌面版会把后端服务限制在本机回环地址，并通过 preload bridge 注入桌面会话 token。桌面运行时的数据库和音频文件保存在操作系统 userData 目录，不在项目 `data/` 目录中。

常用命令：

```bash
# 构建 Electron main/preload 到 dist-electron/
npm run electron:build

# 构建当前平台目标
npm run desktop:target

# 构建当前 macOS 架构的桌面包
npm run desktop:package:mac

# 分架构构建 macOS 包
npm run desktop:dist:mac:x64
npm run desktop:dist:mac:arm64

# 在 Windows x64 环境构建 Windows 安装包
npm run desktop:dist:win:x64

# 打印当前 Electron 版本
npm run desktop:print-electron-version
```

平台包装脚本：

- macOS：`scripts/build-desktop.sh`
- Windows：`scripts/build-desktop.bat`

构建产物默认写入 `release/desktop/<platform>-<arch>/`，中间 staging 目录为 `dist-desktop/app-<platform>-<arch>/`。

### macOS 快速构建并部署

快速部署入口是 `scripts/quick-build-deploy.mjs`，package.json 中对应命令为：

```bash
npm run deploy:current
```

常用参数：

```bash
# 只预览计划，不安装依赖、不构建、不替换、不冒烟、不启动
npm run deploy:current -- --dry-run --skip-npm-install --no-launch --no-smoke

# 默认安全策略：安装项目依赖、构建、替换 /Applications 中的应用、冒烟、启动
npm run deploy:current

# 跳过依赖安装，替换后不启动
npm run deploy:current -- --skip-npm-install --no-launch

# 仅在明确接受 lockfile 缺失时，允许 npm install 回退
npm run deploy:current -- --allow-npm-install-fallback
```

quick deploy 的安全边界：

- 只允许替换 `/Applications/TTS Voice Generator.app`。
- 不会静默安装系统依赖；`--install-system-deps` 只打印手动安装建议。
- 默认使用 `npm ci` 安装根项目和 `server/` 依赖。
- 如果缺少 lockfile，会失败关闭，除非显式传入 `--allow-npm-install-fallback`。
- 替换前会校验 bundle id，替换失败或冒烟失败时尝试从备份回滚。
- 不执行 git 命令。
- 不会删除或移动 `~/Library/Application Support/TTS Voice Generator`。

不要手动删除 userData 目录。该目录保存桌面版 SQLite 数据库、生成音频、部署备份和用户设置，误删会造成历史记录和配置丢失。

## OpenCode 设置管理

Settings 页面包含 OpenCode 管理面板，可用于本机 OpenCode 能力检测、配置读取、配置写入、打开配置文件和受控安装。

配置路径规则：

- 如果 `XDG_CONFIG_HOME` 是绝对路径，使用 `$XDG_CONFIG_HOME/opencode/opencode.json`。
- 否则使用 `~/.config/opencode/opencode.json`。

安全边界：

- 只有桌面版，或显式启用本机能力的可信 loopback 请求，才能读写 OpenCode 配置。
- 远程访问、非本机 Host、非本机 Origin 或可疑 forwarded header 会禁用本地 OpenCode 能力。
- Web 开发模式默认不启用本机 OpenCode 能力；需要通过环境变量 `OPENCODE_LOCAL_CAPABILITIES=enabled` 显式开启。
- API Key 在界面中只回显掩码，不回显明文。
- 写入配置使用 revision 校验，避免覆盖外部修改。
- 只允许安全编辑 model、provider baseURL 和 provider API Key 动作；不会重写未知高级配置。
- 受控安装固定为 `npm install -g opencode-ai@latest`，需要用户确认短语 `INSTALL_OPENCODE`。

OpenCode CLI 与 TTS 服务交互时，`scripts/tts-agent-cli.ts` 读取 `TTS_API_URL`，默认连接 `http://127.0.0.1:3001`。不要把 OpenRouter API Key 传给 CLI；CLI 只需要连接 TTS 服务，Agent 端点使用独立的 local plugin token。

更多细节见 `docs/opencode-agent-integration.md`。

## 常用命令

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

`server/package.json` 还提供服务端开发命令：

| 命令 | 执行位置 | 作用 |
| --- | --- | --- |
| `npm run dev` | `server/` | 后端 watch 开发 |
| `npm run build` | `server/` | TypeScript 编译 |
| `npm run start` | `server/` | 启动 `server/dist/index.js` |
| `npm run test` | `server/` | Vitest run |
| `npm run test:watch` | `server/` | Vitest watch |
| `npm run typecheck` | `server/` | `tsc --noEmit` |

## 目录结构

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

## 数据与文件位置

Web/Node 运行默认使用：

```text
data/
  db/
    tts-generator.db
    tts-generator.db-wal
    tts-generator.db-shm
  audio/
    YYYY/MM/DD/{uuid}.wav
```

桌面版使用系统 userData 目录，例如 macOS：

```text
~/Library/Application Support/TTS Voice Generator/
```

`data/`、userData、`.env`、token 文件、生成音频和数据库都不应提交到版本库。

## API 与 Agent 集成

常用 API：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 基础健康检查 |
| `GET` | `/api/ready` | 就绪检查，不调用 OpenRouter |
| `GET` | `/api/diagnostics` | 诊断信息，包含脱敏后的近期错误和 Agent 操作 |
| `GET` | `/api/settings` | 读取设置，敏感字段只返回掩码或指纹 |
| `PUT` | `/api/settings` | 保存设置、旋转或清除 local plugin token |
| `POST` | `/api/settings/test` | 测试 OpenRouter 连接 |
| `POST` | `/api/tts/generate` | 生成语音 |
| `GET` | `/api/history` | 查询生成历史 |
| `GET` | `/api/audio/:assetId` | 播放或下载音频 |
| `POST` | `/api/agent/generate-speech` | Agent 发起语音生成请求 |
| `POST` | `/api/agent/approve-action` | 批准或拒绝待确认 Agent 动作 |

Agent 端点需要 `Authorization: Bearer <LOCAL_PLUGIN_TOKEN>`。local plugin token 只在创建或旋转时显示一次，后端只保存 SHA-256 hash。

## 发布归档

生成自包含发布归档：

```bash
npm run package:release
```

发布脚本会构建前后端，整理 `release/staging/`，生成 `release-manifest.json`，并创建 `release/tts-voice-generator-v<version>-<commit>.tar.gz`。

发布包不会包含：

- `.env`
- `APIkey.md`
- `data/`
- `node_modules/`
- `agent-outputs/`
- `.git/`
- `.opencode/`
- `release/`

## 故障排查

### 启动后打不开页面

1. 确认 `npm run quickstart` 或 `npm run dev:all` 没有报错。
2. 打开 `http://localhost:5173`。
3. 如果前端能打开但请求失败，检查 `http://localhost:3001/api/ready`。

### 端口 3001 被占用

关闭已有后端进程，或设置新的 `PORT` 后重新启动。开发环境中前端代理默认指向后端 API，需要保持地址一致。

### `/api/ready` 返回 `keyConfigured=false`

说明后端没有可用 OpenRouter API Key。到 Settings 页面保存 API Key，或检查 `.env` 中的 `OPENROUTER_API_KEY`。

### 生成失败或 OpenRouter 返回授权错误

1. 使用 Settings 页面测试连接。
2. 确认 API Key、账户权限、余额和模型访问权限。
3. 不要把 API Key 传给前端、CLI 或 Agent 请求。

### Agent 端点返回 401

1. 在 Settings 页面生成或旋转 local plugin token。
2. 确认请求带有 `Authorization: Bearer <LOCAL_PLUGIN_TOKEN>`。
3. token 被清除或旋转后，旧 token 会立即失效。

### OpenCode 管理面板不可用

可能原因：

- 当前不是桌面版。
- Web 运行时未设置 `OPENCODE_LOCAL_CAPABILITIES=enabled`。
- 请求不是可信 loopback 访问。
- 远程部署环境禁止访问本机 OpenCode 配置。

这是安全限制。不要为了远程访问而放宽本机配置读写边界。

### OpenCode 配置保存冲突

如果提示配置文件已被外部修改，先刷新页面重新读取配置，再保存。该机制用于避免覆盖你在编辑器或其他工具中刚刚修改的 `opencode.json`。

### quick deploy 失败

1. 先运行 dry run：

   ```bash
   npm run deploy:current -- --dry-run --skip-npm-install --no-launch --no-smoke
   ```

2. 检查 Node.js、npm、lockfile、Xcode Command Line Tools 和 macOS 系统工具。
3. 如果替换或冒烟失败，脚本会尝试从 `~/Library/Application Support/TTS Voice Generator/deploy-backups` 回滚。
4. 不要删除 userData 目录来“清理部署”，这会丢失用户数据。

### 桌面版启动后没有历史记录

确认你查看的是桌面版 userData 中的数据库，而不是项目 `data/` 目录。Web 开发模式和 Electron 桌面版的数据位置不同。

## 安全说明

- 不提交 `.env`、API Key、local plugin token、SQLite 数据库、音频文件或 userData。
- `.env.example` 只能包含占位符，不能包含真实凭据。
- Settings 接口返回敏感信息时必须保持掩码或指纹形式。
- OpenCode 配置读写只允许可信本机环境，远程环境默认禁用。
- 桌面 quick deploy 只替换应用包，不删除 userData。
- 日志、错误响应和诊断信息应保持敏感信息脱敏。

## 许可证

Proprietary。第三方组件许可见 [ATTRIBUTIONS.md](./ATTRIBUTIONS.md)。
