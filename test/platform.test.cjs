const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getClaudeCandidates, resolveClaudeBinary, isNativeExecutable } = require('../lib/platform.cjs');

function simulated(options, available) {
  const probed = [];
  return { probed, result: resolveClaudeBinary({ env: {}, homedir: '/Users/example', ...options,
    isExecutable: async candidate => { probed.push(candidate); return available.includes(candidate); } }) };
}

test('macOS arm64 prefers the user installation, then Apple Silicon Homebrew', async () => {
  const user = '/Users/Ada Lovelace/.local/bin/claude';
  const run = simulated({ platform: 'darwin', arch: 'arm64', homedir: '/Users/Ada Lovelace', env: { PATH: '/some/bin' } },
    [user, '/opt/homebrew/bin/claude']);
  assert.equal(await run.result, user);
  assert.deepEqual(run.probed, [user]);
  const fallback = simulated({ platform: 'darwin', arch: 'arm64' }, ['/opt/homebrew/bin/claude', '/usr/local/bin/claude']);
  assert.equal(await fallback.result, '/opt/homebrew/bin/claude');
  assert.deepEqual(fallback.probed, ['/Users/example/.local/bin/claude', '/opt/homebrew/bin/claude']);
});

test('macOS Intel prefers /usr/local Homebrew and can fall back to Apple Silicon location', async () => {
  const intel = simulated({ platform: 'darwin', arch: 'x64' }, ['/usr/local/bin/claude', '/opt/homebrew/bin/claude']);
  assert.equal(await intel.result, '/usr/local/bin/claude');
  const alternate = simulated({ platform: 'darwin', arch: 'x64' }, ['/opt/homebrew/bin/claude']);
  assert.equal(await alternate.result, '/opt/homebrew/bin/claude');
  assert.deepEqual(alternate.probed.slice(1), ['/usr/local/bin/claude', '/opt/homebrew/bin/claude']);
});

test('macOS resolves an absolute PATH installation with spaces after standard locations', async () => {
  const candidate = '/Applications/Claude Tools/bin/claude';
  const run = simulated({ platform: 'darwin', arch: 'arm64', env: { PATH: '/missing/bin:/Applications/Claude Tools/bin' } }, [candidate]);
  assert.equal(await run.result, candidate);
  assert.equal(run.probed.at(-1), candidate);
});

test('Windows uses native .exe candidates and a case-insensitive Path variable', async () => {
  const candidate = 'C:\\Program Files\\Claude Tools\\claude.exe';
  const run = simulated({ platform: 'win32', homedir: 'C:\\Users\\Ada Lovelace',
    env: { Path: '"C:\\Program Files\\Claude Tools";C:\\Other' } }, [candidate]);
  assert.equal(await run.result, candidate);
  assert.deepEqual(run.probed, ['C:\\Users\\Ada Lovelace\\.local\\bin\\claude.exe', candidate]);
});

test('an absolute override with spaces is used verbatim without shell quoting', async () => {
  for (const [platform, override] of [['win32', 'C:\\Tools With Spaces\\claude.exe'], ['darwin', '/Applications/Claude Tools/claude']]) {
    const run = simulated({ platform, env: { CLAUDE_BINARY: override, PATH: '/ignored' } }, [override]);
    assert.equal(await run.result, override);
    assert.deepEqual(run.probed, [override]);
  }
});

test('Windows finds CLAUDE_BINARY without relying on environment key casing', async () => {
  const candidate = 'D:\\Native Claude\\claude.EXE';
  const run = simulated({ platform: 'win32', env: { claude_binary: candidate } }, [candidate]);
  assert.equal(await run.result, candidate);
});

test('invalid overrides fail without silently falling back to another executable', async () => {
  for (const override of ['claude', './claude', '"/Applications/Claude Tools/claude"']) {
    await assert.rejects(resolveClaudeBinary({ platform: 'darwin', env: { CLAUDE_BINARY: override }, isExecutable: async () => true }), /absolute path/);
  }
  await assert.rejects(resolveClaudeBinary({ platform: 'win32', env: { CLAUDE_BINARY: 'C:\\Tools\\claude.cmd' }, isExecutable: async () => true }), /native claude.exe/);
  for (const override of ['C:Tools\\claude.exe', '\\Tools\\claude.exe', '"C:\\Tools\\claude.exe"']) {
    await assert.rejects(resolveClaudeBinary({ platform: 'win32', env: { CLAUDE_BINARY: override }, isExecutable: async () => true }), /absolute path/);
  }
  const invalid = simulated({ platform: 'darwin', env: { CLAUDE_BINARY: '/missing/claude', PATH: '/working/bin' } }, ['/working/bin/claude']);
  await assert.rejects(invalid.result, /CLAUDE_BINARY is not an executable file/);
  assert.deepEqual(invalid.probed, ['/missing/claude']);
});

