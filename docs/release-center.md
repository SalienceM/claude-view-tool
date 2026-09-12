# AgentWithU 发布工作台

发布工作台是 AgentWithU 内按需加载的维护者模块。它与聊天 Session 分离，
也与“节点在线更新”职责分离：发布工作台生产更新，节点更新中心消费更新。

## 基本原则

- 打包不等于发布。BAT、Shell 和 Kit 的普通文件输出只登记候选构建；Kit 只有通过
  白名单 `awu_capability` 协议才能编排发布中心，正式发布默认需独立人工确认。
  聊天输入区可显式勾选“本次允许 Kit 代确认”：该独立发送字段只授权一个运行/链，
  有效期 6 小时，不能由普通正文、附件、引用或模型参数代替。Agent 必须先 `status`
  读取冻结计划，再用 `approve` 携带 `runId`、`stepId`、完整 `planFingerprint` 和稳定
  `requestId`；预检阻断、超出范围、发布配置或冻结计划变化、授权过期均拒绝。
  同一确认重试不会重复发布，账本区分 `human` 和 `chat-delegated` 并关联用户消息。
  原授权可供同一用户在后续聊天轮继续核对本次运行；不会自动唤醒 Agent 或授权新的运行。
- 正式发布前必须选择制品、比较稳定版、完成预检并显式确认。
- 预检会冻结文件大小、SHA-256、对象 key 和 manifest；发布前再次校验。
- 七牛不可变制品先上传，版本 manifest 随后上传，channel manifest 最后切换。
- 大文件上传是 backend 后台任务，关闭工作台不会中止任务；重新打开可查看状态。

## 打开方式

1. 打开“设置 → 数据与系统 → 维护者工具”。
2. 勾选“启用发布工作台（仅当前控制端用户）”。
3. 点击“打开发布工作台”。

该前端模块由 Vite 单独分包；未打开时不会加载。发布 RPC 与节点更新 RPC 使用
相同的设备管理权限：本机用户或 Relay 为该节点指定的主用户才可调用。

## 首次配置

在“发布配置”中填写：

- 项目根目录与制品扫描目录；
- channel（默认 `stable`）；
- 七牛 Bucket；
- CDN 公网 Base URL；
- 对象前缀与 channel manifest key；
- `qshell` 命令或绝对路径。

保存正确的 qshell 路径后，在同一页面的“七牛上传账号（当前执行节点）”填写
`ACCESS_KEY`、`SECRET_KEY` 和一个本地账号别名。工作台会在所选执行节点调用
`qshell -L account ... --overwrite`，输入成功后立即清空；AccessKey/SecretKey 不写入
发布中心普通配置、候选、冻结计划或任务日志，凭据文件由 qshell 保存在该节点的
`release-center/qshell-workspace/` 专用空间。这个模式不依赖 Windows 当前登录用户，
因此后台 sidecar、服务或 Relay executor 也能使用同一账号。每个承担发布的节点需要
分别配置一次，切换节点不会复制云账号；已在系统用户目录登录过的旧 qshell 账号仍
可继续使用。

未配置账号会在预检阶段直接形成阻断项，正式发布不会再启动到上传阶段后才失败。
若需要 HMAC manifest 签名，在发布节点设置 `AGENT_WITH_U_UPDATE_SIGNING_KEY`，并可
勾选“没有签名密钥时阻止正式发布”。

## 日常流程

1. 按原习惯运行 `build_all.bat`、`build_lite.bat`、`build_fat.bat`、
   `build_fat_sideonly.bat` 或 `build_web_linux.sh`。
   `build_all.bat` / `build_web_linux.sh` 检测到 Docker Engine 时，会同时生成
   `agent-with-u-docker-linux-<arch>.tar`；不需要 Docker 制品时设置
   `AGENT_WITH_U_SKIP_DOCKER_RELEASE=1`。
2. 成功打包后脚本自动调用 `scripts/register_release_candidate.py`。登记失败不会把
   已成功的打包判为失败，也可稍后在工作台手动扫描。
3. 在“候选与发布”选择本次要发布的 MSI、NSIS、Linux portable 或 Docker 制品。
   Docker tar 会自动标记为 `target=docker / kind=docker-bundle`，无需填写 install JSON。
4. 对自定义 Linux 包填写明确的 `install` JSON；系统不会猜测高权限安装命令。
5. 填写更新说明，点击“预检并冻结发布计划”。
6. 处理全部阻断项并核对 stable 对比、哈希、大小和最终对象路径。
7. 勾选确认框，再点击“正式发布”。

没有发布的构建会一直保持“待发布”，可手动标记为“已废弃”；废弃不会删除本地
安装包。成功发布记录和任务日志保存在执行节点的
`~/.agent-with-u/release-center/`（或 `AGENT_WITH_U_DATA_ROOT` 对应目录）。

## Workspace Kit

Kit 的文件输出新增“登记发布候选”开关。成功运行后，该文件进入全局候选区，
但普通命令、脚本和 AI 不能因此获得正式发布权限。

需要把“打包完成后的发布”做成一键流程时，可在 Kit 高级实现中加入
`AgentWithU · 发布最新包`，其 DSL 为：

```json
{
  "type": "awu_capability",
  "title": "发布最新包",
  "target": "executor",
  "config": {
    "capability": "release.publish_latest",
    "arguments": {
      "projectRoot": ".",
      "channel": "stable",
      "notes": "本次更新说明"
    }
  }
}
```

该步骤复用发布中心现有服务，而不是模拟点击界面或复制上传脚本：

1. 扫描当前构建，并按可选的 `platform`、`arch`、`target`、`kind` 或
   `artifactIds` 筛选本次新制品；默认不选择版本时间戳之前的旧包。
2. 运行完整预检，冻结制品大小、SHA-256、对象 key、manifest 和计划指纹。
3. 有阻断项时 Kit 明确失败；无阻断项时进入持久化的 `waiting_approval`。
4. 用户在 Kit 运行详情核对版本、Build、制品、哈希、channel 和 Manifest 后，
   点击“确认正式发布”；或由获得有效单次委托的 Agent 经聊天工具核对并确认。
   确认来源、授权记录与计划指纹一同写入运行账本。
5. 确认后调用同一个 `ReleaseCenterManager.start_publish()`；上传字节进度、当前文件、
   最终状态和 Manifest URL 持续回写 Kit Run。停止 Kit 会同步取消发布任务。

AI 可以在用户明确提出发布意图时生成这个步骤，但生成不等于批准；Schedule 对这种
需要人工确认的高风险能力直接拒绝触发。能力 ID 来自 Backend 白名单，Kit 不能按任意
RPC 名称调用内部功能。
后续节点升级、文件同步或 Backend 管理等产品能力应沿用同一协议，并分别声明参数、
风险级别、设备权限和确认策略。
