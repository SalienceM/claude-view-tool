![AgentWithU](https://github.com/user-attachments/assets/5402414b-f77e-450d-b09c-f3edc51252f5)


# AgentWithU

> 一个给人用的 AI 桌面客户端——不是又一个套壳网页，是真正的原生应用。

多模型支持 · 剪贴板图片直粘 · 流式输出 · 会话持久化 · Skill 插件系统 · 可定制外观

---

## 为什么存在

市面上的 AI 客户端要么是浏览器扩展，要么是套着 Electron 的网页，要么直接就是个网页。
AgentWithU 用 PySide6 托管 QWebEngine，前端是 React，后端是 Python——
**安装一条命令，响应比网页快，图片直接从剪贴板粘进去。**

| 痛点 | AgentWithU 的解法 |
|------|-----------------|
| 截图工具的图片无法粘贴到 AI 对话框 | `QClipboard.image()` 直接读剪贴板 → PNG → base64，零中转 |
| 终端/网页 UI 太寒酸 | QWebEngine 嵌 React，Markdown 渲染 + 代码高亮 + 流式打字效果 |
| 被锁定在单一模型供应商 | `ModelBackend` 抽象层，随时切换 Claude / OpenAI 兼容 / 本地 LLM |
| 对话上下文一刷新就没了 | JSON 文件会话持久化，支持跨会话 resume，一键导出 |
| Electron 安装包 200MB 起步 | `pip install PySide6`，QWebEngine 就是 Chromium，无额外下载 |

---

## 功能一览

### 核心对话
- **剪贴板图片粘贴** — 截图完直接 Ctrl+V，支持 Snipaste / 系统截图工具
- **富消息渲染** — Markdown、代码块语法高亮、表格、任务列表
- **流式响应** — token 逐字出现，支持 thinking 块折叠展示
- **工具调用可视化** — 展示 AI 调用了哪些工具，输入输出一目了然
- **多模型后端** — Claude Agent SDK · Anthropic API · OpenAI 兼容接口（DeepSeek、本地 Ollama 等）
- **会话管理** — 多会话侧边栏，按工作目录组织，支持迁移模型，一键新建干净会话
- **权限审批** — 工具调用权限弹窗，diff 预览文件改动

### Workspace Kits（实验）
- **Session 级标准配件** — 用 🧰 入口把重复工作定义成带类型输入的 Kit，而不是散落的临时命令
- **可恢复的 Kit 优化对话** — 优化窗口仅点击关闭按钮退出，点击旁边不关闭；关闭后后台继续生成，重新打开恢复历史和真实状态。同一浏览器标签页保留未发送草稿与 Backend 选择，执行端重启导致的中断会明确提示，不会一直假装运行。
- **明确判言** — 每次执行必须有成功/失败判定；退出码、输出文本/正则、JSON、文件产物均可验收
- **手动或 Schedule** — 支持单次运行与最短 10 秒的周期执行，状态和运行历史独立持久化
- **聊天 Chain 复用** — 同一 Session 中，相同 Kit 调用顺序、输入与执行配置复用同一条聊天组合，每次新请求只新增运行记录。旧版未改造的重复链在空闲后合并卡片与历史展示，原定义、运行 ID、版本和审批记录保持不变；改过参数、顺序或任务契约的链不会按同名误合并。
- **结果视图与数据市场** — 集中查看 stdout/stderr、判言和类型化输出；其他 Kit 可用 `sourceKey` 消费最新数据
- **持久终端控制权** — Kit 可设为 AI、人工或共享控制；双方接管同一个 PowerShell/CMD/Bash，上下文保留且命令进入同一账本
- **AgentWithU 能力编排** — Kit 可通过白名单能力调用发布中心；“发布最新包”自动扫描和预检，冻结计划后默认需用户人工确认
- **单次委托确认** — 手动发送前勾选“本次允许 Kit 代确认”，可授权 Agent 核对并批准一个运行/链中的发布步骤，6 小时内有效。服务端绑定当前用户、Session、运行范围、发布配置和计划指纹；聊天正文不产生授权，队列/语音/下一次发送不继承开关，授权过期或计划/配置变化需重新授权。该能力不会自动唤醒已结束的聊天；长打包完成后可再发消息让 Agent 查询并核对，原运行授权仍在有效期内。
- **“俺寻思”注意力助手** — 全局浮动或右侧停靠，自动关联当前 Session、预览文件和设置/发布等面板；按焦点切换独立历史并复用实时语音，不污染主对话

### Skill 插件系统
- **内置 Skill 类型**
  - `web-search` — Bing 网页搜索，免费，无需配置
  - `web-fetch` — 抓取 URL 页面正文，免费，无需配置
  - `python-script` — 执行本地 Python 脚本，支持凭据（Secrets）注入，适合爬虫/API 集成
  - `dashscope-image` — 阿里云 DashScope 图像生成与编辑，支持 Wan 与 Qwen Image 3.0、1–3 张参考图
- **Skill 仓库（Repo 面板）** — 可视化创建、编辑、删除 Skill 和 Prompt
- **Agent Skills 市场** — 浏览/搜索公开 GitHub Skill 源，安装前查看来源、许可证、文件清单、`SKILL.md` 预览与风险提示
- **市场筛选与版本参考** — 按来源筛选，支持更新优先、名称、仓库 Star、仓库最近推送排序；技能版本来自作者的 `metadata.version`，未声明时展示内容指纹。仓库 Release 与技能版本分开显示，Star/推送时间属于整个仓库，不是单个 Skill 的评分。参考信息缓存 15 分钟，“刷新源”可重新获取，GitHub 限流或获取失败不影响目录与安装。
- **开放格式兼容** — 直接安装标准 Agent Skills ZIP/仓库目录，完整保留 `scripts/`、`references/`、`assets/` 等配套文件
- **旧包兼容** — 原有 `.awu` 格式继续支持，可与标准 Skill 共存
- **凭据管理** — Secrets 本地 chmod 600 存储，永不传给大模型
- **按会话绑定** — 每个 Session 独立绑定启用哪些 Skill 和 Prompt

### 便签本（ScratchPad）
- 对话过程中随手记录代码片段、临时笔记、截图
- 多条记录切换，分组时间线，支持图片块和文本块混排

### 外观 & 体验
- **紧凑桌面布局** — 顶栏、Tab、会话列表和常用面板采用更接近 IDE 的间距，减少卡片和表单留白；正文与输入字号不缩小，手机/触屏继续保留原有操作尺寸。侧栏仍可拖宽，已保存的宽度不会被覆盖。
- **工作区标签页** — 左侧纵向功能栏依次为 Session、文件、扩展；Skills 与 Prompts、扩展市场在右侧标签页打开，与对话工作区切换时保留搜索和未保存草稿，不卸载聊天。编辑中的标签页需要先保存或退出编辑才能关闭；运行环境确认、凭据、删除等操作仍使用独立确认窗口。
- **Session 快速切换 Tab** — 打开的普通会话和 LOOP 各占一个顶部标签，同一 Session 再次点击直接复用；显示名称及运行/完成状态，标签多时横向滚动，支持方向键切换。切换保留对话实例、输入草稿与滚动状态，关闭标签不删除会话、不终止当前后台任务；分屏中已有的会话直接聚焦原窗格，不重复创建。工作总览和扩展标签仍可独立使用。
- **4 套主题** — Dark / Light / Midnight / Ocean
- **自定义背景图** + 面板透明度调节
- **数据自主** — 所有数据本地存储，支持整体导出/导入备份

---

## 架构

```
┌─────────────────────────────────────────────────────────┐
│  QWebEngine / WebView（或浏览器直接访问）                  │
│  ┌───────────────────────────────────────────────────┐  │
│  │  React 前端（Vite 构建）                           │  │
│  │  Sidebar · MessageBubble · ChatInput               │  │
│  │  RepoPanel · ScratchPad · Settings                 │  │
│  └──────────────────┬────────────────────────────────┘  │
│                WebSocket (ws://127.0.0.1:44321)          │
│  ┌──────────────────┴────────────────────────────────┐  │
│  │  Python 后端                                       │  │
│  │  BridgeWS · SessionStore · AppConfigStore          │  │
│  │  SkillStore · BackendStore · ClipboardHandler      │  │
│  └──────┬──────────────────┬──────────────────────────┘  │
│         │                  │                  │           │
│  Claude Agent SDK   OpenAI 兼容 API    DashScope Image   │
│  claude_agent_sdk   (DeepSeek/Ollama)  (文生图/图生图)    │
└─────────────────────────────────────────────────────────┘
```

---

## 后端模式说明

| 后端类型 | 说明 | Agent 能力 | 额外前置 |
|---------|------|-----------|---------|
| `claude-agent-sdk` | 调用本地 Claude Code CLI 驱动 Agent Loop | ✅ 完整 Agent：文件读写、Shell 执行、工具调用 | **需先安装 Claude Code** |
| `anthropic-api` | 直连 Anthropic API，轻量 Chat 模式 | ❌ 仅对话，无本地工具执行 | Anthropic API Key |
| `openai-compatible` | 兼容 OpenAI 格式的任意接口 | ❌ 仅对话，无本地工具执行 | 对应服务的 API Key |
| `dashscope-image` | 阿里云 DashScope 文生图 / 图生图；支持 Wan、`qwen-image-3.0`、`qwen-image-3.0-pro` | — | 同地域 DashScope API Key / Workspace |

### Qwen Image 3.0

无需替换现有 Wan Backend：在 Backend Manager 中再创建一个 `DashScope 图像（Wan / Qwen Image 3.0）`，模型选择 `qwen-image-3.0` 或 `qwen-image-3.0-pro` 即可并存切换。

- 文生图尺寸留空时由模型根据提示词自动推荐，也可在聊天输入区按轮选择比例。
- 图生图支持按顺序传入 1–3 张 JPG/PNG/BMP/TIFF/WEBP/GIF 参考图，单张不超过 10MB。
- 支持 Direct/Agent 提示词增强、思考增强、1–6 张输出、反向提示词、Seed 与水印；Agent 增强在图生图时会自动降级为 Direct。
- 调用方式默认设为“自动”：轻量标准版任务使用同步接口；Pro、图生图、多输出、高分辨率、Thinking、Agent 改写或长提示词在提交前直接改走异步任务接口，并按 `task_id` 最长等待 3600 秒（可在 Backend Manager 调整为 60–7200 秒）。同步请求发生读取超时时不会自动重发，避免重复生成和计费。
- 生成完成后由执行节点立即下载并保存图片，聊天消息只传递本地图片引用，不把数 MB Base64 塞进 Markdown；远程控制端通过 AgentWithU 数据通道按需读取。
- 推荐填写 Workspace ID 与地域，由应用生成业务空间专属 `/api/v1` 地址。模型、Endpoint、API Key 与 Workspace 必须属于同一地域。

> **关于 `claude-agent-sdk` 模式**：底层依赖 [Claude Code](https://claude.ai/code) CLI 实现本地 Agent Loop。使用前须先完成 Claude Code 的安装与鉴权，这是**必选前置项**。
>
> `anthropic-api` 和 `openai-compatible` 模式不依赖 Claude Code，可作为**轻量 Chat 客户端**独立使用。

---

## 快速开始

### 前置条件

- Python 3.10+
- Node.js 18+（仅首次构建前端时需要）
- `ANTHROPIC_API_KEY` 或对应模型的 API Key
- **使用 `claude-agent-sdk` 模式时**：需额外安装 [Claude Code](https://claude.ai/code) 并完成鉴权（`claude login`）

### 安装 & 运行

```bash
# 克隆项目
git clone https://github.com/SalienceM/agent-with-u.git
cd agent-with-u

# 安装 Python 依赖
pip install -r requirements.txt

# 构建前端（只需一次）
cd frontend && npm install && npm run build && cd ..

# 启动
python -m src.ws_main
```

### 开发模式（前端热重载）

```bash
# 终端 1：前端 dev server
cd frontend && npm run dev

# 终端 2：Python 后端
python -m src.ws_main
# 然后在浏览器打开 http://localhost:5173
```

### Linux Docker 执行节点

推荐使用 [`deploy/docker-compose.example.yml`](deploy/docker-compose.example.yml) 部署。Backend 镜像默认包含官方 Codex CLI 与 Claude CLI；默认运行代理为 `http://192.168.50.156:7890`，可用 `AGENT_WITH_U_RUNTIME_PROXY` 覆盖，显式设为空可关闭。Codex/Claude 登录目录和业务数据均挂载到宿主机，重建不丢失。

这套 Compose 不是“纯 Web 控制端”：`awu-web` 的同源 `/ws` 会连接同机
`awu-backend`，因此页面里的 **当前 Web 节点** 本身就是完整执行节点。即使当前
窗口默认查看 Relay 上的另一台机器，新建 Session 时仍可选择当前 Web 节点。
“连接 → 当前 Web 节点 → 纳管执行节点”只负责把它额外注册到 Relay，供其他
获授权控制端发现；关闭纳管不会关闭它的同源自执行能力。Web 中保存的 Relay
主 Token 只落在 Backend 的 `data/relay-node.json`，不会写入浏览器或回显。

同一个控制端加入多台执行节点后，可在 **设置 → Backend Manager** 顶部选择
“管理执行节点”，直接读取和修改对应机器的 Backend、MCP 配置，并把登录/模型
终端请求发到该机器。显式选择的节点离线时操作会报错，不会回退到默认节点。
这些配置是节点级共享状态，因此仅本机直连用户或 Relay 为该节点指定的主用户
可以修改；普通共享用户仍可使用已经配置好的 Backend。

Compose 默认只启动 Backend/Web；无端口的 `awu-updater` 位于可选的 `online-update` profile 中。发布 `agent-with-u-docker-linux-<arch>.tar` 后，只有显式启用该 profile 的 Docker 节点才可在“节点在线更新”中一键加载新镜像、健康检查并重建 Backend/Web；失败自动恢复旧镜像。Docker Socket 只挂给 updater，不挂给执行 Agent 的 Backend。只使用 `git pull + build + up` 手动维护时无需启动 updater；启用方法见[156 Docker 安装与更新指南](deploy/WEB_156_INSTALL.md)。

### 接入本地模型（Ollama / LM Studio）

在后端管理界面添加一个 **OpenAI Compatible** 后端：

```
Base URL:  http://localhost:11434/v1   # Ollama 默认端口
Model:     llama3.2 / qwen2.5 / ...
API Key:   ollama                      # 任意非空字符串
```

DeepSeek、Moonshot、零一万物等 OpenAI 兼容接口同理。

### 接管执行节点上的已有 Codex 会话

如果 Codex 运行在家里的电脑，而当前 AgentWithU 通过 Relay 使用那台电脑作为
执行节点，新建会话时选择：

1. 家里的 AgentWithU 执行节点；
2. Codex Office backend；
3. **接管已有**；
4. 目标 Codex thread。

thread 的枚举、历史读取、文件操作和后续回答都在家里的执行节点完成，客户端
只走既有 AgentWithU Relay，因此不需要家庭公网 IP、端口映射或 SSH 配置。
家里的执行节点需以拥有这些 Codex 会话的同一系统用户运行，并能调用独立安装的
Codex CLI。

### 接入 Codex SSH Remote（可选）

新建 Codex 会话时，可以把运行位置切换为 **SSH Remote**。AgentWithU 会读取
`~/.ssh/config` 中的主机别名，通过 SSH 在目标机器启动
`codex app-server --listen stdio://`，无需额外暴露 Codex 端口。

远端机器需要先安装 Codex CLI 并完成登录，且本机执行 `ssh <别名>` 能正常连接。
创建时可选择：

- 新建远端 Codex thread；
- 接入已有 thread，导入其可见对话并继续原生上下文。

远端会话的工作目录是目标机器上的路径。为避免把远端路径误当成本机路径，
当前文件树不直接浏览该目录；Codex 的读写与命令工具仍在远端工作目录执行。
项目级 Skills 也以远端机器该目录中已安装的内容为准，AgentWithU 不会把本机
Skill 文件误写到同名的本地路径。

---

## Slash 命令

在输入框输入 `/` 触发：

| 命令 | 说明 |
|------|------|
| `/help` | 查看所有可用命令 |
| `/new` | 在当前目录新建干净会话（无历史记忆，同目录同后端，无弹窗） |
| `/clear` | 清空当前对话消息 |
| `/compact` | 压缩早期消息以节省上下文 |
| `/cost` | 显示 token 用量和估算费用 |
| `/status` | 当前会话状态 |
| `/continue` | 让 AI 从上次截断处继续 |
| `/autocontinue` | 切换超出 max_tokens 时自动续写 |
| `/model` | 查看当前模型信息 |
| `/config` | 查看后端配置 |

---

## Skill 插件开发

Skill 以目录形式存储，每个 Skill 包含一个 `SKILL.md`（声明元信息和调用指令）。

### 标准 SKILL.md 基本结构

```yaml
---
name: my-skill
description: 描述此 Skill 做什么、何时应使用
license: MIT          # 可选
compatibility: Python 3.10+  # 可选
---

## Instructions

描述 AI 应如何完成任务，可引用同目录的 scripts、references 与 assets。
```

`name` 与 `description` 是开放 Agent Skills 规范要求的字段。`backend`、
`type`、`input_schema` 是 AgentWithU 的可选增强字段；普通第三方 Skill
不需要这些字段，也不需要 `manifest.json`。

AgentWithU 会按运行框架部署到原生目录：

- Claude Code：`.claude/skills/<name>/`
- Qwen Code：`.qwen/skills/<name>/`
- Codex：`.agents/skills/<name>/`

Skill 内不要硬编码 `.claude/skills/...`。需要引用与 `SKILL.md`
同目录的脚本或资源时，统一写成 `{{SKILL_DIR}}/call.py`；
部署时会自动解析为当前 Agent 的实际目录。旧 Skill 中指向自身目录的
`.claude/.qwen/.agents` 路径也会在部署时自动迁移。

### 安装与打包

Repo 面板中的“🛍 市场”可直接接入 `owner/repo` 或 GitHub 仓库地址。
本地安装按钮同时接受：

- 标准 Agent Skill ZIP：根目录或某个子目录包含 `SKILL.md`，配套目录会完整保留；
- AgentWithU `.awu`：继续用于需要 `manifest.json`、Secrets Schema 等 AWU 扩展的旧包。

```bash
# 标准 Skill ZIP（不要求 manifest.json）
zip -r my-skill.zip my-skill/

# 旧版 AWU 扩展包
zip -r my-skill-1.0.0.awu my-skill/
```

`manifest.json` 示例：
```json
{
  "name": "my-skill",
  "version": "1.0.0",
  "secrets_schema": {
    "fields": [
      { "key": "API_KEY", "label": "API 密钥", "type": "password", "required": true }
    ]
  }
}
```

---

## 路线图

- [x] 剪贴板图片粘贴（QClipboard）
- [x] Markdown 渲染 + 代码高亮（highlight.js）
- [x] 流式输出 + thinking 块
- [x] 多模型后端切换（Claude SDK / OpenAI 兼容）
- [x] 会话持久化 + 导出导入
- [x] 工具调用可视化 + 权限审批
- [x] 文件 diff 预览
- [x] 4 套主题 + 自定义背景图 + 面板透明度
- [x] 后端管理 UI
- [x] Skill 插件系统（python-script / web-search / web-fetch / 图生图）
- [x] Skill 打包分发（.awu）+ Secrets 管理
- [x] 便签本（ScratchPad）
- [x] Tauri 打包（Windows NSIS）
- [ ] 文件拖拽上传
- [ ] MCP Server 集成
- [ ] 快捷键（Ctrl+K 命令面板）
- [ ] 移动端 / Web 模式

---

## License

MIT
