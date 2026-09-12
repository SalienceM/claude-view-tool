import React, { useCallback, useEffect, useState } from 'react';
import {
  getConnectionTarget, setConnectionTarget, inspectRelay,
  rememberRelayUserProfile,
  isTauri, getDesktopConfig, setDesktopConfig, type DesktopConfig,
  api, type ConnectedClient,
  getExecutors, getAssignableExecutors, addExecRoster, removeExecRoster,
  isLocalAgentExecutionEnabled, setLocalAgentExecutionEnabled,
  onExecStatus, getHomeExecKey,
  type ExecutorInfo, type RelayUserProfile, type RelayNodeStatus,
} from '../api';
import {
  listRelayProfiles, saveRelayProfile, deleteRelayProfile,
  type RelayProfile,
} from '../utils/relayProfiles';

interface ConnectionPanelProps {
  onClose: () => void;
}

/**
 * 连接面板。
 *
 * 视觉上分成两张独立卡片，避免「两段中继地址」让人混淆：
 *
 *   ┌─[ 卡片 A · 当前物理执行端 ]──────  Tauri / Web 均可见
 *   │ 控制连接始终保留；可分别决定是否承接 Agent、是否发布到 Relay
 *   │ + 发布到中继的配置（让远程 UI 经中继找到这个节点）
 *   │ + 「正在连接当前节点的 UI」实时列表 + 计数
 *   └─────────────────────────────────
 *
 *   ┌─[ 卡片 B · 本 UI 连接到 ]─────────  所有端可见
 *   │ 当前这个窗口要连哪台执行节点：本地直连 / 经中继
 *   └─────────────────────────────────
 *
 * 卡片 A 是「我对外提供什么」，卡片 B 是「我自己要看哪台」，
 * 名字相近但目的完全不同。
 */
