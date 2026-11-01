const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { collectOwned } = require('../lib/lifecycle.cjs');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('cleanup ownership follows descendants and rejects unrelated sessions and reused PIDs', () => {
  const scopeDir = '/fixture/session-one';
  const known = new Map([[20, 'old-start'], [30, 'same-start']]);
  const processes = [
    { pid: 10, parent: 1, start: 'owner', command: 'relay' },
    { pid: 11, parent: 10, start: 'guard', command: 'guard' },
    { pid: 12, parent: 11, start: 'ps', command: 'ps' },
    { pid: 20, parent: 1, start: 'new-start', command: 'other-session' },
    { pid: 30, parent: 1, start: 'same-start', command: 'orphaned-child' },
    { pid: 40, parent: 10, start: 'child', command: 'claude' },
    { pid: 41, parent: 40, start: 'grandchild', command: 'mcp' },
    { pid: 50, parent: 1, start: 'browser', command: `chrome --user-data-dir=${scopeDir}/browser-profile` },
    { pid: 60, parent: 1, start: 'other-browser', command: 'chrome --user-data-dir=/fixture/session-two/browser-profile' },
  ];
  assert.deepEqual(collectOwned(processes, 10, 11, scopeDir, known).map(item => item.pid).sort((a, b) => a - b),
    [30, 40, 41, 50]);
});

async function portIsOpen(port) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

for (const ending of ['claude-exit', 'SIGHUP', 'SIGKILL']) {
  test(`session cleanup closes detached descendants after ${ending} without touching another session`,
    { timeout: 20000, skip: process.platform === 'win32' && ending !== 'claude-exit' }, async t => {
      const scopeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-lifecycle-'));
      const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      const owner = spawn(process.execPath, [path.join(__dirname, 'fixtures/lifecycle-owner.cjs'), scopeDir],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let childInfo;
      t.after(async () => {
        for (const pid of [owner.pid, unrelated.pid, childInfo?.claudePid, childInfo?.backgroundPid]) {
          if (!pid) continue;
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
        await fs.rm(scopeDir, { recursive: true, force: true });
      });
      [childInfo] = await once(owner, 'message');
      assert.equal(await portIsOpen(childInfo.port), true);
      if (ending === 'claude-exit') owner.send(ending);
      else owner.kill(ending);
      let report;
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        try { report = JSON.parse(await fs.readFile(path.join(scopeDir, 'cleanup.json'), 'utf8')); break; }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        await pause(100);
      }
      assert.ok(report, `Missing cleanup report for ${ending}`);
      assert.deepEqual(report.remaining_pids, []);
      assert.equal(await portIsOpen(childInfo.port), false);
      assert.equal(unrelated.exitCode, null);
      assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
    });
}
