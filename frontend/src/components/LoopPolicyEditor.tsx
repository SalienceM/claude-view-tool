import React, { useEffect, useState } from 'react';
import { api } from '../api';
import {
  BackendRuntimeFields,
  isCodexBackend,
  isRuntimeConfigurableBackend,
  normalizeModelRuntime,
  type ModelRuntime,
} from './CodexRuntimeFields';

/** Loop 策略与心智（与后端 LoopPolicy 对齐，camelCase）。 */
export interface LoopPolicy {
  deliverableScore: number;
  outputtableScore: number;
  maxLoops: number;
  riskThreshold: number;
  stepStallSeconds: number;
  stepMaxAttempts: number;
  independentEval: boolean;
  intentGuard: boolean;
  backends: Record<string, string>;   // 各角色的专用 backend：{prepare/execute/idea/goal/analysis/aside}
  runtimes: Record<string, ModelRuntime>; // 各角色的模型/推理档位覆盖
  strategy: string;
}

// 可独立路由的 LOOP 角色；留空时跟随会话 Backend。
export const BACKEND_POSITIONS: { key: string; label: string; hint: string }[] = [
  { key: 'prepare', label: '规划与分步', hint: 'Prepare：识别焦点并拆成 1–4 步' },
  { key: 'execute', label: '逐步执行', hint: 'Execute：实际执行每个 step 并汇总' },
  { key: 'idea', label: '想法展开', hint: 'loopidea 阶段' },
  { key: 'goal', label: '目标汇总 / 微调', hint: 'ideas→目标 / 微调' },
  { key: 'analysis', label: '评分 / 评审', hint: '关键评审位' },
  { key: 'aside', label: '旁路问答', hint: 'By the way' },
];

export const RUNTIME_POSITIONS: { key: string; label: string; hint: string }[] = [
  { key: 'prepare', label: '规划与分步', hint: 'Prepare：理解目标、核实现状、生成步骤' },
  { key: 'execute', label: '逐步执行', hint: 'Execute：实际执行每个 step 并汇总' },
  ...BACKEND_POSITIONS.filter((position) => !['prepare', 'execute'].includes(position.key)),
];

export const DEFAULT_STRATEGY =
  `LOOP 是围绕【全局目标】和当前真实产物的连续增量演进：既不在每次 loop 重做完整目标，也不预先把任务机械切成固定阶段。
- prepare：回顾全局目标、原始诉求、上轮诊断和本次 addon；先核实现状，保留已验证成果，只选择当前最高价值的剩余缺口或回归，编排 1–4 个必要步骤。
- execute：针对本次增量焦点实际执行；动手前确认现状，已经满足的工作直接跳过，不要重复生成、重写或做无收益的全量检查。
- analysis：独立核实当前工作区的累计状态，并始终对照全局目标评分；明确记录已核实证据、剩余缺口和下一次唯一优先焦点。

评分心智（防自欺，必须遵守）：
1. 以可验证的实际产物为准——文件是否真存在、代码是否真能跑、命令/测试输出是否真通过；不要轻信执行阶段的自述总结，能验证就动手验证。
2. score 衡量的是当前累计产物对全局目标的完成度，不是本次做了多少；本次贡献与整体完成度要分开。
3. 默认未完成：除非有明确证据满足验收标准，否则不给高分；模糊、未验证、想当然一律压低。
4. 警惕「美好陷阱」：流程跑顺 ≠ 目标达成；高分（≥可输出门槛）必须对应验收标准逐条被证据支撑。
5. 趋势判断看已核实的净新增价值；禁止把重复执行、重复测试或更乐观的措辞算作进展。
6. 宁可保守扣分、点明差距与下一步，也不要为了收口而粉饰；真完不成就如实在 challenges 标注。`;

export const DEFAULT_POLICY: LoopPolicy = {
  deliverableScore: 70,
  outputtableScore: 85,
  maxLoops: 8,
  riskThreshold: 0.85,
  stepStallSeconds: 300,
  stepMaxAttempts: 2,
  independentEval: true,
  intentGuard: true,
  backends: {},
  runtimes: {},
  strategy: DEFAULT_STRATEGY,
};

