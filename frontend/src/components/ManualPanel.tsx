import React, { useEffect, useMemo, useState } from 'react';

interface ManualPanelProps { onClose: () => void; }

interface ManualItem {
  title: string;
  icon: string;
  summary: string;
  entry: string;
  tips?: string;
  keywords?: string;
}

interface ManualSection { id: string; title: string; icon: string; intro: string; items: ManualItem[]; }

const SECTIONS: ManualSection[] = [
  {
    id: 'start', title: '快速开始', icon: '🚀', intro: '从创建会话到发出第一条任务。',
    items: [
      { icon: '＋', title: '新建会话', summary: '选择普通对话或 Loop 会话、模型后端、执行节点和工作目录。目录选择器支持直接新建、重命名文件夹，本机与远端操作一致。', entry: '左侧栏顶部「＋」', tips: '工作目录决定模型可以直接查看和修改哪个项目。' },
      { icon: '💬', title: '普通对话', summary: '适合问答、编程、分析、修改文件和运行命令。回复支持逐字流式显示、思考块与工具执行过程。', entry: '新建会话 → 普通会话' },
      { icon: '▦', title: '多面板工作区', summary: '支持 1×1、1×2、2×2 布局，同时查看多个独立会话。蓝色边框表示当前焦点面板。', entry: '输入框上方「1×1 / 1×2 / 2×2」', tips: '截图、粘贴图片和全局动作都会投递到最后聚焦的面板。' },
      { icon: '📂', title: '工作目录', summary: '会话绑定一个项目目录，模型的读写、命令、Git 和技能操作均以它为基础。顶栏只显示末级目录名，点击即可复制完整路径。', entry: '新建会话 / 顶栏 📁 标签' },
      { icon: '⏹', title: '中止回答', summary: '模型运行时发送按钮会变为停止按钮，可立即终止当前生成或工具执行。', entry: '输入框右侧停止按钮' },
    ],
  },
  {
    id: 'chat', title: '对话与输入', icon: '✦', intro: '文字、图片、语音和内容渲染能力。',
    items: [
      { icon: '⌨', title: '文字与引用', summary: '输入任务，使用 @ 引用项目文件；支持多行编辑、历史上下文和斜杠命令。', entry: '底部输入框', tips: '空闲时 Enter 直接发送；模型回答期间继续输入会自动排队；Shift+Enter 换行。' },
      { icon: '🖼', title: '图片粘贴', summary: '支持 Snipaste、系统剪贴板和本地图片。图片会先显示为附件缩略图，再随消息发送给支持视觉的模型。', entry: 'Ctrl+V 或输入框图片按钮' },
      { icon: '✂', title: '区域截图', summary: '调用系统选区工具，选择完成后自动把截图加入当前输入框附件。', entry: '输入框截图按钮 / 可配置全局快捷键' },
      { icon: '🎙', title: '语音转文字', summary: '支持 OpenAI 兼容接口、DashScope 与本地 faster-whisper，将语音转成输入文字。', entry: '输入框麦克风；设置 → Voice-to-Text' },
      { icon: '◉', title: '实时语音对话（实验）', summary: 'Fun-ASR 实时识别停顿后自动发送给当前 Session Backend；模型流式生成时分块合成 Edge TTS 并立即顺序播放，支持开口打断。', entry: '输入区上方「实时对话」', tips: '先在设置中把 STT 设为 DashScope 并配置 API Key；停顿时长、收音阈值和打断开关位于 Assistant Voice。' },
      { icon: '🔊', title: '回答朗读', summary: '使用 Edge 神经语音朗读已经完成的助手回答。只提取正文，自动清理 Markdown、链接并略过代码块；不会读取思考过程或工具日志。', entry: '悬停助手消息 → 🔊；设置 → Assistant Voice', tips: '默认不会自动播放；朗读生成发生在会话所属执行节点，因此本机、Web 和 Relay 会话的操作方式一致。' },
      { icon: '▣', title: 'Markdown 与代码', summary: '回复支持标题、列表、表格、引用、代码高亮、链接和图片。工具调用可折叠查看输入与输出。', entry: '消息气泡；设置 → Render Markdown' },
      { icon: 'A±', title: '对话字号', summary: '全局调整消息字号，可用滑块或输入工具栏上的 A− / A+ 快速步进。输入工具栏默认只显示图标，含义可悬浮查看。', entry: '设置 → Font Size / 输入框工具栏' },
      { icon: '↥', title: '自动续写', summary: '模型因长度限制停止时，可自动发送继续指令，从上次位置接着输出。', entry: '输入工具栏 / /autocontinue' },
    ],
  },
  {
    id: 'flow', title: '效率工作流', icon: '⚡', intro: '不打断主线的任务组织与辅助空间。',
    items: [
      { icon: '🧬', title: '序列任务', summary: '无需开启模式：第一条在空闲时直接发送；回答期间继续输入的文字、图片或斜杠命令会自动排队，上一条完整结束后依次发送。队列可编辑、排序或清空。', entry: '回答期间继续使用底部输入框', tips: '重启后保留的旧队列不会擅自执行，需要在队列条点击「继续」恢复。' },
      { icon: '💭', title: 'By the way 旁路问答', summary: '基于最近对话摘要开启独立问答，不污染主会话上下文，也不会打断正在执行的任务。', entry: '会话中的悬浮 💬 按钮', tips: '回答可一键加入序列任务或发送回主对话。' },
      { icon: '📌', title: '便签本', summary: '本地草稿与待办空间，支持可勾选清单、标题、搜索、置顶、颜色、归档、文本和图片，不进入模型会话。', entry: '顶栏 📌 / Ctrl+Shift+N' },
      { icon: '🗂', title: '素材池', summary: '集中保存粘贴或生成的图片与文件，支持预览、固定、取消固定和删除，可跨后续步骤引用。', entry: '顶栏 🗂' },
      { icon: '✨', title: 'Prompts 提示词', summary: '把常用指令保存成可复用模板，在不同会话快速插入。', entry: '顶栏 📦 Repo → Prompts' },
      { icon: '🧩', title: 'Skills 技能', summary: '为模型提供结构化的专用能力与执行说明，例如网页搜索、图片生成或业务工具。', entry: '顶栏 📦 Repo → Skills', tips: '后端技能会按当前模型部署到会话工作目录。' },
    ],
  },
  {
    id: 'loop', title: 'Loop 深度任务', icon: '🔁', intro: '让模型多轮执行、评审和优化同一个完整目标。',
    items: [
      { icon: '🔁', title: '普通 Session 转 LOOP', summary: '保留原会话的聊天记录、Backend、工作目录和原生 Agent 上下文，制定全局目标后直接进入 Execute；转换完成后由你手动开始第一轮。', entry: '侧栏右键普通 Session → 转为 LOOP', tips: '运行中的会话需先等待当前回答结束。' },
      { icon: '💡', title: 'Idea 构想阶段', summary: '并行扩展多个想法，支持文字和图片。封存后综合成全局目标，原始诉求仍保留可追溯。', entry: '新建 Loop 会话 → Idea' },
      { icon: '▶', title: 'Execute 迭代', summary: '每轮都是对完整目标的一次最佳尝试，依次进行 Prepare、Execute、Analysis；步骤可串行或并行。', entry: 'Loop 面板 → 开始本轮' },
      { icon: '✋', title: '人工接管', summary: 'LOOP 完全停止且没有待恢复的半截任务时，可切到普通会话亲自接管。人工对话、工具调用和操作步骤会保存为一轮 Manual LOOP，回答结束后可交还自动 LOOP。', entry: 'Loop Execute 操作区 → 人工接管', tips: '运行中不能切换；先暂停 Auto，等待本轮完成。' },
      { icon: '◎', title: '独立评审', summary: '可用不同模型独立评分执行结果，降低执行者自评过高的问题；得分、风险和趋势决定是否继续。', entry: 'Loop → 策略与心智' },
      { icon: '⚙', title: '策略与心智', summary: '设置交付分、输出分、最大轮数、风险阈值、执行/评审模型和强制遵循的策略。支持预设。', entry: 'Loop 面板 → ⚙ 策略与心智' },
      { icon: '📎', title: 'Addon 执行中补充', summary: '运行期间追加文字或图片要求，不影响当前轮，从下一轮 Prepare 开始吸收；已应用内容保留历史。', entry: 'Loop Execute 阶段 → Addon' },
      { icon: '🧭', title: '意图守卫', summary: '首轮计划后独立检查方向是否偏离原始意图；中高风险时给出非阻塞提醒和改写建议。', entry: 'Loop 首轮自动运行' },
      { icon: '⏯', title: '断点恢复与自动继续', summary: '每个子阶段和步骤都会持久化；中断后从未完成位置继续。自动模式会按策略连续启动下一轮。', entry: 'Loop 操作区' },
      { icon: '🗑', title: '停止并删除本轮', summary: '放弃误触或错误迭代，恢复代理上下文；Git 项目可选择同时恢复本轮前的工作区快照。', entry: 'Loop Execute 操作区', tips: '恢复文件会撤销该轮产生的修改，请确认后使用。' },
      { icon: '🏁', title: 'Loop Out 与新一轮', summary: '满足输出条件或达到风险/轮数限制后汇总成果。Loop Out 不是终点，可修改目标后开始新一轮。', entry: 'Loop Out 面板' },
      { icon: '🔀', title: '面板 / 流程视图', summary: '在详细面板和流程图之间切换，查看每轮 Prepare、步骤执行、Analysis 的状态与耗时。', entry: 'Loop 顶栏视图切换' },
    ],
  },
  {
    id: 'project', title: '项目与版本', icon: '📦', intro: '查看文件、比较改动并完成 Git 工作流。',
    items: [
      { icon: '🌳', title: '工作目录树', summary: '浏览项目文件和目录，查看已暂存/未暂存计数，打开文本文件预览或编辑。', entry: '左侧栏「文件」视图' },
      { icon: '👁', title: '文件预览与编辑', summary: '点击文件查看内容；预览窗可一键最大化。Markdown 可直接转换并导出为独立 HTML；PDF、DOCX 与 Draw.io 使用完全离线的专用渲染器，Excel/PPT 使用快速结构化预览；文本和代码可直接编辑保存。', entry: '文件行的预览图标 / 点击文件名', tips: 'DOCX 版式渲染失败会自动切换兼容预览；Draw.io 支持 Sheet 切换、滚轮缩放、左键拖动画布及官方 / 兼容渲染切换。' },
      { icon: '±', title: 'Diff 变更对比', summary: '查看文件相对版本库的新增、删除和修改，辅助确认提交范围。', entry: '提交变更面板 → 点击文件名' },
      { icon: '＋', title: '加入版本追踪', summary: '将未跟踪文件执行 Git add，支持逐项操作和分组全选。', entry: '提交变更 → 未跟踪文件' },
      { icon: '✅', title: '提交与推送', summary: '选择要提交的文件，填写或让 AI 生成提交说明；提交推送会等待推送真正完成后再返回主界面。', entry: '左侧栏「提交」' },
      { icon: '📥', title: 'Stash 暂存工作区', summary: '临时收起尚未提交的修改，让工作区恢复干净；之后需要 Apply/Pop 拉回才能继续提交。', entry: 'Git 操作区', tips: 'Stash 不是提交，也不会自动进入其他分支。' },
      { icon: '⇄', title: '本机 / 远端双向同步', summary: '文件树合并展示两端内容：💻 本机独有可上传，☁ 远端独有可下载；比对后显示一致、不同或冲突。每个远程 session 独立保存本机目录，建好后也能随时更换。', entry: '左侧「文件」视图 → 本机目录「指定 / 更换 / 比对」' },
    ],
  },
  {
    id: 'models', title: '模型与连接', icon: '🌐', intro: '选择模型、代理方式和任务实际运行的机器。',
    items: [
      { icon: '🤖', title: 'Backend 与运行参数', summary: 'Backend 负责账号、连接、CLI 和默认值；管理器顶部可选择任一已加入且在线的执行节点，配置、MCP 与登录终端都会严格作用于该节点。共享节点仅本机或 Relay 主用户可修改。', entry: '设置 → Backend Manager → 管理执行节点' },
      { icon: '🧲', title: '接管已有 Codex 会话', summary: '从当前所选 AgentWithU 执行节点读取原生 Codex threads，导入可见历史并继续同一上下文。家里执行节点通过 Relay 连接时，不需要家庭公网 IP 或 SSH。', entry: '新建会话 → 选择执行节点 → Codex → 接管已有', tips: '执行节点应以拥有这些 Codex 会话的同一系统用户运行，并已安装独立 Codex CLI。' },
      { icon: '🔀', title: 'Loop 分角色模型', summary: '任务执行、想法、目标、评审和旁路可分别覆盖模型与档位。例如执行用 Terra / medium，评审用 Sol / max；每次结果会记录实际选型。', entry: 'Loop → 策略与心智 → 角色运行配置' },
      { icon: '🛡', title: '权限确认', summary: '控制模型执行写文件和命令时是否逐次确认。跳过确认更流畅，但会按当前进程权限直接执行。', entry: '输入工具栏 ⚡（悬浮查看说明）' },
      { icon: '🧭', title: '代理与网络', summary: '为 Codex/Qwen 等 CLI 配置系统代理或自定义 HTTP 代理，不要求系统全局代理或 TUN。', entry: 'Backend Manager → 环境/代理配置' },
      { icon: '📡', title: '连接池与执行节点', summary: '同一界面可连接本机、当前 Web Backend 或多个远端执行节点；新建会话时选择归属节点，之后任务固定在该节点执行。', entry: '顶栏 📡 → 可分配执行节点' },
      { icon: '🔗', title: 'Relay 中继', summary: '执行节点主动连接中继，客户端经令牌找到它，无需把执行机直接暴露到公网。桌面、Linux 和 Docker Web Backend 都可成为执行节点。', entry: '顶栏 📡 → 当前物理执行端 / 中继连接' },
      { icon: '🖥', title: '当前节点执行与发布', summary: '控制连接始终保留；本节点可分别设置是否承接 Agent 会话、是否发布到 Relay。设为控制端专用后仍能管理 Backend、Session 和更新，但不会出现在新建会话的执行节点候选中。', entry: '顶栏 📡 → 本机能力 / 当前 Web 节点' },
    ],
  },
  {
    id: 'desktop', title: '桌面与个性化', icon: '🖥', intro: '低干扰桌面操作与外观设置。',
    items: [
      { icon: '〰', title: 'Smooth 顺滑问答', summary: '后台监控约定手势，静默截取全屏或预设区域并自动发送到最后聚焦会话。模型忙时自动排队。', entry: '设置 → Smooth 顺滑问答', tips: 'Ctrl+双击左/右键截图；不会记录普通输入。' },
      { icon: '◫', title: '幽灵窗口', summary: '在预设截图区域中央显示当前会话的半透明卡片，实时查看问题、回答和生成状态；鼠标停在面板内可用滚轮浏览会话历史，始终不抢焦点。', entry: 'Smooth 开启后 → 左 Shift + 双击左键', tips: '再次触发隐藏；滚轮只在面板范围内滚动历史，不影响当前输入焦点。' },
      { icon: '🎨', title: '主题与背景', summary: '切换界面主题、设置背景图、背景透明度和面板透明度。', entry: '设置 → Theme / Background / Transparency' },
      { icon: '📋', title: '日志查看器', summary: '实时查看后端运行日志，排查模型启动、网络、代理、技能和工具执行问题。', entry: '顶栏 📋' },
      { icon: '⬆', title: '数据导入导出', summary: '备份或迁移后端配置、Prompts 与 Skills。会话历史和本机技能凭据不会混入导出包。', entry: '设置 → Data Management' },
    ],
  },
  {
    id: 'commands', title: '快捷键与命令', icon: '⌘', intro: '无需翻找按钮的快速入口。',
    items: [
      { icon: '/', title: '/help', summary: '显示当前支持的斜杠命令。', entry: '输入框输入 /help' },
      { icon: '🧹', title: '/clear', summary: '清空当前会话显示和历史上下文。', entry: '输入框输入 /clear' },
      { icon: '🗜', title: '/compact', summary: '压缩较早的对话内容，释放模型上下文空间。', entry: '输入框输入 /compact' },
      { icon: '💰', title: '/cost 与 /status', summary: '查看 token/费用估算以及当前会话、模型与连接状态。', entry: '输入框输入 /cost 或 /status' },
      { icon: '▶', title: '/continue', summary: '要求模型从上次停止的位置继续。', entry: '输入框输入 /continue' },
      { icon: '∞', title: '/autocontinue', summary: '开启或关闭达到输出上限后的自动续写。', entry: '输入框输入 /autocontinue' },
      { icon: '⚙', title: '/model 与 /config', summary: '查看当前模型信息和后端配置摘要。', entry: '输入框输入 /model 或 /config' },
      { icon: '📝', title: '/init', summary: '在项目中生成 AGENTS.md，引导模型理解项目规则和工作方式。', entry: '输入框输入 /init' },
      { icon: '📌', title: 'Ctrl+Shift+N', summary: '打开或关闭便签本。', entry: '桌面全局快捷键' },
      { icon: '✂', title: '截图快捷键', summary: '后台唤起系统区域截图，快捷键可修改或禁用。', entry: '设置 → Screenshot Hotkey' },
    ],
  },
];

