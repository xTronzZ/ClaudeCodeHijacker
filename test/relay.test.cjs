const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRelay, rewriteRequest } = require('../lib/relay.cjs');

function clientRequest() {
  return {
    model: 'claude-haiku-4-5',
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=fixture; cc_entrypoint=cli;' },
      { type: 'text', text: 'You are a helpful coding assistant.', cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: 'Hi' }],
    metadata: { user_id: 'fixture-device-and-session' },
    thinking: { type: 'enabled', budget_tokens: 1024 },
    context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] },
    max_tokens: 2048,
    stream: true,
  };
}

function sseResponse(text) {
  const events = [
    { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant',
      model: 'claude-haiku-4-5', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fixture' },
  });
}

test('rewriting removes attribution while preserving normal Claude generation behavior', () => {
  const original = clientRequest();
  const snapshot = structuredClone(original);
  const rewritten = rewriteRequest({ 'user-agent': 'claude-cli/fixture', 'x-app': 'cli',
    'x-api-key': 'dummy-local-credential', 'anthropic-beta': 'claude-code-fixture,context-management-fixture' }, original);
  assert.deepEqual(original, snapshot);
  assert.deepEqual(rewritten.body.messages, original.messages);
  assert.deepEqual(rewritten.body.thinking, original.thinking);
  assert.deepEqual(rewritten.body.context_management, original.context_management);
  assert.equal(rewritten.body.max_tokens, original.max_tokens);
  assert.deepEqual(rewritten.body.system[0].cache_control, original.system[1].cache_control);
  assert.equal(rewritten.body.metadata, undefined);
  assert.equal(rewritten.headers['x-api-key'], undefined);
  assert.equal(rewritten.headers['x-app'], undefined);
  assert.equal(rewritten.headers['anthropic-beta'], 'context-management-fixture');
});

test('relay forwards multiple requests and writes CAPTURED and UPSTREAM activity only to files',
  { timeout: 10000 }, async t => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-relay-output-'));
    const realKey = 'sk-ant-api03-fixture-persistent-credential';
    let calls = 0;
    const relay = createRelay({ apiKey: realKey, outputDir, fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(new URL(url).origin, 'https://api.anthropic.com');
      assert.equal(new Headers(options.headers).get('x-api-key'), realKey);
      assert.equal(new Headers(options.headers).get('x-app'), null);
      const body = JSON.parse(options.body);
      assert.equal(body.max_tokens, 2048);
      assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 1024 });
      return sseResponse(`Reply ${calls}`);
    } });
    t.after(async () => { await relay.close(); await fs.rm(outputDir, { recursive: true, force: true }); });
    const baseUrl = await relay.listen();
    const requestOptions = { method: 'POST', headers: { 'content-type': 'application/json', 'x-app': 'cli' },
      body: JSON.stringify(clientRequest()) };
    for (const expected of ['Reply 1', 'Reply 2']) {
      const response = await fetch(baseUrl + '/v1/messages?beta=true', requestOptions);
      assert.equal(response.status, 200);
      assert.match(await response.text(), new RegExp(expected));
    }
    assert.equal(calls, 2);
    assert.equal(relay.state.upstreamCallCount, 2);
    assert.equal(relay.state.successfulUpstreamCallCount, 2);
    await relay.close();
    const log = await fs.readFile(path.join(outputDir, 'relay.log'), 'utf8');
    assert.match(log, /CAPTURED POST \/v1\/messages/);
    assert.match(log, /UPSTREAM #0001 POST \/v1\/messages HTTP 200/);
    assert.match(log, /UPSTREAM #0002 POST \/v1\/messages HTTP 200/);
    assert.doesNotMatch(log, /fixture-persistent-credential/);
    assert.ok((await fs.stat(path.join(outputDir, 'requests.json'))).isFile());
    assert.ok((await fs.stat(path.join(outputDir, 'upstream-response-0002.json'))).isFile());
  });

test('token counting and model discovery are proxied instead of returning demonstration mocks',
  { timeout: 10000 }, async t => {
    const seen = [];
    const relay = createRelay({ apiKey: 'fixture-key', fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      seen.push({ path: parsed.pathname, method: options.method, body: options.body });
      if (parsed.pathname.endsWith('/count_tokens')) {
        return new Response(JSON.stringify({ input_tokens: 42 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ data: [{ id: 'claude-fixture' }], has_more: false }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    } });
    t.after(() => relay.close());
    const baseUrl = await relay.listen();
    const countResponse = await fetch(baseUrl + '/v1/messages/count_tokens', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(clientRequest()) });
    assert.deepEqual(await countResponse.json(), { input_tokens: 42 });
    const modelsResponse = await fetch(baseUrl + '/v1/models');
    assert.equal((await modelsResponse.json()).data[0].id, 'claude-fixture');
    assert.deepEqual(seen.map(item => item.path), ['/v1/messages/count_tokens', '/v1/models']);
    assert.equal(JSON.parse(seen[0].body).metadata, undefined);
    assert.equal(seen[1].body, undefined);
  });

test('an upstream authentication failure is relayed and not reported as successful',
  { timeout: 10000 }, async t => {
    const relay = createRelay({ apiKey: 'fixture-key', fetchImpl: async () => new Response(JSON.stringify({
      type: 'error', error: { type: 'authentication_error', message: 'Fixture credential rejected' },
    }), { status: 401, headers: { 'content-type': 'application/json' } }) });
    t.after(() => relay.close());
    const baseUrl = await relay.listen();
    const response = await fetch(baseUrl + '/v1/messages', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(clientRequest()) });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.type, 'authentication_error');
    assert.equal(relay.state.upstreamResponseOk, false);
    assert.equal(relay.state.upstreamCallCount, 1);
  });

test('an HTTP 200 stream missing message_stop is not reported as complete',
  { timeout: 10000 }, async t => {
    const partial = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Partial"}}\n\n';
    const relay = createRelay({ apiKey: 'fixture-key', fetchImpl: async () => new Response(partial,
      { status: 200, headers: { 'content-type': 'text/event-stream' } }) });
    t.after(() => relay.close());
    const baseUrl = await relay.listen();
    const response = await fetch(baseUrl + '/v1/messages', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(clientRequest()) });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(relay.state.responseText, 'Partial');
    assert.equal(relay.state.upstreamResponseOk, false);
  });

test('malformed Messages JSON is rejected locally without an upstream request',
  { timeout: 10000 }, async t => {
    let calls = 0;
    const relay = createRelay({ apiKey: 'fixture-key', fetchImpl: async () => { calls += 1; return sseResponse('Hello'); } });
    t.after(() => relay.close());
    const baseUrl = await relay.listen();
    const response = await fetch(baseUrl + '/v1/messages', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{broken' });
    assert.equal(response.status, 400);
    await response.text();
    assert.equal(calls, 0);
    assert.equal(relay.state.upstreamCallCount, 0);
  });
