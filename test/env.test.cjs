const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEnv, loadApiKey } = require('../lib/env.cjs');

test('parseEnv supports comments, export syntax, quotes, and inline comments', () => {
  assert.deepEqual(parseEnv(`
# comment
export CLAUDE_RELAY_API_KEY="sk-ant-api03-fixture\\nvalue"
UNRELATED=value # trailing comment
SINGLE='literal value'
`), {
    CLAUDE_RELAY_API_KEY: 'sk-ant-api03-fixture\nvalue',
    UNRELATED: 'value',
    SINGLE: 'literal value',
  });
});

test('loadApiKey prefers process variables and does not read the file', async () => {
  let fileRead = false;
  const result = await loadApiKey({
    env: { CLAUDE_RELAY_API_KEY: ' preferred-key ', ANTHROPIC_API_KEY: 'fallback-key' },
    readFile: async () => { fileRead = true; throw new Error('should not read'); },
  });
  assert.deepEqual(result, { apiKey: 'preferred-key', source: 'environment' });
  assert.equal(fileRead, false);
});

test('loadApiKey reads the repository .env variables and handles a missing file', async () => {
  const loaded = await loadApiKey({ env: {}, envPath: '/fixture/.env',
    readFile: async () => 'ANTHROPIC_API_KEY=sk-ant-api03-from-file\n' });
  assert.deepEqual(loaded, { apiKey: 'sk-ant-api03-from-file', source: '/fixture/.env' });
  const missing = await loadApiKey({ env: {}, readFile: async () => {
    const error = new Error('missing'); error.code = 'ENOENT'; throw error;
  } });
  assert.equal(missing, null);
});

test('parseEnv rejects malformed entries instead of executing or guessing them', () => {
  assert.throws(() => parseEnv('not-an-assignment'), /Invalid .env entry/);
  assert.throws(() => parseEnv('BAD-NAME=value'), /Invalid .env variable name/);
  assert.throws(() => parseEnv('KEY="unterminated'), /Unterminated .env value/);
});
