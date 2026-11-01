const { spawn } = require('node:child_process');
const { startLifecycleGuard } = require('../../lib/lifecycle.cjs');

async function main() {
  const guard = await startLifecycleGuard(process.argv[2]);
  const backgroundCode = `
    const net = require('node:net');
    const server = net.createServer(socket => socket.end('fixture'));
    server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
    process.on('disconnect', () => {});
  `;
  const claudeCode = `
    const { spawn } = require('node:child_process');
    const background = spawn(process.execPath, ['-e', ${JSON.stringify(backgroundCode)}], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    background.once('message', data => process.send({ ...data, backgroundPid: background.pid }));
    process.on('SIGINT', () => process.exit(0));
    process.on('disconnect', () => {});
    setInterval(() => {}, 1000);
  `;
  const claude = spawn(process.execPath, ['-e', claudeCode], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  claude.once('message', async data => {
    await guard.track();
    process.send({ ...data, claudePid: claude.pid, guardPid: guard.pid });
  });
  process.on('message', message => { if (message === 'claude-exit') claude.kill('SIGINT'); });
  claude.once('exit', async () => {
    await guard.finish('claude-exit');
    if (process.connected) process.disconnect();
  });
}

main().catch(error => { console.error(error); process.exit(1); });
