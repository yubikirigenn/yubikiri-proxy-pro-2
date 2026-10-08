'use strict';

// Agent hub: lets the user's own PC act as the upstream fetcher while it is
// running. The PC runs src/agent.js, which keeps a long-poll connection to
// this hub (outbound only - no port forwarding on the PC side). Proxied
// requests are handed to the agent as jobs; when no agent has polled
// recently, or the agent fails to pick a job up in time, the proxy falls
// back to fetching directly from the Render instance as before.

const crypto = require('node:crypto');
const express = require('express');

const AGENT_FRESH_MS = 15_000;
const JOB_PICKUP_TIMEOUT_MS = 30_000;
const AGENT_POLL_HOLD_MS = 20_000;
const JOB_TTL_MS = 90_000;
// 引き渡し済みジョブは長いストリーミング（ChatGPT等）の最中でもあるので、
// 結果が来ないままエージェントが死んだ場合の回収上限だけ長めに置く。
const JOB_STREAM_TTL_MS = 300_000;

function safeEqual(provided, secret) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(secret));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createAgentHub({ secret }) {
  const enabled = typeof secret === 'string' && secret.length >= 8;
  if (!enabled) return { enabled: false, router: null, isActive: () => false, dispatch: null, status: () => ({ enabled: false }) };

  let jobSeq = 0;
  let lastAgentPoll = 0;
  const jobs = new Map();
  const handoutQueue = [];
  const waitingAgents = [];

  const handOut = (res) => {
    while (handoutQueue.length) {
      const job = jobs.get(handoutQueue.shift());
      if (job) {
        job.handedOut = true;
        // 引き渡されたジョブの上流取得は6秒より長く普通にある（ChatGPT等）。
        // ここでピックアップ監視を止めないと、取得中に二重フォールバックが
        // 発火し、後から届く結果が410で捨てられてしまう。
        if (job.pickupTimer) { clearTimeout(job.pickupTimer); job.pickupTimer = null; }
        res.json({ job: job.descriptor });
        return true;
      }
    }
    return false;
  };

  const router = express.Router();
  router.use((req, res, next) => {
    if (!safeEqual(req.get('x-yubikiri-agent-secret'), secret)) {
      res.status(401).json({ error: 'agent secret mismatch' });
      return;
    }
    lastAgentPoll = Date.now();
    next();
  });

  router.get('/job', (req, res) => {
    if (handOut(res)) return;
    const timer = setTimeout(() => {
      const index = waitingAgents.indexOf(resume);
      if (index >= 0) waitingAgents.splice(index, 1);
      if (res.destroyed || res.writableEnded) return;
      res.json({ job: null });
    }, AGENT_POLL_HOLD_MS);
    const resume = () => {
      clearTimeout(timer);
      if (res.destroyed || res.writableEnded) return;
      if (!handOut(res)) res.json({ job: null });
    };
    waitingAgents.push(resume);
    res.on('close', () => {
      clearTimeout(timer);
      const index = waitingAgents.indexOf(resume);
      if (index >= 0) waitingAgents.splice(index, 1);
    });
  });

  router.post('/result/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      res.status(410).end();
      req.resume();
      return;
    }
    jobs.delete(job.id);
    const outcome = {
      status: Number(req.get('x-yubikiri-status')) || 502,
      headers: (() => {
        try { return JSON.parse(Buffer.from(String(req.get('x-yubikiri-headers') || ''), 'base64url').toString('utf8')); }
        catch { return {}; }
      })(),
      error: req.get('x-yubikiri-error') || '',
      stream: req,
    };
    job.settle(outcome);
    // Keep the result response open until its body has been consumed; ending
    // it now would abort the stream before the proxy pipes it to the browser.
    // The stream stays paused so no chunk is lost before the consumer attaches.
    const finish = () => { try { res.status(202).end(); } catch {} };
    req.on('end', finish);
    req.on('error', finish);
    req.on('close', finish);
  });

  router.get('/status', (_req, res) => {
    res.json({ enabled: true, agentsWaiting: waitingAgents.length, jobsPending: jobs.size, lastPollAgoMs: Date.now() - lastAgentPoll });
  });

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs) {
      // 引き渡し済みジョブは結果受信時に消える。ストリーミング中に回収しない。
      const limit = job.handedOut ? JOB_STREAM_TTL_MS : JOB_TTL_MS;
      if (now - job.created > limit) {
        jobs.delete(id);
        job.settle({ error: 'JOB_EXPIRED', status: 502, headers: {}, stream: null });
      }
    }
  }, 30_000);
  sweep.unref();

  const isActive = () => Date.now() - lastAgentPoll < AGENT_FRESH_MS;

  // Returns a Readable with statusCode/headers on success, or null when the
  // caller should fall back to its own direct upstream fetch. Requires an
  // agent to actually be holding a long-poll right now, so a freshly dead
  // agent degrades to the direct path without the pickup timeout.
  const dispatch = (descriptor) => new Promise((resolveDispatch) => {
    if (!isActive() || waitingAgents.length === 0) {
      resolveDispatch(null);
      return;
    }
    const id = `job-${Date.now().toString(36)}-${(++jobSeq).toString(36)}`;
    const job = {
      id,
      descriptor: { id, method: descriptor.method, url: descriptor.url, headers: descriptor.headers, bodyBase64: descriptor.bodyBase64 },
      created: Date.now(),
      settled: false,
      settle: (outcome) => {
        if (job.settled) return;
        job.settled = true;
        if (job.pickupTimer) { clearTimeout(job.pickupTimer); job.pickupTimer = null; }
        resolveDispatch(outcome.error ? null : attachMeta(outcome));
      },
    };
    jobs.set(id, job);
    handoutQueue.push(id);
    const resume = waitingAgents.shift();
    if (resume) resume();
    job.pickupTimer = setTimeout(() => job.settle({ error: 'PICKUP_TIMEOUT', status: 502, headers: {}, stream: null }), JOB_PICKUP_TIMEOUT_MS).unref();
  });

  const attachMeta = (outcome) => {
    const body = outcome.stream || null;
    if (body) {
      body.statusCode = outcome.status;
      body.headers = outcome.headers || {};
    }
    return body;
  };

  const status = () => ({ enabled: true, active: isActive(), agentsWaiting: waitingAgents.length, jobsPending: jobs.size, lastPollAgoMs: Date.now() - lastAgentPoll });

  return { enabled: true, router, isActive, dispatch, status };
}

module.exports = { createAgentHub, b64url };
