const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveClaudeBinary } = require('../lib/platform.cjs');

test('macOS-style launcher symlinks resolve only when the target has execute permission',
  { skip: process.platform === 'win32' }, async t => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-relay-path-'));
    t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
    const target = path.join(temporaryRoot, 'native executable');
    const launcher = path.join(temporaryRoot, 'claude');
    await fs.writeFile(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await fs.symlink(target, launcher);
    const options = { platform: 'darwin', env: { CLAUDE_BINARY: launcher } };
    assert.equal(await resolveClaudeBinary(options), launcher);
    await fs.chmod(target, 0o644);
    await assert.rejects(resolveClaudeBinary(options), /not an executable file/);
  });
