const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const UPSTREAM_URL = 'https://api.anthropic.com/v1/messages?beta=true';
const HOP_HEADERS = new Set(['host', 'content-length', 'connection', 'accept-encoding',
  'transfer-encoding', 'keep-alive', 'proxy-connection', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'upgrade']);

function redact(value, key = '') {
  if (/authorization|api[-_]?key|cookie|secret|password|access[-_]?token|refresh[-_]?token/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return value.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]');
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  return value;
}

function withoutCache(value) {
  if (Array.isArray(value)) return value.map(withoutCache);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'cache_control').map(([key, val]) => [key, withoutCache(val)]));
  return value;
}

function rewriteRequest(originalHeaders, originalBody, { maxOutputTokens = 16 } = {}) {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error('maxOutputTokens must be a positive integer.');
  if (!originalBody || typeof originalBody !== 'object' || Array.isArray(originalBody)) throw new Error('Messages request must be a JSON object.');
  const normalized = Object.fromEntries(Object.entries(originalHeaders).map(([key, value]) =>
    [key.toLowerCase(), Array.isArray(value) ? value.join(',') : value]));
  const connectionHeaders = new Set(String(normalized.connection || '').toLowerCase().split(',').map(value => value.trim()));
  const headers = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (value === undefined || HOP_HEADERS.has(key) || connectionHeaders.has(key) ||
      ['x-api-key', 'authorization', 'x-app'].includes(key) || key.startsWith('x-claude-code-')) continue;
    headers[key] = value;
  }
  headers['user-agent'] = 'claude-code-local-relay/1.0';
  if (headers['anthropic-beta']) {
    const betas = String(headers['anthropic-beta']).split(',').map(value => value.trim())
      .filter(value => value && !value.startsWith('claude-code-'));
    if (betas.length) headers['anthropic-beta'] = betas.join(',');
    else delete headers['anthropic-beta'];
  }
  const body = structuredClone(originalBody);
  if (Array.isArray(body.system)) body.system = body.system.filter(block =>
    !(typeof block?.text === 'string' && block.text.startsWith('x-anthropic-billing-header:')));
  delete body.metadata;
  body.max_tokens = maxOutputTokens;
  body.thinking = { type: 'disabled' };
  delete body.context_management;
  return { headers, body: withoutCache(body) };
}

function parseResponse(raw, contentType) {
  if (contentType.includes('text/event-stream')) {
    const events = raw.split(/\r?\n\r?\n/).flatMap(block => {
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data || data === '[DONE]') return [];
      try { return [JSON.parse(data)]; } catch { return []; }
    });
    return {
      events,
      text: events.filter(event => event.type === 'content_block_delta' && event.delta?.type === 'text_delta')
        .map(event => event.delta.text || '').join(''),
      complete: events.some(event => event.type === 'message_stop'),
      error: events.find(event => event.type === 'error')?.error || null,
    };
  }
  try {
    const message = JSON.parse(raw);
    return { events: [], text: (message.content || []).filter(block => block.type === 'text').map(block => block.text).join(''),
      complete: message.type === 'message' && Boolean(message.stop_reason), error: message.error || null };
  } catch {
    return { events: [], text: '', complete: false, error: null };
  }
}

function replyJson(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_local_relay' });
  res.end(JSON.stringify(data));
}

