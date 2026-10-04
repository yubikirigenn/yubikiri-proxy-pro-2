'use strict';

const path = require('node:path');
const express = require('express');
const { createProxyRouter, encodeProxyUrl, handleWebSocketUpgrade, validateTarget, htmlEscape } = require('./src/proxy');
const { createAgentHub } = require('./src/agent-hub');

const app = express();
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';
const publicDir = path.join(__dirname, 'public');

app.disable('x-powered-by');
app.set('trust proxy', true);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (!req.path.startsWith('/proxy/') && req.query.__y === undefined) {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'");
  }
  next();
});

// Proxied documents rewrite their visible URL to app-path space
// (/<path>?__y=<token>) so SPA routers see their own routes. Accept that form
// here by rewriting it back to the canonical /proxy/<token><path> scheme; the
// bookkeeping parameter is stripped before the request reaches the upstream.
app.use((req, res, next) => {
  const token = req.query.__y;
  if (typeof token !== 'string' || !token || req.path.startsWith('/proxy/')) return next();
  const queryIndex = req.url.indexOf('?');
  const search = new URLSearchParams(queryIndex >= 0 ? req.url.slice(queryIndex + 1) : '');
  search.delete('__y');
  const query = search.toString();
  req.url = `/proxy/${token}${req.path}${query ? `?${query}` : ''}`;
  next();
});

app.use(express.static(publicDir, {
  index: false,
  fallthrough: true,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  etag: true,
  dotfiles: 'ignore',
}));

app.get('/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok' });
});

app.get('/api/navigate', async (req, res) => {
  try {
    const target = await validateTarget(req.query.url);
    // An immediate meta refresh replaces this navigation's history entry, so
    // Back returns to the previous page instead of replaying /api/navigate.
    const destination = htmlEscape(encodeProxyUrl(target));
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${destination}"><title>Yubikiri Proxy</title></head><body><p>切り替えています…</p><p><a href="${destination}">移動しない場合はこちら</a></p></body></html>`);
  } catch (error) {
    res.status(error.code === 'TARGET_BLOCKED' ? 403 : 400).type('html').send(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>Yubikiri Proxy</title><body><p>${String(error.publicMessage || 'URLを確認してください').replace(/[&<>"']/g, '')}</p><a href="/">戻る</a></body></html>`);
  }
});

app.post('/api/navigate', express.json({ limit: '8kb', strict: true }), async (req, res) => {
  try {
    const target = await validateTarget(req.body?.url);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ path: encodeProxyUrl(target) });
  } catch (error) {
    const status = error.code === 'TARGET_BLOCKED' ? 403 : 400;
    res.status(status).setHeader('Cache-Control', 'no-store');
    res.json({ error: error.publicMessage || 'URLを確認してください' });
  }
});

// PC-side fetch agent (src/agent.js) attaches here when AGENT_SECRET is set.
// Without the variable the endpoints stay disabled and the proxy fetches
// everything directly.
const agentHub = createAgentHub({ secret: process.env.AGENT_SECRET });
if (agentHub.enabled) app.use('/internal/agent', agentHub.router);

app.use('/proxy/:origin', createProxyRouter({ agentHub }));

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('*', (req, res) => {
  const host = req.get('host');
  const referrer = req.get('referer');
  if (host && referrer) {
    try {
      const previous = new URL(referrer);
      const match = previous.pathname.match(/^\/proxy\/([A-Za-z0-9_-]+)(?:\/.*)?$/);
      if (previous.host === host && match) {
        const token = match[1];
        const upstreamOrigin = Buffer.from(token, 'base64url').toString('utf8');
        const origin = new URL(upstreamOrigin);
        if (['http:', 'https:'].includes(origin.protocol) && origin.pathname === '/' && origin.origin && Buffer.from(origin.origin).toString('base64url') === token) {
          const target = new URL(req.originalUrl, origin);
          if (target.origin === origin.origin) {
            res.redirect(302, `/proxy/${token}${target.pathname}${target.search}${target.hash}`);
            return;
          }
        }
      }
    } catch {
      // Invalid referers fall through to the regular not-found response.
    }
  }
  res.status(404).sendFile(path.join(publicDir, 'index.html'));
});

app.use((error, _req, res, _next) => {
  if (res.headersSent) return res.end();
  const status = error.status === 413 ? 413 : 400;
  res.status(status).json({ error: status === 413 ? '送信データが大きすぎます' : 'リクエストを処理できませんでした' });
});

const server = app.listen(port, host, () => {
  console.log(`Yubikiri Proxy listening on ${host}:${port}`);
});

server.on('upgrade', (req, socket, head) => {
  void handleWebSocketUpgrade(req, socket, head);
});

server.requestTimeout = 45_000;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 5_000;

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
});
