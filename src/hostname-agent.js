'use strict';

// ホスト名モードのPC側ローカル中継(MITMプロキシ)。
//
//   set RENDER_URL=https://your-service.onrender.com
//   set AGENT_SECRET=サーバーと同じシークレット
//   npm run hostname-agent
//
// ブラウザは PAC / システムプロキシでこの中継(既定 127.0.0.1:8899)へ向く。
// 平文HTTPは絶対URLを、HTTPSは CONNECT 後にローカルCAで発行した葉証明書で
// TLS終端し、実ホスト・実パスのままの要求を Render の /hostname へ
// `x-yubikiri-target` に実URLを詰めて転送、応答をそのままブラウザへ返す。
// ページの取得・書き換えはサーバー側で行い、ここでは中継だけをする。
//
// 既存の src/agent.js(パスモードのエージェント)とは完全に独立。止めれば
// 何もしない。証明書は scripts/hostname-teardown.ps1 で削除できる。

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { URL } = require('node:url');
require('./env').loadEnv(); // リポジトリ直下の .env(start-agent.cmd の初回セットアップで生成)
const { loadOrCreateCa, issueLeaf, defaultCaDir } = require('./hostname-ca');

const RENDER_URL = (process.env.RENDER_URL || '').replace(/\/+$/, '');
const AGENT_SECRET = process.env.AGENT_SECRET || '';
const PORT = Number(process.env.LOCAL_PROXY_PORT) || 8899;
const HOST = process.env.LOCAL_PROXY_HOST || '127.0.0.1';

if (!RENDER_URL || !AGENT_SECRET) {
  console.error('RENDER_URL と AGENT_SECRET が未設定です。start-hostname.cmd をダブルクリックすると');
  console.error('初回だけ対話的に聞いて .env へ保存します(コマンド: npm run setup-agent)。');
  process.exit(1);
}

const renderBase = new URL(RENDER_URL);
if (!/^https?:$/.test(renderBase.protocol)) {
  console.error('RENDER_URL は http(s) で指定してください。');
  process.exit(1);
}
const renderTransport = renderBase.protocol === 'https:' ? https : http;
const CA_DIR = defaultCaDir();
const ca = loadOrCreateCa(CA_DIR);

// 第1段階の対象ホスト(問題サイト中心)。ここ以外へは PAC が DIRECT を返す。
// 必要なら HOSTNAME_PROXY_HOSTS(カンマ区切り)で上書きできる。
const PROXIED_HOSTS = (process.env.HOSTNAME_PROXY_HOSTS || [
  'auctions.yahoo.co.jp', 'www.yahoo.co.jp', 'search.yahoo.co.jp', 'yahoo.co.jp',
  'yimg.jp', 's.yimg.jp', 'auction-assets.c.yimg.jp',
  'note.com', 'assets.st-note.com', 'poe.com',
  'www.google.com', 'google.com', 'www.google.co.jp',
].join(',')).split(',').map((h) => h.trim()).filter(Boolean);

function buildPac() {
  const list = JSON.stringify(PROXIED_HOSTS);
  return `// Yubikiri hostname-mode PAC. Only the listed hosts (and their subdomains)\n` +
    `// are routed to the local relay; everything else stays DIRECT.\n` +
    `var YUBIKIRI_HOSTS = ${list};\n` +
    `var YUBIKIRI_PROXY = "PROXY 127.0.0.1:${PORT}; SECURE 127.0.0.1:${PORT}";\n` +
    `function FindProxyForURL(url, host) {\n` +
    `  host = host.toLowerCase();\n` +
    `  for (var i = 0; i < YUBIKIRI_HOSTS.length; i++) {\n` +
    `    var d = YUBIKIRI_HOSTS[i].toLowerCase();\n` +
    `    if (host === d || dnsDomainIs(host, "." + d)) return YUBIKIRI_PROXY;\n` +
    `  }\n` +
    `  return "DIRECT";\n` +
    `}\n`;
}

const HOP_BY_HOP = new Set(['connection', 'proxy-connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

// 実ホストのまま Render の /hostname へ透過転送し、応答を res へ流す。
function relayToRender(req, res, targetHref) {
  const forwardHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    forwardHeaders[name] = value;
  }
  forwardHeaders['x-yubikiri-target'] = targetHref;
  forwardHeaders['x-yubikiri-agent-secret'] = AGENT_SECRET;

  const upstream = renderTransport.request({
    protocol: renderBase.protocol,
    hostname: renderBase.hostname,
    port: renderBase.port || (renderBase.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: '/hostname',
    headers: forwardHeaders,
    servername: renderBase.protocol === 'https:' ? renderBase.hostname : undefined,
  }, (upRes) => {
    const outHeaders = {};
    for (const [name, value] of Object.entries(upRes.headers)) {
      if (HOP_BY_HOP.has(name.toLowerCase())) continue;
      outHeaders[name] = value;
    }
    res.writeHead(upRes.statusCode || 502, outHeaders);
    upRes.pipe(res);
  });
  upstream.on('error', (error) => {
    console.error(`[hostname-agent] relay error ${targetHref}: ${error.message}`);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
}

// TLS終端済みのソケット上で完結形式(/path)で届く要求のハンドラ。
function innerRequestHandler(req, res) {
  const host = req.socket.__host;
  if (!host) { res.writeHead(400); res.end(); return; }
  const targetHref = `https://${host}${req.url}`;
  relayToRender(req, res, targetHref);
}

const innerServer = http.createServer(innerRequestHandler);

// 平文HTTPのプロキシ要求(絶対URL形式)と CONNECT を扱う外向きサーバ。
const proxyServer = http.createServer((req, res) => {
  const servePac = () => {
    res.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig', 'cache-control': 'no-store' });
    res.end(buildPac());
  };
  // PACは origin-form(/proxy.pac)で直接取得されることが多い。
  if (req.url === '/proxy.pac') { servePac(); return; }
  let target;
  try { target = new URL(req.url); } catch { res.writeHead(400); res.end(); return; }
  // 自分自身(127.0.0.1:PORT)への /proxy.pac は中継せずPACを返す。
  if ((target.hostname === '127.0.0.1' || target.hostname === 'localhost')
      && target.pathname === '/proxy.pac') {
    servePac();
    return;
  }
  const targetHref = `${target.protocol}//${target.host}${target.pathname}${target.search}`;
  relayToRender(req, res, targetHref);
});

proxyServer.on('connect', (req, clientSocket, head) => {
  const host = String(req.url || '').split(':')[0];
  if (!host) { clientSocket.destroy(); return; }
  let leaf;
  try {
    leaf = issueLeaf(ca, host);
  } catch (error) {
    console.error(`[hostname-agent] leaf cert failed for ${host}: ${error.message}`);
    clientSocket.destroy();
    return;
  }
  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  if (head && head.length) clientSocket.unshift(head);

  const secure = new tls.TLSSocket(clientSocket, {
    isServer: true,
    key: leaf.key,
    cert: leaf.cert,
    requestCert: false,
  });
  secure.__host = host;
  secure.on('error', () => { secure.destroy(); });
  // 終端したTLSソケットを内部のHTTPサーバに読ませる。
  secure.on('secure', () => innerServer.emit('connection', secure));
  if (secure.isSecure) innerServer.emit('connection', secure);
});

proxyServer.listen(PORT, HOST, () => {
  console.log(`Yubikiri hostname-agent: http://127.0.0.1:${PORT} -> ${renderBase.origin}/hostname`);
  console.log(`ルートCA: ${ca.certPath}`);
  console.log('このCAをWindowsの信頼ストアに導入し、PAC/システムプロキシで本ポートへ向けてください。');
});
