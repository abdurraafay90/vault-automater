// Helpers shared by dev.mjs and stop.mjs to find this project's running
// services. Only processes whose command line points into this repository are
// ever reported as ours, so an unrelated app on the same port is never killed.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PORTS = [
  { port: 4000, service: 'api' },
  { port: 4560, service: 'web' },
];
const HEARTBEAT_STALE_MS = 10_000;
const isWindows = process.platform === 'win32';

function tryConnect(host, port) {
  return new Promise((done) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(800);
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('timeout', () => { socket.destroy(); done(false); });
    socket.once('error', () => done(false));
  });
}

export async function isPortInUse(port) {
  return (await tryConnect('127.0.0.1', port)) || (await tryConnect('::1', port));
}

export function listeningPids(port) {
  if (isWindows) {
    const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }).stdout ?? '';
    const tcp6 = spawnSync('netstat', ['-ano', '-p', 'TCPv6'], { encoding: 'utf8' }).stdout ?? '';
    const pids = new Set();
    for (const line of `${out}\n${tcp6}`.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && parts[3] === 'LISTENING' && parts[1]?.endsWith(`:${port}`)) pids.add(Number(parts[4]));
    }
    return [...pids].filter((pid) => pid > 0);
  }
  const out = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout ?? '';
  return out.split(/\s+/).filter(Boolean).map(Number);
}

export function commandLine(pid) {
  if (isWindows) {
    const out = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8' }).stdout ?? '';
    return out.trim();
  }
  return (spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '').trim();
}

export function belongsToProject(pid) {
  const cmd = commandLine(pid).replaceAll('\\', '/').toLowerCase();
  return cmd.includes(ROOT.replaceAll('\\', '/').toLowerCase());
}

/** The worker currently heartbeating against .data/auth.sqlite, if any. */
export async function liveWorker() {
  const db = resolve(ROOT, '.data', 'auth.sqlite');
  if (!existsSync(db)) return null;
  process.removeAllListeners('warning'); // hide node:sqlite's ExperimentalWarning
  const { DatabaseSync } = await import('node:sqlite');
  const conn = new DatabaseSync(db, { readOnly: true });
  try {
    const row = conn.prepare('SELECT pid, beat_at FROM automation_worker_heartbeat WHERE id = 1').get();
    return row && Date.now() - Number(row.beat_at) < HEARTBEAT_STALE_MS ? { pid: Number(row.pid) } : null;
  } catch {
    return null; // table not created yet
  } finally {
    conn.close();
  }
}

export function killTree(pid) {
  if (isWindows) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(pid, 'SIGTERM'); } catch {}
}
