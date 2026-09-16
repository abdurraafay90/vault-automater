// Stops this project's API, web console and worker if they are still running
// (e.g. left over from another terminal). Never touches other applications.
import { PORTS, belongsToProject, commandLine, killTree, listeningPids, liveWorker } from './processes.mjs';

let stopped = 0;
for (const { port, service } of PORTS) {
  for (const pid of listeningPids(port)) {
    if (belongsToProject(pid)) {
      killTree(pid);
      stopped++;
      console.log(`stopped ${service} (pid ${pid}, port ${port})`);
    } else {
      console.log(`port ${port} is used by another application (pid ${pid}: ${commandLine(pid).slice(0, 80) || 'unknown'}) — left running`);
    }
  }
}

// Give a launcher we just stopped a moment to take its worker down with it.
await new Promise((resolve) => setTimeout(resolve, stopped ? 1500 : 0));
const worker = await liveWorker();
// A fresh heartbeat can outlive its process by a few seconds; only act on a
// worker process that still exists.
if (worker && commandLine(worker.pid)) {
  if (belongsToProject(worker.pid)) {
    killTree(worker.pid);
    stopped++;
    console.log(`stopped worker (pid ${worker.pid})`);
  } else {
    console.log(`a worker heartbeat points at pid ${worker.pid}, which is not this project's process — left running`);
  }
}

console.log(stopped ? `Done. You can now run: npm run dev` : 'Nothing from this project was running.');