export const ManualPanel: React.FC<ManualPanelProps> = ({ onClose }) => {
  const [active, setActive] = useState(SECTIONS[0].id);
  const [query, setQuery] = useState('');
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS.filter((section) => section.id === active);
    return SECTIONS.map((section) => ({
      ...section,
      items: section.items.filter((item) =>
        `${item.title} ${item.summary} ${item.entry} ${item.tips || ''} ${item.keywords || ''}`.toLowerCase().includes(q)),
    })).filter((section) => section.items.length > 0);
  }, [active, query]);

  const count = SECTIONS.reduce((sum, section) => sum + section.items.length, 0);
  return (
    <div style={overlayStyle} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <style>{`
        @media (max-width: 700px) {
          .manual-panel-body { flex-direction: column; }
          .manual-panel-nav { width: auto !important; display: flex; overflow-x: auto; overflow-y: hidden !important; border-right: 0 !important; border-bottom: 1px solid var(--theme-border); }
          .manual-panel-nav button { min-width: max-content; margin: 0 4px 0 0 !important; }
          .manual-panel-content { padding: 14px 12px 28px !important; }
          .manual-panel-grid { grid-template-columns: minmax(0, 1fr) !important; }
        }
      `}</style>
      <div style={panelStyle}>
        <header style={headerStyle}>
          <div>
            <div style={{ fontSize: 19, fontWeight: 800, color: 'var(--theme-text)' }}>📖 AgentWithU 使用手册</div>
            <div style={{ marginTop: 3, fontSize: 11, color: 'var(--theme-text-muted)' }}>{count} 项功能 · 点击分类浏览，输入关键词快速查找</div>
          </div>
          <button onClick={onClose} style={closeStyle} title="关闭 (Esc)">×</button>
        </header>
        <div style={searchWrapStyle}>
          <span style={{ opacity: .55 }}>⌕</span>
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索功能、入口、快捷键……" style={searchStyle} />
          {query && <button onClick={() => setQuery('')} style={clearStyle}>清除</button>}
        </div>
        <div className="manual-panel-body" style={bodyStyle}>
          <nav className="manual-panel-nav" style={navStyle}>
            {SECTIONS.map((section) => (
              <button key={section.id} onClick={() => { setActive(section.id); setQuery(''); }} style={{
                ...navButtonStyle,
                ...(active === section.id && !query ? activeNavStyle : {}),
              }}>
                <span>{section.icon}</span><span>{section.title}</span><small style={{ marginLeft: 'auto', opacity: .55 }}>{section.items.length}</small>
              </button>
            ))}
          </nav>
          <main className="manual-panel-content" style={contentStyle}>
            {filtered.length === 0 ? (
              <div style={emptyStyle}>没有找到“{query}”相关功能</div>
            ) : filtered.map((section) => (
              <section key={section.id} style={{ marginBottom: 26 }}>
                <div style={{ marginBottom: 12 }}>
                  <h3 style={{ margin: 0, fontSize: 17, color: 'var(--theme-text)' }}>{section.icon} {section.title}</h3>
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--theme-text-muted)' }}>{section.intro}</p>
                </div>
                <div className="manual-panel-grid" style={gridStyle}>
                  {section.items.map((item) => (
                    <article key={`${section.id}-${item.title}`} style={cardStyle}>
                      <div style={iconStyle}>{item.icon}</div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 750, color: 'var(--theme-text)' }}>{item.title}</div>
                        <div style={{ marginTop: 5, fontSize: 12, lineHeight: 1.65, color: 'var(--theme-text-muted)' }}>{item.summary}</div>
                        <div style={entryStyle}><b>入口</b><span>{item.entry}</span></div>
                        {item.tips && <div style={tipStyle}>💡 {item.tips}</div>}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </main>
        </div>
      </div>
    </div>
  );
};

const overlayStyle: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 3400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18, background: 'rgba(0,0,0,.64)', backdropFilter: 'blur(8px)' };
const panelStyle: React.CSSProperties = { width: 'min(1120px, 96vw)', height: 'min(820px, 92vh)', display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRadius: 16, border: '1px solid var(--theme-border)', background: 'var(--theme-panel-bg, var(--theme-bg))', boxShadow: '0 30px 90px rgba(0,0,0,.48)' };
const headerStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '17px 20px 13px', borderBottom: '1px solid var(--theme-border)' };
const closeStyle: React.CSSProperties = { width: 34, height: 34, borderRadius: 8, border: '1px solid var(--theme-border)', background: 'rgba(255,255,255,.04)', color: 'var(--theme-text)', fontSize: 23, cursor: 'pointer' };
const searchWrapStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, margin: '12px 16px', padding: '9px 12px', border: '1px solid var(--theme-border)', borderRadius: 10, background: 'var(--theme-input-bg)' };
const searchStyle: React.CSSProperties = { flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'var(--theme-text)', fontSize: 13 };
const clearStyle: React.CSSProperties = { border: 0, background: 'transparent', color: 'var(--theme-accent)', cursor: 'pointer', fontSize: 11 };
const bodyStyle: React.CSSProperties = { flex: 1, minHeight: 0, display: 'flex', borderTop: '1px solid var(--theme-border)' };
const navStyle: React.CSSProperties = { width: 184, flexShrink: 0, overflowY: 'auto', padding: 10, borderRight: '1px solid var(--theme-border)', background: 'rgba(255,255,255,.018)' };
const navButtonStyle: React.CSSProperties = { width: '100%', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, padding: '9px 10px', border: '1px solid transparent', borderRadius: 8, background: 'transparent', color: 'var(--theme-text-muted)', cursor: 'pointer', textAlign: 'left', fontSize: 12 };
const activeNavStyle: React.CSSProperties = { color: 'var(--theme-accent)', borderColor: 'var(--theme-accent)', background: 'var(--theme-accent-bg)', fontWeight: 700 };
const contentStyle: React.CSSProperties = { flex: 1, minWidth: 0, overflowY: 'auto', padding: '18px 20px 34px' };
const gridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(310px, 1fr))', gap: 10 };
const cardStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '38px 1fr', gap: 10, padding: 13, border: '1px solid var(--theme-border)', borderRadius: 11, background: 'rgba(255,255,255,.025)' };
const iconStyle: React.CSSProperties = { width: 36, height: 36, display: 'grid', placeItems: 'center', borderRadius: 9, background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)', fontSize: 17, fontWeight: 800 };
const entryStyle: React.CSSProperties = { display: 'flex', gap: 7, alignItems: 'baseline', marginTop: 8, paddingTop: 7, borderTop: '1px dashed var(--theme-border)', fontSize: 11, color: 'var(--theme-text-muted)' };
const tipStyle: React.CSSProperties = { marginTop: 7, padding: '6px 8px', borderRadius: 7, background: 'rgba(234,179,8,.08)', color: 'var(--theme-text-muted)', fontSize: 11, lineHeight: 1.5 };
const emptyStyle: React.CSSProperties = { height: '100%', display: 'grid', placeItems: 'center', color: 'var(--theme-text-muted)', fontSize: 13 };
