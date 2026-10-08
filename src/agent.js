'use strict';

// PC-side fetch agent. Run this on the main PC while the proxy is published
// on Render:
//
//   set RENDER_URL=https://your-service.onrender.com
//   set AGENT_SECRET=the-same-secret-as-the-server
//   npm run agent
//
// The agent keeps outbound long-poll connections to the server, performs the
// upstream fetches from the PC's own network (usually faster), and streams
// the results back. When the agent stops, the server silently falls back to
// fetching directly - nothing else to maintain.

const http = require('node:http');
const https = require('node:https');
const { pipeline } = require('node:stream');

const RENDER_URL = (process.env.RENDER_URL || '').replace(/\/+$/, '');
const AGENT_SECRET = process.env.AGENT_SECRET || '';
const CONCURRENCY = Math.max(1, Number(process.env.AGENT_CONCURRENCY) || 12);
const UPSTREAM_TIMEOUT_MS = 60_000;
const SERVER_TIMEOUT_MS = 35_000;
// ボディ生成中（SSEの思考時間など）に許容する無通信時間。無通信即切断は
// ChatGPTのような長いストリーミングを壊す。
const STREAM_IDLE_TIMEOUT_MS = 300_000;

if (!RENDER_URL || !AGENT_SECRET) {
  console.error('RENDER_URL と AGENT_SECRET を環境変数で指定してください。例:');
  console.error('  set RENDER_URL=https://your-service.onrender.com');
  console.error('  set AGENT_SECRET=shared-secret');
  process.exit(1);
}

const serverBase = new URL(RENDER_URL);
if (!/^https?:$/.test(serverBase.protocol)) {
  console.error('RENDER_URL は http(s) で指定してください。');
  process.exit(1);
}

const transportFor = (url) => (url.protocol === 'https:' ? https : http);

function requestJson(path, { timeout = SERVER_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const req = transportFor(serverBase).request(serverBase.origin + path, {
      method: 'GET',
      headers: { 'x-yubikiri-agent-secret': AGENT_SECRET },
    });
    req.setTimeout(timeout, () => req.destroy(new Error('SERVER_TIMEOUT')));
    req.once('response', (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1_000_000) req.destroy(new Error('JOB_TOO_LARGE'));
        else chunks.push(chunk);
      });
      res.once('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { reject(error); }
      });
    });
    req.once('error', reject);
    req.end();
  });
}

function performUpstream(job) {
  return new Promise((resolve, reject) => {
    const target = new URL(job.url);
    if (!/^https?:$/.test(target.protocol) || target.username || target.password) {
      reject(new Error('UNSUPPORTED_TARGET'));
      return;
    }
    const transport = transportFor(target);
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: job.method || 'GET',
      path: `${target.pathname}${target.search}`,
      headers: { ...(job.headers || {}) },
    });
    req.setTimeout(UPSTREAM_TIMEOUT_MS, () => req.destroy(new Error('UPSTREAM_TIMEOUT')));
    req.once('error', reject);
    if (job.bodyBase64) req.write(Buffer.from(job.bodyBase64, 'base64'));
    req.end();
    req.once('response', (response) => {
      req.setTimeout(STREAM_IDLE_TIMEOUT_MS, () => req.destroy(new Error('UPSTREAM_TIMEOUT')));
      resolve(response);
    });
  });
}

function sendResult(jobId, outcome, bodyStream) {
  return new Promise((resolve) => {
    const headers = {
      'content-type': 'application/octet-stream',
      'x-yubikiri-agent-secret': AGENT_SECRET,
      'x-yubikiri-status': String(outcome.status),
      'x-yubikiri-headers': Buffer.from(JSON.stringify(outcome.headers || {})).toString('base64url'),
    };
    if (outcome.error) headers['x-yubikiri-error'] = String(outcome.error).slice(0, 200);
    const req = transportFor(serverBase).request(`${serverBase.origin}/internal/agent/result/${encodeURIComponent(jobId)}`, {
      method: 'POST',
      headers,
    });
    // ハブはボディを消費し終えるまで応答を返さない。転送中はストリーミングの
    // 停止（上流の思考時間など）が普通にあるため、無通信許容は長めに取る。
    req.setTimeout(STREAM_IDLE_TIMEOUT_MS, () => req.destroy());
    req.once('response', () => resolve());
    req.once('error', () => resolve());
    if (bodyStream) pipeline(bodyStream, req, () => {});
    else req.end();
  });
}

async function runWorker(index) {
  for (;;) {
    let payload;
    try {
      payload = await requestJson('/internal/agent/job');
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    const job = payload && payload.job;
    if (!job) continue;

    try {
      const upstream = await performUpstream(job);
      await sendResult(job.id, { status: upstream.statusCode, headers: upstream.headers }, upstream);
    } catch (error) {
      await sendResult(job.id, { status: 502, headers: {}, error: error.code || error.message || 'AGENT_FETCH_FAILED' }, null);
    }
  }
}

for (let index = 0; index < CONCURRENCY; index++) runWorker(index);

const poll = setInterval(() => {}, 1 << 30);
console.log(`Yubikiri agent: ${CONCURRENCY} workers -> ${RENDER_URL}`);
process.on('SIGINT', () => {
  clearInterval(poll);
  process.exit(0);
});
process.on('SIGTERM', () => {
  clearInterval(poll);
  process.exit(0);
});