/** 兜底归一：补默认 + 夹取必要范围（可输出门槛不低于可交付门槛）。 */
export function normalizePolicy(p?: Partial<LoopPolicy> | null): LoopPolicy {
  const d = { ...DEFAULT_POLICY, ...(p || {}) };
  const del = clamp(num(d.deliverableScore, 70), 0, 100);
  const out = clamp(num(d.outputtableScore, 85), del, 100);
  // Loop 次数由用户决定，不设产品级上限；只归一为正整数。
  const ml = Math.max(1, Math.round(num(d.maxLoops, 8)));
  const rt = clamp(num(d.riskThreshold, 0.85), 0.1, 1);
  const stall = Math.round(clamp(num(d.stepStallSeconds, 300), 30, 3600));
  const attempts = Math.round(clamp(num(d.stepMaxAttempts, 2), 1, 3));
  const ie = d.independentEval !== false;
  const ig = d.intentGuard !== false;
  const backends: Record<string, string> = {};
  const rawB: any = (d as any).backends;
  if (rawB && typeof rawB === 'object') {
    for (const { key } of BACKEND_POSITIONS) {
      const v = rawB[key];
      if (typeof v === 'string' && v.trim()) backends[key] = v;
    }
  }
  // 迁移旧的单一 evalBackendId
  const oldEb = (d as any).evalBackendId;
  if (typeof oldEb === 'string' && oldEb.trim()) {
    if (!backends.analysis) backends.analysis = oldEb;
    if (!backends.goal) backends.goal = oldEb;
  }
  const runtimes: Record<string, ModelRuntime> = {};
  const rawR: any = (d as any).runtimes;
  if (rawR && typeof rawR === 'object') {
    for (const { key } of RUNTIME_POSITIONS) {
      const runtime = normalizeModelRuntime(rawR[key]);
      if (runtime.model || runtime.reasoningEffort) runtimes[key] = runtime;
    }
  }
  const strat = (typeof d.strategy === 'string' && d.strategy.trim()) ? d.strategy : DEFAULT_STRATEGY;
  return { deliverableScore: del, outputtableScore: out, maxLoops: ml, riskThreshold: rt, stepStallSeconds: stall, stepMaxAttempts: attempts, independentEval: ie, intentGuard: ig, backends, runtimes, strategy: strat };
}

function num(v: any, fb: number): number { const n = Number(v); return Number.isFinite(n) ? n : fb; }
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }

