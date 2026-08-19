import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Terminate a spawned engine process together with everything it started.
 *
 * Chromium is a process TREE: the browser process spawns renderer/GPU/utility children, and killing
 * only the parent leaves them running. On POSIX the launcher spawns detached (its own process group),
 * so a negative-pid signal reaches the whole group. Windows has no process groups to signal and Node's
 * `child.kill` is a bare `TerminateProcess` of the browser process alone, which strands chrome.exe
 * children that keep the user-data-dir lock and make the profile's next launch fail — so the tree is
 * walked by `taskkill /T` instead, falling back to the single-process kill if taskkill is unavailable.
 */
export function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  const killDirect = (): void => {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  };
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
    } catch {
      killDirect();
    }
    return;
  }
  // /F is the Windows equivalent of SIGKILL; without it taskkill asks the tree's windows to close,
  // which is what a SIGTERM escalation step should try first.
  const args = ['/pid', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])];
  let killer: ChildProcess;
  try {
    killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
  } catch {
    killDirect();
    return;
  }
  killer.once('error', killDirect);
  killer.once('exit', (code) => {
    // taskkill reports a non-zero code when the pid is already gone as well as when it could not do
    // the job, so only re-kill a child that is demonstrably still alive.
    if (code !== 0 && child.exitCode === null && child.signalCode === null) killDirect();
  });
}
