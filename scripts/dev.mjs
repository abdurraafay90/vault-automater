// Starts the API, the automation worker and the web console together.
// The worker is what executes scheduled sends and CSV batches, so running the
// console without it means nothing is sent; this keeps all three in step.
import { spawn, spawnSync } from 'node:child_process';
import { PORTS, belongsToProject, commandLine, isPortInUse, listeningPids, liveWorker } from './processes.mjs';

// Refuse to start over an existing instance: a second web/API cannot bind its
// port, and a second worker would (correctly) refuse to run, which previously
// surfaced only as a failure part-way through startup.
const conflicts = [];
let ourInstance = false;
let foreignApp = false;
for (const { port, service } of PORTS) {
  if (!(await isPortInUse(port))) continue;
  const pids = listeningPids(port);
  const ours = pids.some((pid) => belongsToProject(pid));
  if (ours) ourInstance = true; else foreignApp = true;
  conflicts.push(`  - ${service}: port ${port} is already in use${pids.length ? ` (pid ${pids.join(', ')})` : ''}${ours ? ' by an earlier run of this project' : ' by another application'}`);
}
const worker = await liveWorker();
if (worker && commandLine(worker.pid)) {
  ourInstance = true;
  conflicts.push(`  - worker: already running (pid ${worker.pid})`);
}
if (conflicts.length) {
  console.error(`Cannot start: Vaultflow is already running, or its ports are taken.\n${conflicts.join('\n')}\n`);
  if (ourInstance) {
    console.error('An earlier run is still going. Either use it at http://localhost:4560,');
    console.error('or replace it:\n  npm run dev:stop\n  npm run dev\n');
  }
  if (foreignApp) {
    console.error('Another application is using a required port. Close it first (npm run dev:stop will not touch it).');
  }
  process.exit(1);
}

const services = [
  { name: 'api', script: 'dev:api', color: 36 },
  { name: 'worker', script: 'dev:worker', color: 35 },
  { name: 'web', script: 'dev:web', color: 32 },
];

const children = [];
let shuttingDown = false;

function prefix(name, color) {
  return `\x1b[${color}m[${name.padEnd(6)}]\x1b[0m `;
}

function pipe(stream, target, label) {
  let buffered = '';
  stream.on('data', (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) target.write(`${label}${line}\n`);
  });
}

function stopAll(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    // npm runs each service in a shell; kill the whole tree.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  process.exit(exitCode);
}

for (const service of services) {
  const label = prefix(service.name, service.color);
  const child = spawn('npm', ['run', service.script], { shell: true, env: process.env });
  children.push(child);
  pipe(child.stdout, process.stdout, label);
  pipe(child.stderr, process.stderr, label);
  child.on('exit', (code) => {
    if (shuttingDown) return;
    process.stderr.write(`${label}exited with code ${code}; stopping the other services.\n`);
    stopAll(code ?? 1);
  });
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