export const LoopPolicyEditor: React.FC<{
  value: LoopPolicy;
  onChange: (p: LoopPolicy) => void;
  availableBackends?: any[];
  sessionBackendId?: string;
  sessionRuntime?: ModelRuntime;
}> = ({ value, onChange, availableBackends, sessionBackendId, sessionRuntime }) => {
  const set = (patch: Partial<LoopPolicy>) => onChange({ ...value, ...patch });
  const [presets, setPresets] = useState<any[]>([]);
  const [sel, setSel] = useState('');
  const [loadedBackends, setLoadedBackends] = useState<any[]>([]);
  const backends = availableBackends ?? loadedBackends;
  const [ledger, setLedger] = useState<any[]>([]);
  const [showLedger, setShowLedger] = useState(false);
  const reload = () => api.loopPolicyPresetList().then((r) => setPresets(r.presets || [])).catch(() => {});
  useEffect(() => {
    reload();
    if (!availableBackends) api.getBackends().then((b) => setLoadedBackends(b || [])).catch(() => {});
    api.modelLedgerList().then((r) => setLedger(r.models || [])).catch(() => {});
  }, [availableBackends]);

  const applyPreset = (id: string) => {
    setSel(id);
    const p = presets.find((x) => x.id === id);
    if (p?.policy) onChange(normalizePolicy(p.policy));
  };
  const saveAsPreset = async () => {
    const name = window.prompt('预设名称：', '我的策略');
    if (!name || !name.trim()) return;
    const r = await api.loopPolicyPresetSave(name.trim(), normalizePolicy(value));
    if (r.status === 'ok') { await reload(); if (r.preset?.id) setSel(r.preset.id); }
    else if (r.message) alert(r.message);
  };
  const delPreset = async () => {
    const p = presets.find((x) => x.id === sel);
    if (!p || p.builtin) return;
    if (!window.confirm(`删除预设「${p.name}」？`)) return;
    const r = await api.loopPolicyPresetDelete(sel);
    if (r.status === 'ok') { setSel(''); reload(); }
    else if (r.message) alert(r.message);
  };
  const selPreset = presets.find((x) => x.id === sel);
  const roleBackend = (role: string) => {
    const roleBackendId = value.backends?.[role] || sessionBackendId;
    return backends.find((backend) => backend.id === roleBackendId);
  };
  const canApplyCodexSplit = ['prepare', 'execute', 'analysis']
    .every((role) => isCodexBackend(roleBackend(role)));
  const applyCodexSplit = () => {
    set({
      runtimes: {
        ...(value.runtimes || {}),
        prepare: { model: 'gpt-5.6-sol', reasoningEffort: 'max' },
        execute: { model: 'gpt-5.6-terra', reasoningEffort: 'medium' },
        analysis: { model: 'gpt-5.6-sol', reasoningEffort: 'max' },
      },
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* 预设：像 Prompts/Skills 一样直接选用，选完仍可调整 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ ...labelText, marginBottom: 0 }}>预设</span>
        <select value={sel} onChange={(e) => applyPreset(e.target.value)} style={{ ...inputBase, flex: '1 1 180px', minWidth: 160 }}>
          <option value="">— 选择一个预设套用 —</option>
          <optgroup label="内置">
            {presets.filter((p) => p.builtin).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </optgroup>
          {presets.some((p) => !p.builtin) && (
            <optgroup label="我的">
              {presets.filter((p) => !p.builtin).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </optgroup>
          )}
        </select>
        <button type="button" onClick={saveAsPreset} style={smallBtn} title="把当前配置另存为预设">＋ 存为预设</button>
        {selPreset && !selPreset.builtin && (
          <button type="button" onClick={delPreset} style={{ ...smallBtn, color: '#f87171', borderColor: '#f8717155' }}>删除</button>
        )}
      </div>
      {selPreset?.desc && <div style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>{selPreset.desc}</div>}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <NumField label="可交付门槛" hint="分数 ≥ 此值视为可交付" value={value.deliverableScore}
          min={0} max={100} step={1} onChange={(v) => set({ deliverableScore: v })} />
        <NumField label="可输出门槛" hint="分数 ≥ 此值视为可输出" value={value.outputtableScore}
          min={0} max={100} step={1} onChange={(v) => set({ outputtableScore: v })} />
        <NumField label="最大 Loop 数" hint="本轮次数预算，不设固定上限" value={value.maxLoops}
          min={1} step={1} onChange={(v) => set({ maxLoops: v })} />
        <NumField label="风险止损阈值" hint="风险系数 ≥ 此值即收口" value={value.riskThreshold}
          min={0.1} max={1} step={0.05} onChange={(v) => set({ riskThreshold: v })} />
        <NumField label="单步无活动超时（秒）" hint="无任何模型/工具事件后自动止损" value={value.stepStallSeconds}
          min={30} max={3600} step={30} onChange={(v) => set({ stepStallSeconds: v })} />
        <NumField label="单步最大尝试次数" hint="卡住/空结果时换新上下文重试" value={value.stepMaxAttempts}
          min={1} max={3} step={1} onChange={(v) => set({ stepMaxAttempts: v })} />
      </div>

      <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', lineHeight: 1.55, padding: '7px 9px', borderRadius: 7, background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-border)' }}>
        自动防卡死：单步超过设定时间没有任何新事件时，会关闭当前 Backend 调用，保留已经落盘的文件，
        用全新模型上下文重试当前步；达到次数上限后该步记为失败，LOOP 仍继续汇总与评审，不会永久停在 running。
      </div>

      {/* 防自欺：独立对抗式评审 */}
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', padding: '8px 10px', borderRadius: 8, background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-border)' }}>
        <input type="checkbox" checked={value.independentEval} onChange={(e) => set({ independentEval: e.target.checked })} style={{ marginTop: 2 }} />
        <span>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--theme-text)' }}>独立对抗式评审（防自欺）</span>
          <span style={{ display: 'block', fontSize: 11, color: 'var(--theme-text-muted)', marginTop: 2, lineHeight: 1.5 }}>
            评分用独立上下文、不复用执行对话；以实际产物/可运行性为准核实，默认未完成，避免「越跑越自我感觉良好」的失真。建议开启。
          </span>
        </span>
      </label>

      {/* 意图守卫 */}
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', padding: '8px 10px', borderRadius: 8, background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-border)' }}>
        <input type="checkbox" checked={value.intentGuard} onChange={(e) => set({ intentGuard: e.target.checked })} style={{ marginTop: 2 }} />
        <span>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--theme-text)' }}>意图守卫（早期偏差提示）</span>
          <span style={{ display: 'block', fontSize: 11, color: 'var(--theme-text-muted)', marginTop: 2, lineHeight: 1.5 }}>
            每轮第一遍出 plan 后、真正重执行前，独立检查「计划方向 vs 你的真实意图」是否跑偏；有实质偏差才非阻塞地提示，早暴露、省算力，又不打断执行。
          </span>
        </span>
      </label>

      {/* Backend 是连接/账号；同一 Codex backend 下，各角色可独立选模型与推理档位。 */}
      <div>
        <div style={{ ...labelRow, marginBottom: 7 }}>
          <span style={{ ...labelText, marginBottom: 0 }}>角色运行配置（Backend / 模型 / 推理档位）</span>
          {canApplyCodexSplit && (
            <button type="button" onClick={applyCodexSplit} style={{ ...smallBtn, marginLeft: 'auto', padding: '4px 8px', fontSize: 11 }}
              title="规划与评审使用 Sol / max；逐步执行使用 Terra / medium">
              ⚡ Sol 顶格规划/评审 · Terra 中档执行
            </button>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {RUNTIME_POSITIONS.map((pos) => {
            const backendOverride = value.backends?.[pos.key] || '';
            const roleBackendId = backendOverride || sessionBackendId || '';
            const roleBackend = backends.find((b) => b.id === roleBackendId);
            const executeBackendId = value.backends?.execute || sessionBackendId || '';
            const executeRuntime = normalizeModelRuntime(value.runtimes?.execute);
            const followsSessionBackend = !!roleBackendId && roleBackendId === sessionBackendId;
            const followsExecuteBackend = pos.key !== 'execute'
              && !!roleBackendId && roleBackendId === executeBackendId;
            const inheritedRuntime = pos.key === 'execute'
              ? (followsSessionBackend ? normalizeModelRuntime(sessionRuntime) : {})
              : followsExecuteBackend
                ? normalizeModelRuntime({
                    ...(executeBackendId === sessionBackendId ? sessionRuntime : {}),
                    ...executeRuntime,
                  })
                : followsSessionBackend ? normalizeModelRuntime(sessionRuntime) : {};
            const roleRuntime = normalizeModelRuntime(value.runtimes?.[pos.key]);
            return (
              <div key={pos.key} style={{
                padding: '9px 10px', border: '1px solid var(--theme-border)', borderRadius: 9,
                background: 'var(--theme-bg-secondary)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: 'var(--theme-text)', fontWeight: 650 }}>{pos.label}</span>
                  <span style={{ fontSize: 10.5, color: 'var(--theme-text-muted)' }}>{pos.hint}</span>
                  {roleBackend && (
                    <span style={{ marginLeft: 'auto', fontSize: 10, color: isRuntimeConfigurableBackend(roleBackend) ? '#22c55e' : 'var(--theme-text-muted)' }}>
                      {isCodexBackend(roleBackend)
                        ? 'Codex · 可选模型/档位'
                        : isRuntimeConfigurableBackend(roleBackend) ? 'Qwen · 可选模型' : roleBackend.type}
                    </span>
                  )}
                </div>
                <select value={backendOverride}
                  onChange={(e) => set({ backends: { ...(value.backends || {}), [pos.key]: e.target.value } })}
                  style={{ ...inputBase, width: '100%', marginBottom: isRuntimeConfigurableBackend(roleBackend) ? 8 : 0 }}>
                  <option value="">跟随会话 Backend</option>
                  {backends.map((b) => <option key={b.id} value={b.id}>{b.label || b.id}</option>)}
                </select>
                {roleBackend && isRuntimeConfigurableBackend(roleBackend) && (
                  <BackendRuntimeFields
                    backend={roleBackend}
                    value={roleRuntime}
                    inherited={inheritedRuntime}
                    compact
                    inheritLabel={pos.key === 'execute'
                      ? followsSessionBackend ? '跟随会话默认' : '跟随所选 Backend 默认'
                      : followsExecuteBackend ? '跟随逐步执行配置'
                        : followsSessionBackend ? '跟随会话默认' : '跟随所选 Backend 默认'}
                    onChange={(runtime) => set({
                      runtimes: { ...(value.runtimes || {}), [pos.key]: runtime },
                    })}
                  />
                )}
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--theme-text-muted)', marginTop: 4, lineHeight: 1.5 }}>
          规划、逐步执行和评审都可单独选择 Backend / 模型；留空时跟随会话 Backend。
          例如 Sol / max 负责拆步、Qwen 或 Terra 执行每个 Step、Sol / max 独立评审；相同 Backend 的角色可继承执行模型配置。
        </div>
        {ledger.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={() => setShowLedger((v) => !v)}
              style={{ background: 'none', border: 'none', color: 'var(--theme-accent)', cursor: 'pointer', fontSize: 11, padding: 0 }}>
              {showLedger ? '▾' : '▸'} 📊 各模型历史表现（跨 session 积累，供分配参考）
            </button>
            {showLedger && (
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {ledger.map((m) => {
                  const ex = m.roles?.execute;
                  return (
                    <div key={m.runtimeKey || m.backendId} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11, color: 'var(--theme-text-muted)', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, color: 'var(--theme-text)' }}>{m.label}</span>
                      {ex?.avgScore != null
                        ? <span>执行均分 <b style={{ color: 'var(--theme-text)' }}>{ex.avgScore.toFixed(0)}</b>（{ex.scored} 次）</span>
                        : <span>暂无执行评分</span>}
                      {m.roles?.prepare?.count ? <span>· 规划 {m.roles.prepare.count} 次</span> : null}
                      {m.roles?.analysis?.count ? <span>· 评审 {m.roles.analysis.count} 次</span> : null}
                    </div>
                  );
                })}
                <div style={{ fontSize: 10, color: 'var(--theme-text-muted)', marginTop: 2 }}>
                  由历次 loop 的真实评分自动积累；执行均分越高代表该模型在这类任务上越能交付。
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div>
        <div style={labelRow}>
          <span style={labelText}>策略与心智</span>
          <button type="button" onClick={() => set({ strategy: DEFAULT_STRATEGY })} style={resetBtn}
            title="恢复默认策略文本">↺ 默认</button>
        </div>
        <textarea
          value={value.strategy}
          onChange={(e) => set({ strategy: e.target.value })}
          placeholder="描述 loop 的策略与评分心智，会注入到每次 prepare / analysis 提示中…"
          style={{ ...inputBase, width: '100%', minHeight: 120, resize: 'vertical', lineHeight: 1.55, fontSize: 12.5 }}
        />
        <div style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginTop: 4 }}>
          这段文本会在每次 prepare（规划）与 analysis（评分）时作为「须遵循」的指导注入给模型。
        </div>
      </div>
    </div>
  );
};

const NumField: React.FC<{
  label: string; hint: string; value: number; min: number; max?: number; step: number;
  onChange: (v: number) => void;
}> = ({ label, hint, value, min, max, step, onChange }) => (
  <div style={{ flex: '1 1 120px', minWidth: 120 }}>
    <div style={labelText}>{label}</div>
    <input
      type="number" value={value} min={min} max={max} step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ ...inputBase, width: '100%' }}
    />
    <div style={{ fontSize: 10.5, color: 'var(--theme-text-muted)', marginTop: 2 }}>{hint}</div>
  </div>
);

const inputBase: React.CSSProperties = {
  background: 'var(--theme-input-bg, #fff)', border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  color: 'var(--theme-text, #1f2328)', borderRadius: 8, padding: '7px 9px', fontSize: 13,
  outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
};
const labelRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 };
const labelText: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--theme-text, #1f2328)', marginBottom: 4 };
const resetBtn: React.CSSProperties = {
  marginLeft: 'auto', background: 'none', border: '1px solid var(--theme-border)', borderRadius: 6,
  color: 'var(--theme-text-muted)', cursor: 'pointer', fontSize: 11, padding: '2px 8px',
};
const smallBtn: React.CSSProperties = {
  background: 'var(--theme-bg-tertiary, #f6f8fa)', border: '1px solid var(--theme-border, rgba(0,0,0,0.15))',
  borderRadius: 7, color: 'var(--theme-text, #1f2328)', cursor: 'pointer', fontSize: 12, padding: '6px 10px', whiteSpace: 'nowrap',
};