test('empty and relative PATH entries never search the current working directory', () => {
  assert.deepEqual(getClaudeCandidates({ platform: 'darwin', arch: 'arm64', homedir: '/Users/example',
    env: { PATH: ':.:relative/bin:~/bin:/valid/bin::/valid/bin' } }), [
    '/Users/example/.local/bin/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/valid/bin/claude',
  ]);
  assert.deepEqual(getClaudeCandidates({ platform: 'win32', homedir: 'C:\\Users\\example',
    env: { Path: ';.;relative;\\drive-relative;C:\\Valid;C:\\VALID;"C:\\With Spaces"' } }), [
    'C:\\Users\\example\\.local\\bin\\claude.exe', 'C:\\Valid\\claude.exe', 'C:\\With Spaces\\claude.exe',
  ]);
});

test('a missing executable reports an actionable platform-specific error', async () => {
  const mac = simulated({ platform: 'darwin' }, []);
  await assert.rejects(mac.result, /absolute path of claude\./);
  const windows = simulated({ platform: 'win32', homedir: 'C:\\Users\\example' }, []);
  await assert.rejects(windows.result, /absolute path of claude.exe/);
});

test('executable validation rejects directories and nonexistent files', async () => {
  assert.equal(await isNativeExecutable(__dirname, { platform: process.platform }), false);
  assert.equal(await isNativeExecutable(path.join(__dirname, 'not-installed-claude'), { platform: process.platform }), false);
});

test('requiring the entrypoint has no startup side effects', () => {
  const entrypoint = require.resolve('../claude-code-relay.cjs');
  const result = spawnSync(process.execPath, ['-e', 'const relay = require(process.argv[1]); process.stdout.write(typeof relay.main + " " + typeof relay.parseOptions);', entrypoint], { encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'function function');
  assert.equal(result.stderr, '');
});

test('help describes macOS and Windows discovery without starting the relay', () => {
  const { getHelp } = require('../claude-code-relay.cjs');
  assert.match(getHelp('darwin'), /\/opt\/homebrew\/bin\/claude/);
  assert.match(getHelp('darwin'), /\/usr\/local\/bin\/claude/);
  assert.match(getHelp('win32'), /claude\.exe/);
  assert.match(getHelp('darwin'), /--project/);
  assert.doesNotMatch(getHelp('darwin'), /--hi|--full|interactive|demonstration/);
});

test('default relay options accept a project and pass trailing arguments to Claude', () => {
  const { parseOptions } = require('../claude-code-relay.cjs');
  assert.deepEqual(parseOptions(['--project', '/tmp/example', '--', '--model', 'haiku']), {
    help: false, project: '/tmp/example', claudeArgs: ['--model', 'haiku'],
  });
  assert.deepEqual(parseOptions([]), { help: false, project: null, claudeArgs: [] });
  assert.throws(() => parseOptions(['--full']), /Unknown option/);
  assert.throws(() => parseOptions(['--project']), /requires a directory/);
});

test('relay environment disables Agent View only in the spawned Claude child', () => {
  const { createChildEnvironment } = require('../claude-code-relay.cjs');
  const parent = { PATH: '/usr/bin', NO_PROXY: 'internal.example', ANTHROPIC_API_KEY: 'real-key',
    CLAUDE_CODE_DISABLE_AGENT_VIEW: '0' };
  const child = createChildEnvironment(parent, 'http://127.0.0.1:45678');
  assert.deepEqual(parent, { PATH: '/usr/bin', NO_PROXY: 'internal.example', ANTHROPIC_API_KEY: 'real-key',
    CLAUDE_CODE_DISABLE_AGENT_VIEW: '0' });
  assert.equal(child.ANTHROPIC_BASE_URL, 'http://127.0.0.1:45678');
  assert.equal(child.ANTHROPIC_API_KEY, 'sk-ant-api03-local-relay-placeholder-not-a-real-key');
  assert.equal(child.CLAUDE_CODE_DISABLE_AGENT_VIEW, '1');
  assert.equal(child.NO_PROXY, 'internal.example,127.0.0.1,localhost');
});
