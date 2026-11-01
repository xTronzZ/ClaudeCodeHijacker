const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveClaudeBinary, getClaudeCandidates } = require('./lib/platform.cjs');
const { rewriteRequest, createRelay, redact, parseResponse } = require('./lib/relay.cjs');

function getHelp(platform = process.platform) {
  const discovery = platform === 'win32'
    ? 'Windows: searches %USERPROFILE%\\.local\\bin\\claude.exe and PATH for claude.exe.\nUse a native .exe, not a .cmd launcher.'
    : platform === 'darwin'
      ? 'macOS: searches ~/.local/bin/claude, both Homebrew locations\n(/opt/homebrew/bin/claude and /usr/local/bin/claude), then PATH.'
      : 'Searches ~/.local/bin/claude and PATH for the executable.';
  return `ClaudeCodeHijacker\n\nUsage:\n  node claude-code-relay.cjs [--interactive] [--hi]\n\nOptions:\n  --interactive  Launch the interactive Claude Code terminal UI.\n  --hi           Send Hi with a 128-token output cap instead of the 16-token marker.\n  --help, -h     Show this help without starting the relay.\n\nEnvironment:\n  CLAUDE_BINARY  Optional absolute path to the native Claude Code executable.\n                Set the path without adding quote characters to its value.\n\n${discovery}\nEmpty or relative PATH entries are ignored. Paths containing spaces are supported.\nRequires an interactive terminal for hidden API key entry.\nAllows one real upstream Messages request per run.\n`;
}

