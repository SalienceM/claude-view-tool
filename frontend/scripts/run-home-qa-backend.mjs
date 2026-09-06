import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const profile = process.env.HOME_QA_PROFILE === 'stress' ? 'stress' : 'typical';
const wsPort = Number(process.env.HOME_QA_WS_PORT || 45421);
const webPort = Number(process.env.HOME_QA_WEB_PORT || 55173);
const controlPort = Number(process.env.HOME_QA_CONTROL_PORT || 45423);
const dataRoot = path.join(repoRoot, '.qa', 'home', profile, 'data');

let backendChild;
let viteChild;
let controlServer;
let stopping = false;
let backendIntentionalStop = false;
let injectedTaskIds = [];
const lateBackendId = 'qa-late-backend';
const eventSessionId = profile === 'stress' ? 'qa-chat-060' : 'qa-chat-004';

function startBackend() {
  if (backendChild && backendChild.exitCode === null && !backendChild.killed) return backendChild;
  backendIntentionalStop = false;
  backendChild = spawn(
    'python',
    ['-m', 'src.ws_main', '--bind', '127.0.0.1', '--port', String(wsPort)],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        AGENT_WITH_U_DATA_ROOT: dataRoot,
        AGENT_WITH_U_RELAY_URL: '',
        AGENT_WITH_U_RELAY_TOKEN: '',
      },
    },
  );
  backendChild.once('exit', (code) => {
    if (!stopping && !backendIntentionalStop) stop(code ?? 1);
  });
  return backendChild;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  controlServer?.close();
  if (viteChild && !viteChild.killed) viteChild.kill();
  if (backendChild && !backendChild.killed) backendChild.kill();
  process.exit(code);
}

function waitForBackend(timeoutMs = 15_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port: wsPort });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - startedAt >= timeoutMs) reject(new Error('backend readiness timeout'));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function stopBackend() {
  return new Promise((resolve) => {
    if (!backendChild || backendChild.exitCode !== null) {
      resolve();
      return;
    }
    backendIntentionalStop = true;
    backendChild.once('exit', resolve);
    backendChild.kill();
  });
}

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`RPC timeout: ${method}`));
    }, 5000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: 'qa-control', method, params }));
    });
    socket.addEventListener('message', (event) => {
      const payload = JSON.parse(String(event.data));
      if (payload.id !== 'qa-control') return;
      clearTimeout(timer);
      socket.close();
      if (payload.error) reject(new Error(String(payload.error)));
      else resolve(payload.result);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket failed: ${method}`));
    });
  });
}

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  response.end(JSON.stringify(body));
}

async function injectTask() {
  const raw = await rpc('seqtaskAdd', [
    eventSessionId,
    `Browser realtime event ${Date.now()}-${injectedTaskIds.length}`,
    '',
  ]);
  const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const tasks = Array.isArray(result?.seqTasks) ? result.seqTasks : [];
  const taskId = tasks.at(-1)?.id || '';
  if (taskId) injectedTaskIds.push(taskId);
  return taskId;
}

async function removeLateBackend() {
  await rpc('deleteBackend', [lateBackendId]);
}

async function addLateBackend() {
  await removeLateBackend();
  await rpc('saveBackend', [JSON.stringify({
    id: lateBackendId,
    type: 'openai-compatible',
    label: 'QA 延迟出现模型',
    enabled: true,
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'qa-late',
    apiKey: 'qa-placeholder',
    skipPermissions: true,
  })]);
}

function startControlServer() {
  controlServer = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://127.0.0.1:${controlPort}`);
      if (url.pathname === '/backend/stop') {
        await stopBackend();
        json(response, 200, { status: 'stopped' });
      } else if (url.pathname === '/backend/start') {
        startBackend();
        await waitForBackend();
        json(response, 200, { status: 'started' });
      } else if (url.pathname === '/backend/fixture/add-late') {
        await addLateBackend();
        json(response, 200, { status: 'added', backendId: lateBackendId });
      } else if (url.pathname === '/backend/fixture/remove-late') {
        await removeLateBackend();
        json(response, 200, { status: 'removed', backendId: lateBackendId });
      } else if (url.pathname === '/event/task/burst') {
        const count = Math.max(1, Math.min(50, Number(url.searchParams.get('count')) || 20));
        const taskIds = [];
        for (let index = 0; index < count; index += 1) taskIds.push(await injectTask());
        json(response, 200, { status: 'emitted', count, taskIds });
      } else if (url.pathname === '/event/task') {
        const raw = await rpc('seqtaskAdd', [
          eventSessionId,
          `浏览器实时事件 ${Date.now()}`,
          '',
        ]);
        const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const tasks = Array.isArray(result?.seqTasks) ? result.seqTasks : [];
        const taskId = tasks.at(-1)?.id || '';
        if (taskId) injectedTaskIds.push(taskId);
        json(response, 200, { status: 'emitted', taskId });
      } else if (url.pathname === '/event/task/remove') {
        for (const taskId of injectedTaskIds.splice(0)) {
          await rpc('seqtaskRemove', [eventSessionId, taskId]);
        }
        json(response, 200, { status: 'removed' });
      } else if (url.pathname === '/status') {
        json(response, 200, {
          backend: Boolean(backendChild && backendChild.exitCode === null && !backendChild.killed),
        });
      } else {
        json(response, 404, { status: 'not-found' });
      }
    } catch (error) {
      json(response, 500, { status: 'error', message: String(error) });
    }
  });
  controlServer.listen(controlPort, '127.0.0.1');
}

async function startRuntime() {
  startBackend();
  await waitForBackend();
  startControlServer();
  const viteCommand = process.platform === 'win32'
    ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm run dev -- --host 127.0.0.1 --port ${webPort} --strictPort`]]
    : ['npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort']];
  viteChild = spawn(
    viteCommand[0],
    viteCommand[1],
    {
      cwd: path.join(repoRoot, 'frontend'),
      stdio: 'inherit',
      env: { ...process.env, VITE_AGENT_WITH_U_WS_PORT: String(wsPort) },
    },
  );
  viteChild.once('exit', (code) => {
    if (!stopping) stop(code ?? 1);
  });
}

process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
process.once('SIGHUP', () => stop());
startRuntime().catch((error) => {
  console.error(error);
  stop(1);
});