function createRelay({ apiKey, outputDir, mode = 'print', maxOutputTokens = 16,
  fetchImpl = globalThis.fetch, requestTimeoutMs = 30000, log = () => {},
  onUpstreamComplete = () => {} } = {}) {
  if (typeof apiKey !== 'string' || !apiKey) throw new Error('An upstream API credential is required.');
  if (!['print', 'interactive'].includes(mode)) throw new Error('Invalid capture mode.');
  const state = { captures: [], upstreamCallCount: 0, upstreamStatus: null, responseText: '',
    upstreamResponseOk: false, upstreamError: null };
  const active = new Set();
  const abort = new AbortController();
  let writing = Promise.resolve();
  let closing = false;
  let closePromise;
  const sanitize = value => {
    const replaceKey = item => typeof item === 'string' ? (apiKey ? item.replaceAll(apiKey, '[REDACTED]') : item)
      : Array.isArray(item) ? item.map(replaceKey)
      : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, val]) => [key, replaceKey(val)])) : item;
    return replaceKey(redact(value));
  };
  const persist = (filename, value) => {
    if (!outputDir) return Promise.resolve();
    const serialized = JSON.stringify(sanitize(value), null, 2);
    const task = writing.then(async () => {
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(path.join(outputDir, filename), serialized);
    });
    writing = task.catch(() => {});
    return task;
  };

  async function forward(req, res, originalBody) {
    if (closing || state.upstreamCallCount >= 1) {
      replyJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'This relay allows only one upstream request per run.' } });
      return;
    }
    state.upstreamCallCount += 1;
    const started = Date.now();
    const chunks = [];
    let responseHeaders = {};
    let transportError = null;
    try {
      const request = rewriteRequest(req.headers, originalBody, { maxOutputTokens });
      await persist('forwarded-request.json', {
        method: 'POST', url: UPSTREAM_URL, headers: { ...request.headers, 'x-api-key': '[REDACTED]' }, body: request.body,
        changes: ['Local relay User-Agent', 'x-app and x-claude-code-* request headers omitted',
          'claude-code-* beta token omitted', 'System attribution block and identity metadata omitted',
          `Output capped at ${maxOutputTokens} tokens; thinking and prompt-cache writes disabled for this run`],
        limitation: 'Other Claude Code instructions remain in the system prompt. Successful forwarding does not prove indistinguishability or a change in billing classification.',
      });
      const upstream = await fetchImpl(UPSTREAM_URL, { method: 'POST',
        headers: { ...request.headers, 'x-api-key': apiKey }, body: JSON.stringify(request.body), redirect: 'error',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(requestTimeoutMs)]) });
      state.upstreamStatus = upstream.status;
      responseHeaders = Object.fromEntries(upstream.headers.entries());
      const downstreamHeaders = Object.fromEntries(Object.entries(responseHeaders)
        .filter(([key]) => !HOP_HEADERS.has(key) && key !== 'content-encoding'));
      if (!res.destroyed) res.writeHead(upstream.status, downstreamHeaders);
      if (upstream.body) for await (const chunk of upstream.body) {
        const buffer = Buffer.from(chunk);
        chunks.push(buffer);
        if (!res.destroyed) res.write(buffer);
      }
    } catch (error) {
      transportError = sanitize({ name: error.name, message: String(error.message) });
      state.upstreamError = transportError;
      if (!res.headersSent) replyJson(res, 502, { type: 'error', error: { type: 'api_error', message: 'Upstream relay connection failed.' } });
    } finally {
      if (!res.destroyed && !res.writableEnded) res.end();
      const raw = Buffer.concat(chunks).toString('utf8');
      const parsed = parseResponse(raw, responseHeaders['content-type'] || '');
      state.responseText = sanitize(parsed.text);
      state.upstreamError ||= sanitize(parsed.error);
      state.upstreamResponseOk = state.upstreamStatus === 200 && parsed.complete && !state.upstreamError && parsed.text.length > 0;
      try {
        await persist('upstream-response.json', { received_at_utc: new Date().toISOString(), elapsed_ms: Date.now() - started,
          status: state.upstreamStatus, headers: responseHeaders, body_raw: raw, events: parsed.events,
          generated_text: parsed.text, response_complete: parsed.complete, transport_error: transportError });
        log(sanitize(`\nUPSTREAM HTTP ${state.upstreamStatus}; text=${JSON.stringify(parsed.text)}\n`));
      } finally {
        apiKey = '';
        onUpstreamComplete(state);
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    const task = (async () => {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) throw new Error('Request exceeds local capture size limit');
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = raw;
        try { body = raw ? JSON.parse(raw) : null; } catch {}
        state.captures.push(sanitize({ captured_at_utc: new Date().toISOString(), method: req.method, url: req.url, headers: req.headers, body }));
        await persist(`${mode}-requests.json`, state.captures);
        log(`\nCAPTURED ${req.method} ${req.url} (${size} bytes)\n`);
        const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
        if (req.method === 'HEAD') { res.writeHead(200); res.end(); }
        else if (pathname.endsWith('/messages/count_tokens')) replyJson(res, 200, { input_tokens: 1 });
        else if (pathname.endsWith('/messages') && req.method === 'POST') {
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Messages request must be a JSON object.');
          await forward(req, res, body);
        }
        else if (pathname.endsWith('/models')) replyJson(res, 200, { data: [{ id: 'claude-haiku-4-5', type: 'model',
          display_name: 'Local capture mock', created_at: '2026-11-01T00:00:00Z' }], has_more: false });
        else replyJson(res, 200, {});
      } catch (error) {
        if (!res.headersSent) replyJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: sanitize(error.message) } });
        else if (!res.destroyed) res.end();
      }
    })();
    active.add(task);
    task.finally(() => active.delete(task)).catch(() => {});
  });

  return {
    server, state,
    async listen() {
      if (closing) throw new Error('Relay is closed.');
      await new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError); server.once('listening', onListening);
        server.listen(0, '127.0.0.1');
      });
      return `http://127.0.0.1:${server.address().port}`;
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      abort.abort();
      closePromise = (async () => {
        const stopped = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
        server.closeAllConnections();
        await Promise.allSettled([...active]);
        await writing;
        await stopped;
        apiKey = '';
      })();
      return closePromise;
    },
  };
}

module.exports = { rewriteRequest, createRelay, redact, parseResponse };
