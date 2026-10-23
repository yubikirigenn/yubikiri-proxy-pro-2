'use strict';

// ホスト名モードのサーバー側リレー。
// PC側のローカル中継(src/hostname-agent.js)が、ブラウザから実ホスト名の
// まま受け取った要求を `x-yubikiri-target` に実URLとして詰めてここへ送る。
// ここでは既存の取得経路(PCエージェント / impit / 直結)で上流から本文を
// 取り、HTML/CSSの書き換え・ツールバー注入・ランタイム注入・クッキーの
// Pathスコープは一切行わず、ステータス/ヘッダー/ボディをそのまま返す。
// ブラウザは実ホスト・実クッキーのままなので、サイトJSが組み立てる絶対URL
// 遷移(ヤフオクの条件変更など)がプロキシから抜けなくなる。
//
// 既存のパスモード(src/proxy.js)とは完全に分離し、server.js側で
// HOSTNAME_MODE 環境変数が立つときだけこのハンドラが有効になる。

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream');
const {
  validateTarget, resolvePublicAddresses, impersonatedRequest, dispatchToAgent,
  createPinnedLookup, isHopByHop, readLimited,
  IMPERSONATED_HOSTS, upstreamHttpsAgent, upstreamHttpAgent, MAX_UPLOAD_BYTES,
} = require('./proxy');

const UPSTREAM_HEADER_TIMEOUT_MS = 60_000;
const UPSTREAM_IDLE_TIMEOUT_MS = 300_000;

function safeEqual(provided, secret) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(secret || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function connectionTokensOf(connectionHeader) {
  return String(connectionHeader || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

// 上流へ送るヘッダーを再構成する。制御ヘッダー(x-yubikiri-*)と
// ホップバイホップ、host(実ホストへ付け替え)を除く。accept-encoding は
// ブラウザが送ったものをそのまま通し、本文はデコードせず素通しする。
function buildUpstreamHeaders(req, target) {
  const tokens = connectionTokensOf(req.headers.connection);
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (name === 'host' || name === 'proxy-connection' || name === 'x-yubikiri-target' || name === 'x-yubikiri-agent-secret' || isHopByHop(name, tokens)) continue;
    headers[name] = value;
  }
  headers.host = target.host;
  return headers;
}

function createHostnameRouter({ agentHub, secret }) {
  return async function hostnameHandler(req, res) {
    if (!secret || !safeEqual(req.get('x-yubikiri-agent-secret'), secret)) {
      res.status(401).end();
      return;
    }
    const targetHref = req.get('x-yubikiri-target');
    let target;
    try {
      target = await validateTarget(targetHref);
    } catch {
      res.status(400).end();
      return;
    }

    const requestHeaders = buildUpstreamHeaders(req, target);
    const hasBody = !['GET', 'HEAD'].includes(req.method)
      && (Number(req.headers['content-length']) > 0 || Boolean(req.headers['transfer-encoding']));
    if (Number(req.headers['content-length']) > MAX_UPLOAD_BYTES) {
      res.status(413).end();
      return;
    }

    let remoteResponse;
    let remoteRequest;
    try {
      // 1) PCエージェント経由(impitが要らない通常サイト)。
      if (agentHub && agentHub.isActive() && !IMPERSONATED_HOSTS.has(target.hostname)) {
        const viaAgent = await dispatchToAgent(agentHub, req, target, requestHeaders, hasBody);
        if (viaAgent) remoteResponse = viaAgent;
      }
      // 2) Cloudflare等の検証を通す対象はimpit(本文はデコード済みで返る)。
      if (!remoteResponse && IMPERSONATED_HOSTS.has(target.hostname)) {
        const body = hasBody ? await readLimited(req, MAX_UPLOAD_BYTES) : undefined;
        remoteResponse = await impersonatedRequest(target, req.method, requestHeaders, body);
      }
      // 3) 直結。accept-encodingを素通しし本文はデコードせず転送する。
      if (!remoteResponse) {
        const addresses = await resolvePublicAddresses(target.hostname);
        const transport = target.protocol === 'https:' ? https : http;
        const hostNoBrackets = target.hostname.replace(/^\[|\]$/g, '');
        const options = {
          protocol: target.protocol,
          hostname: hostNoBrackets,
          port: target.protocol === 'https:' ? 443 : 80,
          method: req.method,
          path: `${target.pathname}${target.search}`,
          headers: requestHeaders,
          lookup: createPinnedLookup(addresses),
          servername: net.isIP(hostNoBrackets) ? undefined : hostNoBrackets,
          agent: target.protocol === 'https:' ? upstreamHttpsAgent : upstreamHttpAgent,
        };
        remoteResponse = await new Promise((resolve, reject) => {
          const attempt = transport.request(options);
          remoteRequest = attempt;
          attempt.setTimeout(UPSTREAM_HEADER_TIMEOUT_MS, () => attempt.destroy(new Error('UPSTREAM_TIMEOUT')));
          attempt.once('response', (response) => {
            attempt.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => attempt.destroy(new Error('UPSTREAM_TIMEOUT')));
            resolve(response);
          });
          attempt.once('error', reject);
          if (hasBody) pipeline(req, attempt, (error) => { if (error) attempt.destroy(); });
          else attempt.end();
        });
      }

      res.on('close', () => { if (!res.writableEnded) remoteRequest?.destroy(); });

      // 応答をそのまま転送(ホップバイホップと接続管理ヘッダーを除く)。
      const respTokens = connectionTokensOf(remoteResponse.headers?.connection);
      for (const [name, value] of Object.entries(remoteResponse.headers || {})) {
        if (value === undefined) continue;
        if (name === 'transfer-encoding' || name === 'connection' || name === 'keep-alive' || isHopByHop(name, respTokens)) continue;
        try { res.setHeader(name, value); } catch { /* 不正な名前は無視 */ }
      }
      res.status(remoteResponse.statusCode || 502);

      if (req.method === 'HEAD' || remoteResponse.statusCode === 204 || remoteResponse.statusCode === 304) {
        remoteResponse.resume?.();
        res.end();
        return;
      }
      pipeline(remoteResponse, res, (error) => { if (error) res.destroy(); });
    } catch (error) {
      console.error(`[hostname] ${req.method} ${targetHref}: ${error.code || ''} ${error.message}`);
      if (res.headersSent) res.destroy();
      else res.status(502).end();
    }
  };
}

module.exports = { createHostnameRouter };