export const ConnectionPanel: React.FC<ConnectionPanelProps> = ({ onClose }) => {
  const current = getConnectionTarget();
  const [mode, setMode] = useState<'local' | 'relay'>(current.mode);
  const [url, setUrl] = useState(current.mode === 'relay' ? current.url : '');
  const [token, setToken] = useState(current.mode === 'relay' ? current.token : '');
  const [deviceId, setDeviceId] = useState(current.mode === 'relay' ? current.deviceId : '');
  const [devices, setDevices] = useState<{ id: string; name: string }[]>([]);
  const [verifiedUser, setVerifiedUser] = useState<RelayUserProfile | null>(
    current.mode === 'relay' ? current.user || null : null,
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // 当前物理执行端：Tauri 是本机 sidecar；生产 Web 是提供同源 /ws 的 Backend。
  // 控制连接始终存在；Agent 执行资格与是否额外发布到 Relay 是两个独立开关。
  const tauri = isTauri();
  const [role, setRole] = useState<'executor' | 'client'>('executor');
  const [pubUrl, setPubUrl] = useState('');
  const [pubToken, setPubToken] = useState('');
  const [pubDeviceName, setPubDeviceName] = useState('');
  const [savedDesktop, setSavedDesktop] = useState<DesktopConfig | null>(null);
  const [restartHint, setRestartHint] = useState(false);
  const [relayNode, setRelayNode] = useState<RelayNodeStatus | null>(null);
  const [relayNodeLoading, setRelayNodeLoading] = useState(!tauri);

  // 「正在连接本机的 UI」实时列表
  const [clients, setClients] = useState<ConnectedClient[]>([]);

  // ── 可分配执行节点（session 级模式）：默认 + 本机 + 额外节点，新建会话时可选 ──
  const [executors, setExecutors] = useState<ExecutorInfo[]>(() => getExecutors());
  useEffect(() => onExecStatus(() => setExecutors(getExecutors())), []);
  const assignableExecutors = getAssignableExecutors();
  const localAgentExecutionEnabled = isLocalAgentExecutionEnabled();
  const localExecutorConnected = executors.some(
    (executor) => executor.key === 'local' && executor.connected,
  );
  // 「加入可分配节点」的就地反馈（成功 / 已是 home / 提示）——避免「点了没反应」。
  const [execMsg, setExecMsg] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);

  const updateLocalAgentExecution = useCallback(async (enabled: boolean) => {
    setBusy(true);
    setErr('');
    try {
      if (!tauri) {
        if (!relayNode?.supported) {
          throw new Error('当前 Web Backend 尚未就绪或版本过旧，无法保存全局执行策略');
        }
        const status = await api.relayNodeExecutionConfigure(enabled, 'local');
        setRelayNode(status);
        setLocalAgentExecutionEnabled(status.agentExecutionEnabled);
      } else {
        setLocalAgentExecutionEnabled(enabled);
      }
      setExecMsg({
        kind: 'ok',
        text: enabled
          ? `✓ ${tauri ? '本机' : '当前 Web 节点'}已恢复承接新会话。`
          : `✓ ${tauri ? '本机' : '当前 Web 节点'}已设为控制端专用；管理连接仍保留，但不会承接新会话。`,
      });
    } catch (error: any) {
      setExecMsg({
        kind: 'warn',
        text: error?.message || '无法修改当前节点的 Agent 执行资格',
      });
    } finally {
      setBusy(false);
    }
  }, [tauri, relayNode?.supported]);

  const removeAssignableExecutor = useCallback((executor: ExecutorInfo) => {
    if (executor.key === 'local') {
      void updateLocalAgentExecution(false);
      return;
    }
    removeExecRoster(executor.key);
    setExecMsg({ kind: 'ok', text: `✓ 已从可分配列表移除「${executor.label}」。` });
  }, [updateLocalAgentExecution]);

  // 把卡片 B 当前填好的中继 + 选中节点加入「可分配执行节点」（不切换默认节点）。
  const addSelectedAsExecutor = useCallback(() => {
    setExecMsg(null);
    if (!url.trim()) { setErr('请先填写中继地址'); return; }
    if (!deviceId) { setErr('请先刷新并选择一个执行节点'); return; }
    if (!verifiedUser) { setErr('请先验证当前用户并刷新执行节点'); return; }
    if (getConnectionTarget().mode !== 'relay') {
      setErr('当前窗口仍是 local 用户。请先“保存并连接”登录该 Relay 用户，再添加此用户的其他执行节点。');
      return;
    }
    const dev = devices.find((d) => d.id === deviceId);
    const key = `relay:${verifiedUser.userId || 'legacy'}:${deviceId}`;
    // 若这台正是当前默认节点，addExecRoster 会静默跳过。明确告诉用户，而不是「没反应」。
    if (key === getHomeExecKey()) {
      setExecMsg({
        kind: 'warn',
        text: `这台「${dev?.name || deviceId}」正是本窗口当前的默认节点，无需重复加入。`,
      });
      return;
    }
    const added = addExecRoster({
      mode: 'relay', url: url.trim(), token: token.trim(), deviceId,
      deviceName: dev?.name, user: verifiedUser,
    });
    if (!added) {
      setErr('只能加入当前已登录 Relay 用户获授权的执行节点；请先“保存并连接”切换用户。');
      return;
    }
    setErr('');
    setExecMsg({
      kind: 'ok',
      text: `✓ 已加入「${dev?.name || deviceId}」。向上滚动可见「可分配执行节点」卡片；`
        + `关闭本面板后，新建会话时即可在「执行节点」里选它。`,
    });
  }, [url, token, deviceId, devices, verifiedUser]);

  // ── Relay 预设列表(localStorage 持久化) ──
  const [profiles, setProfiles] = useState<RelayProfile[]>(() => listRelayProfiles());
  const [activeProfileId, setActiveProfileId] = useState<string | null>(() => {
    // 启动时如果当前 url+token 命中某个预设,自动高亮它
    const c = getConnectionTarget();
    if (c.mode !== 'relay') return null;
    const hit = listRelayProfiles().find((p) => p.url === c.url && p.token === c.token);
    return hit?.id ?? null;
  });
  const refreshProfiles = useCallback(() => setProfiles(listRelayProfiles()), []);

  const selectProfile = useCallback((p: RelayProfile) => {
    setUrl(p.url);
    setToken(p.token);
    setVerifiedUser(p.user || null);
    setActiveProfileId(p.id);
    setErr('');
    // 选了新的中继 → 设备列表清空,让用户重新刷一遍
    setDevices([]);
    setDeviceId('');
  }, []);

  const saveCurrentAsProfile = useCallback(() => {
    const u = url.trim();
    const t = token.trim();
    if (!u) { setErr('请先填写中继地址'); return; }
    const defaultLabel = (() => {
      try {
        const host = new URL(u.replace(/^ws/, 'http')).host;
        return host || u;
      } catch { return u; }
    })();
    const label = window.prompt('为这个中继取个名字', defaultLabel);
    if (!label) return;  // 用户取消
    const saved = saveRelayProfile({
      id: activeProfileId ?? undefined, label, url: u, token: t,
      user: verifiedUser || undefined,
    });
    refreshProfiles();
    setActiveProfileId(saved.id);
  }, [url, token, verifiedUser, activeProfileId, refreshProfiles]);

  const removeProfile = useCallback((id: string) => {
    if (!window.confirm('删除这个中继预设?')) return;
    deleteRelayProfile(id);
    refreshProfiles();
    if (activeProfileId === id) setActiveProfileId(null);
  }, [activeProfileId, refreshProfiles]);

  useEffect(() => {
    if (!tauri) return;
    getDesktopConfig().then((c) => {
      if (!c) return;
      setSavedDesktop(c);
      setRole(c.mode === 'client' ? 'client' : 'executor');
      setPubUrl(c.relayUrl || '');
      setPubToken(c.relayToken || '');
      setPubDeviceName(c.deviceName || '');
    });
  }, [tauri]);

  // Web 部署的同源 Backend 也是完整执行节点。它的 Relay 配置保存在服务端，
  // 主 Token 只返回“是否已配置”，绝不回填到浏览器。连接池可能在面板打开后
  // 才完成同源 /ws 握手，因此跟随 local 在线状态重试，不能只在 mount 时查一次。
  useEffect(() => {
    if (tauri) return;
    if (!localExecutorConnected) {
      setRelayNodeLoading(true);
      return;
    }
    let cancelled = false;
    setRelayNodeLoading(true);
    api.relayNodeStatus('local').then((status) => {
      if (cancelled) return;
      setRelayNode(status);
      setLocalAgentExecutionEnabled(status.agentExecutionEnabled);
      setRole(status.enabled ? 'executor' : 'client');
      setPubUrl(status.url || '');
      setPubDeviceName(status.deviceName || '');
      if (!status.supported) {
        setErr(status.lastError || '当前 Web Backend 尚不支持在线纳管');
      }
    }).catch((error: any) => {
      if (!cancelled) setErr(error?.message || '无法读取当前 Web 节点状态');
    }).finally(() => {
      if (!cancelled) setRelayNodeLoading(false);
    });
    return () => { cancelled = true; };
  }, [tauri, localExecutorConnected]);

  // RelayLink 会在后台自动重连；面板打开期间轻量刷新状态，让“连接中”能自行
  // 变成“已注册”，也能如实显示后来发生的断线，而不要求用户关闭重开面板。
  useEffect(() => {
    if (tauri || !localExecutorConnected || !relayNode?.supported) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      api.relayNodeStatus('local').then((status) => {
        if (!cancelled) {
          setRelayNode(status);
          setLocalAgentExecutionEnabled(status.agentExecutionEnabled);
        }
      }).catch(() => { /* 权限或瞬时断线由现有状态/连接指示承担 */ });
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tauri, localExecutorConnected, relayNode?.supported]);

  // 卡片 A 描述物理执行端，所以固定查询 local 连接，不能误读当前默认远端节点。
  useEffect(() => {
    let cancelled = false;
    const localExecKey = 'local';
    api.listConnectedClients(localExecKey).then((list) => {
      if (!cancelled) setClients(list);
    }).catch(() => { /* 后端未连上 / mock 时 list 为空 */ });
    const unsub = api.onClientsChanged((list, execKey) => {
      if (!cancelled && (!localExecKey || execKey === localExecKey)) setClients(list);
    });
    return () => { cancelled = true; unsub(); };
  }, [tauri]);

  const handleRefresh = useCallback(async () => {
    if (!url.trim()) { setErr('请先填写中继地址'); return; }
    setBusy(true);
    setErr('');
    try {
      const inspection = await inspectRelay(url.trim(), token.trim());
      setDevices(inspection.devices);
      setVerifiedUser(inspection.profile);
      const active = getConnectionTarget();
      if (active.mode === 'relay'
          && active.url === url.trim() && active.token === token.trim()) {
        rememberRelayUserProfile(inspection.profile);
      }
      if (inspection.devices.length === 0) {
        setErr('用户验证成功，但没有获授权且在线的执行节点');
      } else if (!inspection.devices.find((d) => d.id === deviceId)) {
        setDeviceId(inspection.devices[0].id);
      }
    } catch (e: any) {
      setDevices([]);
      setVerifiedUser(null);
      setErr(e?.message || '获取设备失败');
    } finally {
      setBusy(false);
    }
  }, [url, token, deviceId]);

  // 把卡片 A 里填好的发布中继配置复制到卡片 B 的「远程(经中继)」字段
  const copyFromPublish = useCallback(() => {
    if (pubUrl.trim()) setUrl(pubUrl.trim());
    setVerifiedUser(null);
    setDevices([]);
    setDeviceId('');
    setMode('relay');
  }, [pubUrl]);

  const handleSave = useCallback(async () => {
    if (mode === 'local' && !localAgentExecutionEnabled) {
      setErr('当前节点已设为控制端专用；请先在卡片 A 恢复 Agent 执行资格，或改选远端节点。');
      return;
    }
    let checkedUser: RelayUserProfile | null = null;
    let checkedDevices = devices;
    if (mode === 'relay') {
      if (!url.trim()) { setErr('请填写中继地址'); return; }
      if (!token.trim()) { setErr('请填写用户 Token'); return; }
      setBusy(true);
      setErr('');
      try {
        const inspection = await inspectRelay(url.trim(), token.trim());
        checkedUser = inspection.profile;
        checkedDevices = inspection.devices;
        setVerifiedUser(inspection.profile);
        setDevices(inspection.devices);
        if (!deviceId || !inspection.devices.some((device) => device.id === deviceId)) {
          setErr('请选择当前用户获授权且在线的执行节点');
          return;
        }
      } catch (error: any) {
        setVerifiedUser(null);
        setErr(error?.message || '用户验证失败');
        return;
      } finally {
        setBusy(false);
      }
    }
    // 1. 配置当前物理执行端是否发布到 Relay。本地/同源执行始终可用。
    let needRestart = false;
    if (tauri) {
      const next: DesktopConfig = {
        mode: role,
        relayUrl: pubUrl.trim(),
        relayToken: pubToken.trim(),
        deviceName: pubDeviceName.trim(),
      };
      needRestart = !savedDesktop
        || savedDesktop.mode !== next.mode
        || savedDesktop.relayUrl !== next.relayUrl
        || savedDesktop.relayToken !== next.relayToken
        || savedDesktop.deviceName !== next.deviceName;
      if (needRestart) {
        await setDesktopConfig(next);
        setSavedDesktop(next);
      }
    } else if (relayNodeLoading && localExecutorConnected) {
      // 已确认存在同源 Backend，只是管理状态尚未返回；此时不能用默认值覆盖配置。
      setErr('正在读取当前 Web 节点状态，请稍候');
      return;
    } else if (relayNode?.supported) {
      if (role === 'executor' && !pubUrl.trim()) {
        setErr('请填写当前 Web 节点要注册到的 Relay 地址');
        return;
      }
      if (role === 'executor' && !pubToken.trim() && !relayNode.hasToken) {
        setErr('首次纳管当前 Web 节点时必须填写 Relay 主 Token');
        return;
      }
      setBusy(true);
      setErr('');
      try {
        const status = await api.relayNodeConfigure({
          enabled: role === 'executor',
          url: pubUrl.trim(),
          token: pubToken.trim() || undefined,
          deviceName: pubDeviceName.trim(),
        }, 'local');
        setRelayNode(status);
        setPubToken('');
        if (status.enabled && !status.connected && status.lastError) {
          setErr(`配置已保存，Relay 正在后台重试：${status.lastError}`);
          return;
        }
      } catch (error: any) {
        setErr(error?.message || '当前 Web 节点纳管失败');
        return;
      } finally {
        setBusy(false);
      }
    }
    // 没有同源 Backend、Backend 版本较旧或当前 Web 用户无物理节点管理权限时，
    // 只跳过卡片 A；卡片 B 的个人连接目标仍必须可以保存，不能让全局权限阻断
    // 普通用户继续使用已授权的 Relay 执行节点。
    // 2. 持久化当前 UI 的连接目标。
    if (mode === 'local') {
      await setConnectionTarget({ mode: 'local' });
    } else {
      const dev = checkedDevices.find((d) => d.id === deviceId);
      await setConnectionTarget({
        mode: 'relay',
        url: url.trim(),
        token: token.trim(),
        deviceId,
        deviceName: dev?.name,
        user: checkedUser || undefined,
      });
      // 顺手把当前 url+token 落进 profile 列表(同 url+token 已存在会去重,
      // 不会产生重复条目)。这样用户「保存并连接」一次,下次就能从预设列表
      // 一键回来,不用再输 url 和 token。
      try {
        const defaultLabel = (() => {
          try { return new URL(url.trim().replace(/^ws/, 'http')).host || url.trim(); }
          catch { return url.trim(); }
        })();
        const saved = saveRelayProfile({
          id: activeProfileId ?? undefined,
          label: profiles.find((p) => p.id === activeProfileId)?.label || defaultLabel,
          url: url.trim(),
          token: token.trim(),
          user: checkedUser || undefined,
        });
        refreshProfiles();
        setActiveProfileId(saved.id);
      } catch { /* 静默忽略,profile 持久化失败不影响连接 */ }
    }
    if (needRestart) setRestartHint(true);
    else onClose();
  }, [tauri, role, pubUrl, pubToken, pubDeviceName, savedDesktop, relayNode, relayNodeLoading,
      localExecutorConnected,
      mode, url, token, deviceId, devices, profiles, activeProfileId, refreshProfiles, onClose,
      localAgentExecutionEnabled]);

  // 卡片 A 已配置好「发布中继」、卡片 B 选了 relay 但还没填地址：提示一键复制
  const canSuggestCopy = role === 'executor' && mode === 'relay'
    && pubUrl.trim() && (!url.trim() || url.trim() !== pubUrl.trim());

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--theme-text)' }}>
            📡 连接
          </h2>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={closeBtnStyle}>✕</button>
        </div>

        <div style={introStyle}>
          真实执行永远在<b>执行节点</b>上。
          <> 下面两张卡片各管一件事：</>
          <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
            <li>
              <b>{tauri ? '本机能力' : '当前 Web 节点'}</b>
              {' = '}控制连接始终保留；可分别关闭 Agent 执行、Relay 发布
            </li>
            <li><b>本 UI 连接到</b> = 当前默认查看哪台节点，不等于物理执行端</li>
          </ul>
        </div>

        {/* ════ 可分配执行节点（session 级模式管理）════════════════════
            默认节点(下面卡片 B 选的那台)是新建会话的默认落点;在这里额外加入
            的远端节点会与默认节点和物理本机同时在线,新建会话时可逐会话选择。这样
            「某些会话本机自执行,某些走远端」就成了每会话的选择,而非整窗口的
            系统级开关。 */}
        {assignableExecutors.length > 1 && (
          <div style={cardStyle}>
            <div style={cardTitleStyle}>
              {tauri && <span style={cardBadgeStyle}>★</span>}
              <span>可分配执行节点</span>
              <span style={cardSubtitleStyle}>新建会话时逐个选择</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {assignableExecutors.map((ex) => (
                <div key={ex.key} style={execRowStyle}>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                    background: ex.connected ? '#22c55e' : '#9ca3af',
                  }} />
                  <span style={{ fontWeight: 600, color: 'var(--theme-text)' }}>
                    {ex.mode === 'local' ? ex.label : `🌐 ${ex.label}`}
                  </span>
                  {ex.isHome && (
                    <span style={{
                      fontSize: 10, padding: '1px 6px', borderRadius: 8,
                      background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)',
                    }}>默认</span>
                  )}
                  <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>
                    {ex.connected ? '在线' : '离线'}
                  </span>
                  <div style={{ flex: 1 }} />
                  {!ex.isHome && (
                    <button
                      onClick={() => removeAssignableExecutor(ex)}
                      style={{
                        fontSize: 11, padding: '2px 8px', borderRadius: 6,
                        border: '1px solid var(--theme-border)', background: 'transparent',
                        color: 'var(--theme-text-muted)', cursor: 'pointer',
                      }}
                      title="从可分配列表移除（不影响已建会话）"
                    >移除</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {execMsg && (
          <div style={{
            margin: '-2px 0 10px', fontSize: 11, lineHeight: 1.6,
            padding: '8px 10px', borderRadius: 6,
            background: execMsg.kind === 'ok' ? 'rgba(34,197,94,0.12)' : 'rgba(234,179,8,0.12)',
            border: `1px solid ${execMsg.kind === 'ok' ? 'rgba(34,197,94,0.4)' : 'rgba(234,179,8,0.4)'}`,
            color: execMsg.kind === 'ok' ? 'var(--theme-success, #2da44e)' : '#b45309',
          }}>
            {execMsg.text}
          </div>
        )}

        {/* ════ 卡片 A：当前物理执行端（Tauri sidecar / 同源 Web Backend） ════ */}
        <div style={cardStyle}>
            <div style={cardTitleStyle}>
              <span style={cardBadgeStyle}>A</span>
              <span>{tauri ? '本机能力' : '当前 Web 节点'}</span>
              <span style={cardSubtitleStyle}>
                {tauri ? '桌面 sidecar · 重启生效' : '同源 Backend · 立即生效'}
              </span>
            </div>

            {!tauri && (
              <div style={{ ...hintStyle, marginBottom: 9 }}>
                {relayNodeLoading
                  ? '正在读取当前 Web Backend 状态…'
                  : relayNode?.supported
                    ? <>
                        节点 ID：<code>{relayNode.deviceId || '读取中'}</code>
                        {' · '}{relayNode.enabled
                          ? (relayNode.connected ? 'Relay 已注册' : 'Relay 正在后台连接')
                          : (localAgentExecutionEnabled
                              ? '未发布 Relay · 允许本机执行'
                              : '未发布 Relay · 控制端专用')}
                        {relayNode.lastError && <><br/>{relayNode.lastError}</>}
                      </>
                    : (relayNode?.lastError || '当前 Backend 版本不支持在线纳管')}
              </div>
            )}

            <div style={{
              marginBottom: 10, padding: '9px 10px', borderRadius: 8,
              border: '1px solid var(--theme-border)',
              background: 'var(--theme-bg-tertiary)',
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text)', marginBottom: 7 }}>
                Agent 执行资格
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => { void updateLocalAgentExecution(true); }}
                  disabled={busy || (!tauri && (relayNodeLoading || !relayNode?.supported))}
                  style={{
                    ...modeBtnStyle,
                    background: localAgentExecutionEnabled ? 'var(--theme-accent-bg)' : 'transparent',
                    borderColor: localAgentExecutionEnabled ? 'var(--theme-accent)' : 'var(--theme-border)',
                    color: localAgentExecutionEnabled ? 'var(--theme-accent)' : 'var(--theme-text-muted)',
                  }}
                >允许承接 Agent 会话</button>
                <button
                  onClick={() => { void updateLocalAgentExecution(false); }}
                  disabled={busy || (!tauri && (relayNodeLoading || !relayNode?.supported))}
                  title="对所有 Web 用户生效；保留管理连接，但不承接新会话"
                  style={{
                    ...modeBtnStyle,
                    opacity: busy || (!tauri && (relayNodeLoading || !relayNode?.supported)) ? 0.5 : 1,
                    background: !localAgentExecutionEnabled ? 'var(--theme-accent-bg)' : 'transparent',
                    borderColor: !localAgentExecutionEnabled ? 'var(--theme-accent)' : 'var(--theme-border)',
                    color: !localAgentExecutionEnabled ? 'var(--theme-accent)' : 'var(--theme-text-muted)',
                  }}
                >控制端专用（不承接新会话）</button>
              </div>
              <div style={{ ...hintStyle, marginTop: 7 }}>
                Web 部署中对所有用户生效。关闭只影响新建会话；Backend 设置、Session 管理和在线更新仍使用同源控制连接。
              </div>
            </div>

            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text)', marginBottom: 7 }}>
              Relay 发布
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              {(['executor', 'client'] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setRole(r)}
                  disabled={!tauri && (relayNodeLoading || !relayNode?.supported)}
                  style={{
                    ...modeBtnStyle,
                    background: role === r ? 'var(--theme-accent-bg)' : 'transparent',
                    borderColor: role === r ? 'var(--theme-accent)' : 'var(--theme-border)',
                    color: role === r ? 'var(--theme-accent)' : 'var(--theme-text-muted)',
                  }}
                >
                  {r === 'executor'
                    ? '📡 发布到 Relay'
                    : '🔒 不发布到 Relay'}
                </button>
              ))}
            </div>

            {role === 'executor' && (
              <>
                <div style={hintStyle}>
                  此开关只把{tauri ? '本机 sidecar' : '当前 Web Backend'}注册到 Relay，
                  供获授权用户远程发现；是否承接 Agent 由上方执行资格控制。
                  这里使用 Relay 主 Token，不要交给普通用户。
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '8px 0 4px' }}>
                  <input
                    type="text"
                    value={pubUrl}
                    placeholder="中继地址 ws://relay.example.com:44360"
                    onChange={(e) => setPubUrl(e.target.value)}
                    style={inputStyle}
                  />
                  <input
                    type="password"
                    value={pubToken}
                    placeholder={!tauri && relayNode?.hasToken
                      ? 'Relay 主 Token（已保存；留空保持不变）'
                      : 'Relay 主 Token（仅执行端注册使用）'}
                    onChange={(e) => setPubToken(e.target.value)}
                    style={inputStyle}
                  />
                  <input
                    type="text"
                    value={pubDeviceName}
                    placeholder="节点显示名（远程设备列表里显示）"
                    onChange={(e) => setPubDeviceName(e.target.value)}
                    style={inputStyle}
                  />
                </div>

                {/* —— 正在连接当前物理执行端的 UI ——————————————————— */}
                <ConnectedClientsList
                  clients={clients}
                  nodeLabel={tauri ? '本机' : '当前 Web 节点'}
                />
              </>
            )}

            {role === 'client' && (
              <div style={hintStyle}>
                {tauri ? '本机 sidecar' : '当前 Web Backend'}不会注册到 Relay，其他机器看不到这台设备；
                是否允许当前窗口创建本节点 Session，由上方 Agent 执行资格单独控制。
                本窗口仍可同时使用下方已登录用户获授权的远端执行节点。
              </div>
            )}
        </div>

        {/* ════ 卡片 B：本 UI 连接到 ════════════════════════════════ */}
        <div style={cardStyle}>
          <div style={cardTitleStyle}>
            <span style={cardBadgeStyle}>B</span>
            <span>本 UI 连接到</span>
            <span style={cardSubtitleStyle}>这个窗口要看哪台执行节点</span>
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            {(['local', 'relay'] as const).map((m) => {
              return (
                <button
                  key={m}
                  onClick={() => { setMode(m); setErr(''); }}
                  style={{
                    ...modeBtnStyle,
                    background: mode === m ? 'var(--theme-accent-bg)' : 'transparent',
                    borderColor: mode === m ? 'var(--theme-accent)' : 'var(--theme-border)',
                    color: mode === m ? 'var(--theme-accent)' : 'var(--theme-text-muted)',
                  }}
                >
                  {m === 'local'
                    ? (tauri ? '🏠 本地直连' : '🖥️ 当前 Web 节点')
                    : '🌐 远程(经中继)'}
                </button>
              );
            })}
          </div>

          {mode === 'local' && (
            <div style={hintStyle}>
              {tauri
                ? '连接本机 sidecar，不经中继。延迟最低，流量不出网。'
                : '连接这套 Web 部署的同源 Backend，不经 Relay；它就是当前 Web 节点。'}
              <br/>👉 若上方已设为控制端专用，请先恢复 Agent 执行资格，才能在这里创建本节点会话。
            </div>
          )}

          {mode === 'relay' && (
            <>
              <div style={{ ...hintStyle, marginBottom: 9 }}>
                这里使用 Relay 为当前用户签发的用户 Token。验证后只会列出该用户获授权的执行节点。
              </div>
              {canSuggestCopy && (
                <button onClick={copyFromPublish} style={suggestBtnStyle}>
                  ↑ 使用卡片 A 的中继地址（用户 Token 需单独填写）
                </button>
              )}

              {/* 已保存的中继预设(点选即填入 url+token) */}
              {profiles.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <label style={labelStyle}>已保存的中继</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {profiles.map((p) => {
                      const active = activeProfileId === p.id;
                      return (
                        <span
                          key={p.id}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            padding: '4px 8px',
                            borderRadius: 14,
                            border: `1px solid ${active ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
                            background: active ? 'var(--theme-accent-bg)' : 'transparent',
                            color: active ? 'var(--theme-accent)' : 'var(--theme-text)',
                            fontSize: 11,
                            cursor: 'pointer',
                          }}
                          onClick={() => selectProfile(p)}
                          title={p.url}
                        >
                          <span>{p.label}</span>
                          <span
                            onClick={(e) => { e.stopPropagation(); removeProfile(p.id); }}
                            style={{
                              opacity: 0.6, fontSize: 12, marginLeft: 2,
                              cursor: 'pointer',
                            }}
                            title="删除"
                          >×</span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                <div>
                  <label style={labelStyle}>中继地址</label>
                  <input
                    type="text"
                    value={url}
                    placeholder="ws://relay.example.com:44360"
                    onChange={(e) => {
                      setUrl(e.target.value); setActiveProfileId(null); setVerifiedUser(null);
                      setDevices([]); setDeviceId('');
                    }}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>用户 Token</label>
                  <input
                    type="password"
                    value={token}
                    placeholder="Relay 为当前用户签发的 token"
                    onChange={(e) => {
                      setToken(e.target.value); setActiveProfileId(null); setVerifiedUser(null);
                      setDevices([]); setDeviceId('');
                    }}
                    style={inputStyle}
                  />
                </div>
                {verifiedUser && (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px',
                    border: '1px solid rgba(34,197,94,0.35)', background: 'rgba(34,197,94,0.09)',
                    color: 'var(--theme-text)', fontSize: 11,
                  }}>
                    {verifiedUser.avatarData ? (
                      <img src={verifiedUser.avatarData} alt="" style={{ width: 28, height: 28, objectFit: 'cover', borderRadius: '50%' }} />
                    ) : (
                      <span style={{
                        width: 28, height: 28, borderRadius: '50%', display: 'grid', placeItems: 'center',
                        color: '#fff', background: verifiedUser.avatarColor, fontWeight: 700,
                      }}>{(verifiedUser.displayName || verifiedUser.username).slice(0, 1).toUpperCase()}</span>
                    )}
                    <span style={{ minWidth: 0 }}>
                      <strong style={{ display: 'block' }}>✓ {verifiedUser.displayName}</strong>
                      <span style={{ color: 'var(--theme-text-muted)' }}>@{verifiedUser.username} · {verifiedUser.userId}</span>
                    </span>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={saveCurrentAsProfile} style={{ ...refreshBtnStyle, flex: '0 0 auto' }}>
                    💾 {activeProfileId ? '更新预设' : '保存为预设'}
                  </button>
                </div>
                <button onClick={handleRefresh} disabled={busy} style={refreshBtnStyle}>
                  {busy ? '验证中…' : '验证用户并刷新执行节点'}
                </button>
                {devices.length > 0 && (
                  <div>
                    <label style={labelStyle}>执行节点</label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {devices.map((d) => (
                        <button
                          key={d.id}
                          onClick={() => setDeviceId(d.id)}
                          style={{
                            ...deviceBtnStyle,
                            background: deviceId === d.id ? 'var(--theme-accent-bg)' : 'var(--theme-input-bg)',
                            borderColor: deviceId === d.id ? 'var(--theme-accent)' : 'var(--theme-border)',
                          }}
                        >
                          <span style={{ fontWeight: 600 }}>{d.name}</span>
                          <span style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginLeft: 8 }}>
                            {d.id}
                          </span>
                        </button>
                      ))}
                    </div>
                    {/* 把所选节点加入「可分配执行节点」——不切换 home,只是让新建
                        会话时多一个可选的执行节点(session 级)。 */}
                    <button onClick={addSelectedAsExecutor} style={{ ...refreshBtnStyle, marginTop: 8 }}>
                      ➕ 加入可分配执行节点（新建会话时可选）
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {err && (
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--theme-error, #f85149)' }}>
            {err}
          </div>
        )}

        {restartHint && (
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--theme-accent)' }}>
            本机角色已保存，重启应用后生效。
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          <button onClick={handleSave} style={saveBtnStyle}>保存并连接</button>
          <button onClick={onClose} style={cancelBtnStyle}>取消</button>
        </div>
      </div>
    </div>
  );
};

// ── 子组件：正在连接本机的 UI 列表 ──────────────────────────────────
const ConnectedClientsList: React.FC<{
  clients: ConnectedClient[];
  nodeLabel: string;
}> = ({ clients, nodeLabel }) => {
  const count = clients.length;
  return (
    <div style={connectedBoxStyle}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text)' }}>
          📊 正在连接{nodeLabel}的 UI
        </span>
        <span style={{
          marginLeft: 6, padding: '1px 8px', borderRadius: 10,
          fontSize: 11, fontWeight: 600,
          background: count > 0 ? 'var(--theme-accent-bg)' : 'var(--theme-bg-tertiary)',
          color: count > 0 ? 'var(--theme-accent)' : 'var(--theme-text-muted)',
        }}>
          {count}
        </span>
      </div>
      {count === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>
          (暂无连接)
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {clients.map((c, i) => <ClientRow key={i} c={c} />)}
        </div>
      )}
    </div>
  );
};

const ClientRow: React.FC<{ c: ConnectedClient }> = ({ c }) => {
  const since = c.since ? humanDuration(c.since) : '';
  const viaTag = c.via === 'relay' ? '🌐 中继' : '🏠 本地';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 8px', borderRadius: 6,
      background: 'var(--theme-bg-tertiary)',
      fontSize: 11,
    }}>
      <span style={{ fontWeight: 600, color: 'var(--theme-text)' }}>{viaTag}</span>
      <span style={{ color: 'var(--theme-text)' }}>
        {c.display_name || c.username || c.identity || '?'}
      </span>
      {c.username && c.identity && c.identity !== c.username && (
        <span style={{ color: 'var(--theme-text-muted)' }}>@{c.username}</span>
      )}
      {c.peer && (
        <span style={{ color: 'var(--theme-text-muted)', fontFamily: 'monospace' }}>
          {c.peer}
        </span>
      )}
      <div style={{ flex: 1 }} />
      {since && <span style={{ color: 'var(--theme-text-muted)' }}>{since}</span>}
    </div>
  );
};

/** 把 ISO 时间转成「3min / 12s / 2h」相对值。 */
function humanDuration(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    if (!t) return '';
    const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}min`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
    return `${Math.floor(sec / 86400)}d`;
  } catch { return ''; }
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0,
  background: 'rgba(0,0,0,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 1200,
};

const panelStyle: React.CSSProperties = {
  background: 'var(--theme-bg-secondary, #1f202e)',
  border: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
  borderRadius: 12,
  padding: 'var(--ui-space-xl, 20px)',
  width: '90%',
  maxWidth: 460,
  maxHeight: '85vh',
  overflowY: 'auto',
  boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
};

const introStyle: React.CSSProperties = {
  fontSize: 12, color: 'var(--theme-text-muted)',
  margin: '0 0 14px', lineHeight: 1.6,
};

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--theme-border)',
  borderRadius: 10,
  padding: 'var(--ui-section-padding, 12px)',
  marginBottom: 'var(--ui-space-md, 12px)',
  background: 'var(--theme-bg, rgba(255,255,255,0.02))',
};

const cardTitleStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  marginBottom: 10,
  fontSize: 13, fontWeight: 600, color: 'var(--theme-text)',
};

const cardBadgeStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 20, height: 20, borderRadius: 4,
  background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)',
  fontSize: 11, fontWeight: 700,
};

