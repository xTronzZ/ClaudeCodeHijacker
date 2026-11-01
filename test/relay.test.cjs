const test = require('node:test');
const assert = require('node:assert/strict');
const { createRelay, rewriteRequest } = require('../claude-code-relay.cjs');

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

test('rewriting preserves the prompt and its original capture without retaining client identity', () => {
  const original = clientRequest();
  const snapshot = structuredClone(original);
  const rewritten = rewriteRequest({ 'user-agent': 'claude-cli/fixture', 'x-app': 'cli',
    'x-api-key': 'dummy-local-credential', 'anthropic-beta': 'claude-code-fixture,other-capability' }, original,
  { maxOutputTokens: 128 });
  assert.deepEqual(original, snapshot);
  assert.deepEqual(rewritten.body.messages, original.messages);
  assert.equal(rewritten.body.system[0].text, original.system[1].text);
  assert.equal(rewritten.body.metadata, undefined);
  assert.equal(rewritten.body.system[0].cache_control, undefined);
  assert.equal(rewritten.headers['x-api-key'], undefined);
  assert.equal(rewritten.headers['anthropic-beta'], 'other-capability');
});

test('a rewritten request returns the upstream SSE stream, redacts credentials, and cannot make a second upstream call',
  { timeout: 10000 }, async t => {
    const realKey = 'sk-ant-api03-fixture-not-a-real-credential';
    let calls = 0;
    const relay = createRelay({ apiKey: realKey, maxOutputTokens: 128,
      fetchImpl: async (url, options) => {
        calls += 1;
        assert.equal(new URL(url).origin, 'https://api.anthropic.com');
        assert.equal(new Headers(options.headers).get('x-api-key'), realKey);
        assert.equal(new Headers(options.headers).get('x-app'), null);
        assert.equal(options.redirect, 'error');
        assert.equal(JSON.parse(options.body).messages[0].content, 'Hi');
        return sseResponse('Hello from a fake upstream');
      } });
    t.after(() => relay.close());
    const baseUrl = await relay.listen();
    const requestOptions = { method: 'POST', headers: { 'content-type': 'application/json',
      'x-api-key': 'sk-ant-api03-fixture-local-dummy', 'x-app': 'cli' }, body: JSON.stringify(clientRequest()) };
    const response = await fetch(baseUrl + '/v1/messages?beta=true', requestOptions);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const stream = await response.text();
    assert.match(stream, /Hello from a fake upstream/);
    assert.match(stream, /event: message_stop/);
    const denied = await fetch(baseUrl + '/v1/messages?beta=true', requestOptions);
    assert.equal(denied.status, 400);
    await denied.text();
    assert.equal(calls, 1);
    assert.equal(relay.state.upstreamCallCount, 1);
    assert.equal(relay.state.upstreamResponseOk, true);
    assert.equal(relay.state.responseText, 'Hello from a fake upstream');
    assert.doesNotMatch(JSON.stringify(relay.state.captures), /sk-ant-api03-fixture/);
  });

test('an upstream authentication failure is relayed and is not reported as a successful reply',
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

test('an HTTP 200 stream missing message_stop is not reported as a complete reply',
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

test('malformed Messages JSON is rejected locally without consuming the upstream request',
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
