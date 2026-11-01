const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function envValue(env, name, platform) {
  const key = platform === 'win32'
    ? Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase())
    : name;
  return key === undefined ? undefined : env[key];
}

function isAbsoluteLocation(value, platform, paths) {
  return paths.isAbsolute(value) && (platform !== 'win32' || /^[A-Za-z]:[\\/]|^\\\\[^\\]+\\[^\\]+/.test(value));
}

function getClaudeCandidates({ platform = process.platform, arch = process.arch,
  env = process.env, homedir = os.homedir() } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const executable = platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = [paths.join(homedir, '.local', 'bin', executable)];
  if (platform === 'darwin') {
    const homebrew = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
    candidates.push(...(arch === 'arm64' ? homebrew : homebrew.reverse()));
  }
  const searchPath = envValue(env, 'PATH', platform) || '';
  for (const item of searchPath.split(platform === 'win32' ? ';' : ':')) {
    const directory = item.trim().replace(/^"(.*)"$/, '$1');
    if (directory && isAbsoluteLocation(directory, platform, paths)) candidates.push(paths.join(directory, executable));
  }
  const seen = new Set();
  return candidates.filter(candidate => {
    const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function isNativeExecutable(candidate, { platform }) {
  try {
    if (!(await fs.stat(candidate)).isFile()) return false;
    await fs.access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveClaudeBinary(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const isExecutable = options.isExecutable || isNativeExecutable;
  const override = envValue(env, 'CLAUDE_BINARY', platform);
  if (override !== undefined && override !== '') {
    if (!isAbsoluteLocation(override, platform, paths)) throw new Error('CLAUDE_BINARY must be an absolute path, without surrounding quotes.');
    if (platform === 'win32' && paths.extname(override).toLowerCase() !== '.exe') {
      throw new Error('CLAUDE_BINARY must point to the native claude.exe, not a .cmd or script launcher.');
    }
    if (!await isExecutable(override, { platform })) {
      throw new Error(`CLAUDE_BINARY is not an executable file: ${override}`);
    }
    return override;
  }
  for (const candidate of getClaudeCandidates({ ...options, platform, env })) {
    if (await isExecutable(candidate, { platform })) return candidate;
  }
  const name = platform === 'win32' ? 'claude.exe' : 'claude';
  throw new Error(`Claude Code executable not found. Install the native CLI or set CLAUDE_BINARY to the absolute path of ${name}.`);
}

module.exports = { getClaudeCandidates, isNativeExecutable, resolveClaudeBinary };
