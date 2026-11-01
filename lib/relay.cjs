const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const UPSTREAM_ORIGIN = 'https://api.anthropic.com';
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

function rewriteHeaders(originalHeaders) {
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
  return headers;
}

function rewriteRequest(originalHeaders, originalBody) {
  if (!originalBody || typeof originalBody !== 'object' || Array.isArray(originalBody)) {
    throw new Error('Messages request must be a JSON object.');
  }
  const body = structuredClone(originalBody);
  if (Array.isArray(body.system)) body.system = body.system.filter(block =>
    !(typeof block?.text === 'string' && block.text.startsWith('x-anthropic-billing-header:')));
  delete body.metadata;
  return { headers: rewriteHeaders(originalHeaders), body };
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

function createRelay({ apiKey, outputDir, fetchImpl = globalThis.fetch, requestTimeoutMs = 10 * 60 * 1000 } = {}) {
  if (typeof apiKey !== 'string' || !apiKey) throw new Error('An upstream API credential is required.');
  const state = { captures: [], upstreamCallCount: 0, upstreamStatus: null, responseText: '',
    upstreamResponseOk: false, upstreamError: null, successfulUpstreamCallCount: 0, upstreamResponses: [] };
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
  const enqueueWrite = operation => {
    const task = writing.then(operation);
    writing = task.catch(() => {});
    return task;
  };
  const persist = (filename, value) => {
    if (!outputDir) return Promise.resolve();
    const serialized = JSON.stringify(sanitize(value), null, 2);
    return enqueueWrite(async () => {
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(path.join(outputDir, filename), serialized);
    });
  };
  const appendLog = message => {
    if (!outputDir) return Promise.resolve();
    const line = `${new Date().toISOString()} ${sanitize(message)}\n`;
    return enqueueWrite(async () => {
      await fs.mkdir(outputDir, { recursive: true });
      await fs.appendFile(path.join(outputDir, 'relay.log'), line);
    });
  };

  async function forward(req, res, originalBody, rawBody, pathname) {
    if (closing) {
      replyJson(res, 503, { type: 'error', error: { type: 'api_error', message: 'Local relay is shutting down.' } });
      return;
    }
    const callNumber = ++state.upstreamCallCount;
    const fileSuffix = `-${String(callNumber).padStart(4, '0')}`;
    const started = Date.now();
    const responseChunks = [];
    let responseHeaders = {};
    let transportError = null;
    let upstreamStatus = null;
    let upstreamError = null;
    const isMessagesRequest = pathname.endsWith('/messages');
    const isMessagesPayload = isMessagesRequest || pathname.endsWith('/messages/count_tokens');
    const rewritten = isMessagesPayload
      ? rewriteRequest(req.headers, originalBody)
      : { headers: rewriteHeaders(req.headers), body: originalBody };
    const requestBody = ['GET', 'HEAD'].includes(req.method) ? undefined
      : isMessagesPayload ? JSON.stringify(rewritten.body) : rawBody;
    const upstreamUrl = new URL(req.url, UPSTREAM_ORIGIN).toString();

    try {
      await persist(`forwarded-request${fileSuffix}.json`, {
        method: req.method, url: upstreamUrl,
        headers: { ...rewritten.headers, 'x-api-key': '[REDACTED]' }, body: rewritten.body,
        changes: ['Local relay User-Agent', 'x-app and x-claude-code-* request headers omitted',
          'claude-code-* beta token omitted', 'System attribution block and identity metadata omitted',
          'Generation, thinking, context-management, prompt-cache, tools, and output settings preserved'],
        limitation: 'Successful forwarding does not prove a change in server-side billing classification.',
      });
      const upstream = await fetchImpl(upstreamUrl, { method: req.method,
        headers: { ...rewritten.headers, 'x-api-key': apiKey }, body: requestBody, redirect: 'error',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(requestTimeoutMs)]) });
      upstreamStatus = upstream.status;
      responseHeaders = Object.fromEntries(upstream.headers.entries());
      const downstreamHeaders = Object.fromEntries(Object.entries(responseHeaders)
        .filter(([key]) => !HOP_HEADERS.has(key) && key !== 'content-encoding'));
      if (!res.destroyed) res.writeHead(upstream.status, downstreamHeaders);
      if (upstream.body) for await (const chunk of upstream.body) {
        const buffer = Buffer.from(chunk);
        responseChunks.push(buffer);
        if (!res.destroyed) res.write(buffer);
      }
    } catch (error) {
      transportError = sanitize({ name: error.name, message: String(error.message) });
      upstreamError = transportError;
      if (!res.headersSent) replyJson(res, 502, { type: 'error', error: { type: 'api_error', message: 'Upstream relay connection failed.' } });
    } finally {
      if (!res.destroyed && !res.writableEnded) res.end();
      const rawResponse = Buffer.concat(responseChunks).toString('utf8');
      const parsed = parseResponse(rawResponse, responseHeaders['content-type'] || '');
      const responseText = sanitize(parsed.text);
      upstreamError ||= sanitize(parsed.error);
      const upstreamResponseOk = upstreamStatus >= 200 && upstreamStatus < 300 && !upstreamError &&
        (!isMessagesRequest || parsed.complete);
      state.upstreamStatus = upstreamStatus;
      state.responseText = responseText;
      state.upstreamError = upstreamError;
      state.upstreamResponseOk = upstreamResponseOk;
      if (upstreamResponseOk) state.successfulUpstreamCallCount += 1;
      state.upstreamResponses.push({ call_number: callNumber, method: req.method, path: pathname,
        status: upstreamStatus, ok: upstreamResponseOk, generated_text: responseText, error: upstreamError });
      await persist(`upstream-response${fileSuffix}.json`, { received_at_utc: new Date().toISOString(),
        elapsed_ms: Date.now() - started, status: upstreamStatus, headers: responseHeaders,
        body_raw: rawResponse, events: parsed.events, generated_text: parsed.text,
        response_complete: isMessagesRequest ? parsed.complete : upstreamResponseOk, transport_error: transportError });
      await appendLog(`UPSTREAM #${String(callNumber).padStart(4, '0')} ${req.method} ${pathname} HTTP ${upstreamStatus ?? 'ERROR'} elapsed_ms=${Date.now() - started} ok=${upstreamResponseOk}`);
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
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let body = rawBody;
        try { body = rawBody ? JSON.parse(rawBody) : null; } catch {}
        const captured = sanitize({ captured_at_utc: new Date().toISOString(), method: req.method,
          url: req.url, headers: req.headers, body });
        state.captures.push(captured);
        await persist('requests.json', state.captures);
        await appendLog(`CAPTURED ${req.method} ${req.url} bytes=${size}`);
        const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
        if (req.method === 'HEAD') { res.writeHead(200); res.end(); return; }
        if ((pathname.endsWith('/messages') || pathname.endsWith('/messages/count_tokens')) &&
          (!body || typeof body !== 'object' || Array.isArray(body))) {
          throw new Error('Messages request must be a JSON object.');
        }
        await forward(req, res, body, rawBody, pathname);
      } catch (error) {
        await appendLog(`LOCAL ERROR ${req.method} ${req.url} ${sanitize(error.message)}`);
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
      const endpoint = `http://127.0.0.1:${server.address().port}`;
      await appendLog(`LISTEN ${endpoint}`);
      return endpoint;
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      abort.abort();
      closePromise = (async () => {
        const stopped = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
        server.closeAllConnections();
        await Promise.allSettled([...active]);
        await appendLog('CLOSE');
        await writing;
        await stopped;
        apiKey = '';
      })();
      return closePromise;
    },
  };
}

module.exports = { rewriteRequest, createRelay, redact, parseResponse };