const cardSubtitleStyle: React.CSSProperties = {
  marginLeft: 'auto',
  fontSize: 11, fontWeight: 400, color: 'var(--theme-text-muted)',
};

const hintStyle: React.CSSProperties = {
  fontSize: 12, color: 'var(--theme-text-muted)', lineHeight: 1.6,
};

const execRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '6px 8px', borderRadius: 6,
  background: 'var(--theme-bg-tertiary)',
  fontSize: 12,
};

const connectedBoxStyle: React.CSSProperties = {
  marginTop: 10, padding: 10, borderRadius: 8,
  background: 'var(--theme-bg-secondary)',
  border: '1px solid var(--theme-border)',
};

const labelStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 500, color: 'var(--theme-text)',
  marginBottom: 4, display: 'block',
};

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', borderRadius: 6,
  border: '1px solid var(--theme-border, rgba(0,0,0,0.12))',
  background: 'var(--theme-input-bg, #fff)',
  color: 'var(--theme-text, #1f2328)',
  fontSize: 12, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
};

const modeBtnStyle: React.CSSProperties = {
  flex: 1, padding: '8px 10px', borderRadius: 8,
  border: '1px solid', fontSize: 13, fontWeight: 500, cursor: 'pointer',
};

const deviceBtnStyle: React.CSSProperties = {
  padding: '8px 12px', borderRadius: 8, border: '1px solid',
  color: 'var(--theme-text)', fontSize: 13, cursor: 'pointer', textAlign: 'left',
};