async function readKeyWithoutEcho() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') throw new Error('A terminal is required for non-echoed credential input.');
  process.stdout.write('Ready for API credential; input will not be echoed or saved.\n');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let buffer = '';
    const done = () => {
      process.stdin.off('data', onData); process.stdin.off('end', onEnd); process.stdin.off('error', onError);
      process.stdin.setRawMode(false); process.stdin.pause();
    };
    const onEnd = () => { done(); reject(new Error('Credential input ended before Enter was pressed.')); };
    const onError = error => { done(); reject(error); };
    const onData = chunk => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') { done(); reject(new Error('Cancelled')); return; }
        if (char === '\r' || char === '\n') { done(); resolve(buffer.trim()); return; }
        if (char === '\u007f' || char === '\b') buffer = buffer.slice(0, -1);
        else buffer += char;
      }
    };
    process.stdin.on('data', onData); process.stdin.once('end', onEnd); process.stdin.once('error', onError);
  });
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(getHelp()); return 0; }
  const unknown = argv.find(arg => !['--interactive', '--hi', '--hi-test'].includes(arg));
  if (unknown) throw new Error(`Unknown option: ${unknown}. Use --help for available options.`);
  const cliExecutable = await resolveClaudeBinary();
  const root = __dirname;
  const mode = argv.includes('--interactive') ? 'interactive' : 'print';
  const isGreeting = argv.includes('--hi') || argv.includes('--hi-test');
  const maxOutputTokens = isGreeting ? 128 : 16;
  const sessionDir = path.join(root, 'work', `relay-${mode}`);
  const outputDir = path.join(root, 'outputs', isGreeting ? 'hi' : 'relay');
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(path.join(sessionDir, 'empty-project'), { recursive: true });
  await fs.mkdir(path.join(sessionDir, 'config'), { recursive: true });
  const mcpPath = path.join(sessionDir, 'empty-mcp.json');
  await fs.writeFile(mcpPath, '{"mcpServers":{}}');
  let apiKey = await readKeyWithoutEcho();
  if (!apiKey.startsWith('sk-ant-') || apiKey.length < 30) throw new Error('Unexpected credential input; no upstream request sent.');
  let child;
  let childOutput = '';
  let stopTimer;
  let killTimer;
  let timeout;
  let shuttingDown = false;
  let stopReason = null;
  const stopChild = reason => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    stopReason ||= reason;
    child.kill('SIGTERM');
    killTimer ||= setTimeout(() => child.kill('SIGKILL'), 1000);
    killTimer.unref();
  };
  const relay = createRelay({ apiKey, outputDir, mode, maxOutputTokens,
    log: text => process.stdout.write(text), onUpstreamComplete: () => {
      if (mode === 'interactive' && !shuttingDown && !stopTimer) stopTimer = setTimeout(() => stopChild('response-complete'), 4000);
    } });
  apiKey = '';
  const onInterrupt = () => stopChild('SIGINT');
  const onTerminate = () => stopChild('SIGTERM');
  try {
    const baseUrl = await relay.listen();
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_)/i.test(name)) delete env[name];
    Object.assign(env, {
      ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: 'sk-ant-api03-local-relay-placeholder-not-a-real-key',
      CLAUDE_CONFIG_DIR: path.join(sessionDir, 'config'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false', NO_PROXY: '127.0.0.1,localhost',
    });
    const args = ['--safe-mode', '--restricted', '--setting-sources', '', '--tools', '',
      '--strict-mcp-config', '--mcp-config', mcpPath, '--no-chrome', '--disable-slash-commands',
      '--debug-file', path.join(sessionDir, 'debug.log'), '--model', 'claude-haiku-4-5'];
    if (mode === 'print') args.push('-p', '--no-session-persistence', '--output-format', 'json', '--max-budget-usd', '0.01');
    args.push(isGreeting ? 'Hi' : 'Reply exactly: RELAY_READY');
    const startedAt = new Date().toISOString();
    process.stdout.write(`Claude Code executable: ${cliExecutable}\nLocal capture endpoint: ${baseUrl}\nMode: ${mode}; one real upstream request maximum; output limited to ${maxOutputTokens} tokens.\n`);
    child = spawn(cliExecutable, args, { cwd: path.join(sessionDir, 'empty-project'), env,
      stdio: mode === 'interactive' ? 'inherit' : ['ignore', 'pipe', 'pipe'], shell: false,
      windowsHide: process.platform === 'win32' });
    if (mode === 'print') for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      childOutput += chunk.toString(); process.stdout.write(redact(chunk.toString()));
    });
    process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
    timeout = setTimeout(() => { process.stdout.write('\nStopping local relay after 60 seconds.\n'); stopChild('timeout'); }, 60000);
    const result = await new Promise(resolve => {
      let spawnError = null;
      child.once('error', error => { spawnError = error; });
      child.once('close', (code, signal) => resolve({ code, signal, error: spawnError }));
    });
    shuttingDown = true;
    clearTimeout(timeout); clearTimeout(stopTimer); clearTimeout(killTimer);
    await relay.close();
    const state = relay.state;
    const cliOk = result.code === 0 || (mode === 'interactive' && stopReason === 'response-complete');
    const report = { started_at_utc: startedAt, completed_at_utc: new Date().toISOString(), mode, endpoint: baseUrl,
      platform: process.platform, cli_executable: cliExecutable, upstream_forwarding: true,
      credential: 'Dummy credential sent by CLI; real upstream credential held in process memory only',
      upstream_call_count: state.upstreamCallCount, upstream_status: state.upstreamStatus, generated_text: state.responseText,
      upstream_response_ok: state.upstreamResponseOk, cli_ok: cliOk, persistent_user_settings_changed: false,
      exit_code: result.code, signal: result.signal, stop_reason: stopReason,
      stopped_after_successful_capture: stopReason === 'response-complete', error: result.error ? String(result.error.message) : null,
      captured_request_count: state.captures.length,
      captured_messages_count: state.captures.filter(request => request.method === 'POST' && new URL(request.url, baseUrl).pathname.endsWith('/messages')).length,
      child_output: mode === 'print' ? redact(childOutput) : 'Interactive terminal output was not recorded in this report.' };
    await fs.writeFile(path.join(outputDir, `${mode}-report.json`), JSON.stringify(report, null, 2));
    process.stdout.write(`\nLocal capture finished: ${JSON.stringify(report)}\n`);
    return state.upstreamResponseOk && cliOk ? 0 : 1;
  } finally {
    shuttingDown = true;
    clearTimeout(timeout); clearTimeout(stopTimer); clearTimeout(killTimer);
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
    if (child && child.exitCode === null && child.signalCode === null) stopChild('shutdown');
    await relay.close();
  }
}

module.exports = { main, getHelp, readKeyWithoutEcho, resolveClaudeBinary, getClaudeCandidates,
  rewriteRequest, createRelay, redact, parseResponse };

if (require.main === module) main().then(code => { process.exitCode = code; })
  .catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
