const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadApiKey } = require('./lib/env.cjs');
const { resolveClaudeBinary } = require('./lib/platform.cjs');
const { createRelay, redact } = require('./lib/relay.cjs');
const { startLifecycleGuard } = require('./lib/lifecycle.cjs');

function getHelp(platform = process.platform) {
  const discovery = platform === 'win32'
    ? 'Windows: searches %USERPROFILE%\\.local\\bin\\claude.exe and PATH for claude.exe.\nUse a native .exe, not a .cmd launcher.'
    : platform === 'darwin'
      ? 'macOS: searches ~/.local/bin/claude, both Homebrew locations\n(/opt/homebrew/bin/claude and /usr/local/bin/claude), then PATH.'
      : 'Searches ~/.local/bin/claude and PATH for the executable.';
  return `ClaudeCodeHijacker\n\nUsage:\n  node claude-code-relay.cjs [--project DIR] [-- CLAUDE_ARGS...]\n\nOptions:\n  --project DIR  Claude working directory (defaults to the current directory).\n  --help, -h     Show this help.\n\nArguments after -- are passed directly to Claude Code.\nExample: node claude-code-relay.cjs --project ../my-app -- --model haiku\n\nEnvironment:\n  CLAUDE_RELAY_API_KEY  Preferred API key variable.\n  ANTHROPIC_API_KEY     Compatible API key variable.\n  CLAUDE_BINARY         Optional absolute path to the native Claude Code executable.\n\nThe relay checks process environment variables, then ${path.join(__dirname, '.env')}, and falls back to hidden terminal input.\n${discovery}\nRelay activity is written only to outputs/sessions/<run-id>/ and is never printed over the Claude UI.\n`;
}

function parseOptions(argv) {
  const separator = argv.indexOf('--');
  const relayArgs = separator === -1 ? argv : argv.slice(0, separator);
  const claudeArgs = separator === -1 ? [] : argv.slice(separator + 1);
  const options = { help: false, project: null, claudeArgs };
  for (let index = 0; index < relayArgs.length; index += 1) {
    const arg = relayArgs[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--project') {
      const value = relayArgs[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--project requires a directory.');
      options.project = value;
      index += 1;
    } else throw new Error(`Unknown option: ${arg}. Use --help for available options.`);
  }
  return options;
}

function createChildEnvironment(parentEnv, baseUrl) {
  const env = { ...parentEnv };
  for (const name of Object.keys(env)) {
    if (/^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)|CLAUDE_(BINARY|RELAY_API_KEY))$/i.test(name)) delete env[name];
  }
  const noProxy = [env.NO_PROXY || env.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
  return Object.assign(env, {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: 'sk-ant-api03-local-relay-placeholder-not-a-real-key',
    CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
    NO_PROXY: noProxy,
  });
}

async function prepareClaudeArgs(claudeArgs, outputDir) {
  if (claudeArgs.some(arg => arg === '--mcp-config' || arg.startsWith('--mcp-config='))) {
    return [...claudeArgs];
  }
  const configPath = path.join(outputDir, 'playwright-mcp.json');
  const config = { mcpServers: { playwright: {
    type: 'stdio', command: 'npx', args: [
      '--yes', '--cache', path.join(__dirname, 'outputs', 'playwright', 'npm-cache'),
      '@playwright/mcp@0.0.84', '--browser', 'chrome',
      '--user-data-dir', path.join(outputDir, 'browser-profile'),
      '--output-dir', path.join(outputDir, 'browser'),
    ],
  } } };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  const args = [...claudeArgs];
  const endOfOptions = args.indexOf('--');
  args.splice(endOfOptions === -1 ? args.length : endOfOptions, 0, '--mcp-config', configPath);
  return args;
}

async function readKeyWithoutEcho() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('A terminal is required for non-echoed credential input.');
  }
  process.stdout.write('Anthropic API key (hidden): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let buffer = '';
    const done = () => {
      process.stdin.off('data', onData); process.stdin.off('end', onEnd); process.stdin.off('error', onError);
      process.stdin.setRawMode(false); process.stdin.pause();
      process.stdout.write('\n');
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
  const options = parseOptions(argv);
  if (options.help) { process.stdout.write(getHelp()); return 0; }

  const projectDir = path.resolve(options.project || process.cwd());
  let projectStat;
  try { projectStat = await fs.stat(projectDir); } catch { throw new Error(`Project directory does not exist: ${projectDir}`); }
  if (!projectStat.isDirectory()) throw new Error(`Project path is not a directory: ${projectDir}`);

  const cliExecutable = await resolveClaudeBinary();
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const outputDir = path.join(__dirname, 'outputs', 'sessions', runId);
  await fs.mkdir(outputDir, { recursive: true });
  const claudeArgs = await prepareClaudeArgs(options.claudeArgs, outputDir);

  const loadedCredential = await loadApiKey({ envPath: path.join(__dirname, '.env') });
  let apiKey = loadedCredential?.apiKey || await readKeyWithoutEcho();
  if (!apiKey.startsWith('sk-ant-') || apiKey.length < 30) throw new Error('Unexpected credential input; no upstream request sent.');

  let child;
  let guard;
  let stopReason = null;
  const relay = createRelay({ apiKey, outputDir });
  apiKey = '';
  // Claude handles Ctrl+C itself while its UI is active. Cleanup starts only
  // when Claude exits; cancelling a turn must not tear down its MCP/browser.
  const onInterrupt = () => {};
  const requestShutdown = signal => {
    stopReason ||= signal;
    void relay.close().catch(() => {});
    void guard?.finish(signal).catch(() => {});
  };
  const onTerminate = () => requestShutdown('SIGTERM');
  const onHangup = () => requestShutdown('SIGHUP');

  try {
    guard = await startLifecycleGuard(outputDir);
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    process.on('SIGHUP', onHangup);
    const baseUrl = await relay.listen();
    if (stopReason) return 1;
    const env = createChildEnvironment(process.env, baseUrl);

    const startedAt = new Date().toISOString();
    child = spawn(cliExecutable, claudeArgs, {
      cwd: projectDir, env, stdio: 'inherit', shell: false,
      windowsHide: process.platform === 'win32',
    });
    const childResult = new Promise(resolve => {
      let spawnError = null;
      child.once('error', error => { spawnError = error; });
      child.once('close', (code, signal) => resolve({ code, signal, error: spawnError }));
    });
    await guard.track();
    const result = await childResult;

    await relay.close();
    await guard.finish(stopReason || 'claude-exit');
    const state = relay.state;
    const cliOk = result.code === 0 || result.code === 130 || result.signal === 'SIGINT';
    const report = {
      started_at_utc: startedAt,
      completed_at_utc: new Date().toISOString(),
      endpoint: baseUrl,
      platform: process.platform,
      cli_executable: cliExecutable,
      project_directory: projectDir,
      upstream_call_count: state.upstreamCallCount,
      successful_upstream_call_count: state.successfulUpstreamCallCount,
      last_upstream_status: state.upstreamStatus,
      cli_ok: cliOk,
      exit_code: result.code,
      signal: result.signal,
      stop_reason: stopReason,
      error: result.error ? String(result.error.message) : null,
      captured_request_count: state.captures.length,
    };
    await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
    return cliOk ? 0 : 1;
  } finally {
    try {
      await relay.close();
      await guard?.finish(stopReason || 'relay-exit');
    } finally {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      process.off('SIGHUP', onHangup);
    }
  }
}

module.exports = { main, getHelp, parseOptions, readKeyWithoutEcho, createChildEnvironment, prepareClaudeArgs };

if (require.main === module) main().then(code => { process.exitCode = code; })
  .catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