const refreshBtnStyle: React.CSSProperties = {
  padding: '7px 12px', borderRadius: 8,
  border: '1px solid var(--theme-accent)', background: 'var(--theme-accent-bg)',
  color: 'var(--theme-accent)', fontSize: 12, fontWeight: 500, cursor: 'pointer',
};

const suggestBtnStyle: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 6,
  border: '1px dashed var(--theme-accent)',
  background: 'transparent', color: 'var(--theme-accent)',
  fontSize: 11, cursor: 'pointer',
  marginBottom: 6,
};

const saveBtnStyle: React.CSSProperties = {
  flex: 1, padding: '9px 12px', borderRadius: 8, border: 'none',
  background: 'var(--theme-accent, #0969da)', color: '#fff',
  fontSize: 13, fontWeight: 600, cursor: 'pointer',
};

const cancelBtnStyle: React.CSSProperties = {
  padding: '9px 16px', borderRadius: 8,
  border: '1px solid var(--theme-border)', background: 'transparent',
  color: 'var(--theme-text-muted)', fontSize: 13, cursor: 'pointer',
};

const closeBtnStyle: React.CSSProperties = {
  background: 'transparent', border: 'none',
  color: 'var(--theme-text-muted)', fontSize: 16, cursor: 'pointer', padding: '2px 6px',
};
