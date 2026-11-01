const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function listProcesses() {
  if (process.platform === 'win32') {
    const command = 'Get-CimInstance Win32_Process | ForEach-Object { @{ pid = $_.ProcessId; parent = $_.ParentProcessId; start = [string]$_.CreationDate.ToFileTimeUtc(); command = $_.CommandLine; zombie = $false } } | ConvertTo-Json -Compress';
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
      { timeout: 10000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,stat=,lstart=,command='], {
    timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' },
  });
  return stdout.split('\n').filter(line => line.trim()).map(line => {
    const fields = line.trim().split(/\s+/);
    return { pid: Number(fields[0]), parent: Number(fields[1]), zombie: fields[2].includes('Z'),
      start: fields.slice(3, 8).join(' '), command: fields.slice(8).join(' ') };
  });
}

function collectOwned(processes, ownerPid, guardPid, scopeDir, known) {
  const live = new Map(processes.filter(item => !item.zombie).map(item => [item.pid, item]));
  const owned = new Map();
  for (const [pid, start] of known) {
    if (live.get(pid)?.start === start) owned.set(pid, live.get(pid));
  }
  // Chrome's crash reporter can reparent itself before a process-tree sample.
  // Its per-run profile path still identifies this session's browser precisely.
  for (const item of live.values()) {
    if (item.pid === ownerPid || item.pid === guardPid) continue;
    if (item.command?.includes(path.join(scopeDir, 'browser-profile')) &&
      /(?:--user-data-dir|--database)=?/.test(item.command)) owned.set(item.pid, item);
  }
  const parents = new Set([ownerPid, ...owned.keys()]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of live.values()) {
      if (item.pid === ownerPid || item.pid === guardPid || owned.has(item.pid)) continue;
      if (parents.has(item.parent)) {
        owned.set(item.pid, item);
        parents.add(item.pid);
        changed = true;
      }
    }
  }
  known.clear();
  for (const item of owned.values()) known.set(item.pid, item.start);
  return [...owned.values()];
}

async function runGuard(ownerPid, scopeDir) {
  const known = new Map();
  let stopping;
  let scan = Promise.resolve();
  const refresh = () => {
    const task = scan.then(async () => collectOwned(await listProcesses(), ownerPid, process.pid, scopeDir, known));
    scan = task.catch(() => {});
    return task;
  };
  const signalOwned = (owned, signal) => {
    for (const item of [...owned].reverse()) {
      try { process.kill(item.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  let timer;
  const cleanup = reason => {
    if (stopping) return stopping;
    clearInterval(timer);
    stopping = (async () => {
      let remaining = await refresh();
      const signalled = remaining.map(item => item.pid);
      signalOwned(remaining, 'SIGTERM');
      const gracefulDeadline = Date.now() + 2000;
      while (remaining.length && Date.now() < gracefulDeadline) {
        await pause(100);
        remaining = await refresh();
      }
      if (remaining.length) signalOwned(remaining, 'SIGKILL');
      const forceDeadline = Date.now() + 2000;
      while (remaining.length && Date.now() < forceDeadline) {
        await pause(100);
        remaining = await refresh();
      }
      await fs.writeFile(path.join(scopeDir, 'cleanup.json'), JSON.stringify({
        reason, completed_at_utc: new Date().toISOString(), signalled_pids: signalled,
        remaining_pids: remaining.map(item => item.pid),
      }, null, 2));
      if (process.connected) process.disconnect();
      process.exitCode = remaining.length ? 1 : 0;
    })();
    stopping.catch(async error => {
      await fs.appendFile(path.join(scopeDir, 'lifecycle.log'), `${new Date().toISOString()} ${error.message}\n`);
      if (process.connected) process.disconnect();
      process.exitCode = 1;
    });
    return stopping;
  };
  process.on('message', message => {
    if (message?.type === 'shutdown') void cleanup(message.reason || 'claude-exit');
    else if (message?.type === 'track') {
      void refresh().then(() => { if (process.connected) process.send({ type: 'tracked' }); });
    }
  });
  process.on('disconnect', () => { void cleanup('relay-exit'); });
  process.on('SIGTERM', () => { void cleanup('SIGTERM'); });
  process.on('SIGHUP', () => { void cleanup('SIGHUP'); });
  await refresh();
  timer = setInterval(() => { void refresh().catch(() => {}); }, process.platform === 'win32' ? 1000 : 250);
  process.send({ type: 'ready' });
}

async function startLifecycleGuard(scopeDir) {
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const guard = spawn(process.execPath, [__filename, String(process.pid), scopeDir], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env, windowsHide: true,
  });
  const exited = new Promise((resolve, reject) => {
    guard.once('error', reject);
    guard.once('exit', (code, signal) => resolve({ code, signal }));
  });
  await Promise.race([
    new Promise(resolve => guard.on('message', message => { if (message?.type === 'ready') resolve(); })),
    exited.then(() => { throw new Error('Unable to start session cleanup guard.'); }),
  ]);
  let finishing;
  return {
    pid: guard.pid,
    async track() {
      await Promise.race([new Promise((resolve, reject) => {
        const onMessage = message => {
          if (message?.type !== 'tracked') return;
          guard.off('message', onMessage); resolve();
        };
        guard.on('message', onMessage);
        guard.send({ type: 'track' }, error => { if (error) { guard.off('message', onMessage); reject(error); } });
      }), exited.then(() => { throw new Error('Session cleanup guard exited unexpectedly.'); })]);
    },
    finish(reason = 'claude-exit') {
      if (!finishing) finishing = (async () => {
        if (guard.connected) guard.send({ type: 'shutdown', reason }, () => {});
        const result = await exited;
        if (result.code !== 0) throw new Error(`Session cleanup failed; inspect ${path.join(scopeDir, 'cleanup.json')}.`);
      })();
      return finishing;
    },
  };
}

module.exports = { startLifecycleGuard, collectOwned };

if (require.main === module) runGuard(Number(process.argv[2]), path.resolve(process.argv[3]))
  .catch(error => { if (process.connected) process.disconnect(); process.exitCode = 1; });
