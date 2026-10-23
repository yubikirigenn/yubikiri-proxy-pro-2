'use strict';

// エージェントの初回セットアップ(対話)。RENDER_URL と AGENT_SECRET を聞いて
// .env へ保存する。2回目以降は start-agent.cmd がこの手順を自動的に飛ばす。
// 対話(console)とパイプ入力(自動テスト)の両方で動くようにする。

const fs = require('node:fs');
const readline = require('node:readline');
const { loadEnv, writeEnv, ENV_PATH } = require('./env');

async function readPipedLines() {
  const input = await new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
  return input.split(/\r?\n/).map((line) => line.trim());
}

async function main() {
  loadEnv();
  const isTTY = Boolean(process.stdin.isTTY);
  const rl = isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  const piped = isTTY ? null : await readPipedLines();
  let pipedIndex = 0;
  const ask = (question) => new Promise((resolve) => {
    if (rl) rl.question(question, (answer) => resolve(answer.trim()));
    else { process.stdout.write(question); resolve(piped[pipedIndex++] || ''); }
  });

  console.log('Yubikiri エージェントの初回設定です。一度だけ聞きます。');
  let renderUrl = process.env.RENDER_URL || '';
  if (!renderUrl) renderUrl = await ask('RENDER_URL (例: https://yubikiri-proxy-pro-2.onrender.com): ');
  else console.log(`RENDER_URL: ${renderUrl} (.envから読み込み)`);
  while (!/^https?:\/\/.+/.test(renderUrl)) {
    renderUrl = await ask('URLの形式が正しくありません。https://... で入力してください: ');
  }
  renderUrl = renderUrl.replace(/\/+$/, '');

  let secret = process.env.AGENT_SECRET || '';
  if (!secret) secret = await ask('AGENT_SECRET (Renderの環境変数と同じ値): ');
  else console.log('AGENT_SECRET: (.envから読み込み)');
  while (secret.length < 8) {
    secret = await ask('8文字以上必要です(サーバー側の要件): ');
  }

  const entries = { RENDER_URL: renderUrl, AGENT_SECRET: secret };
  if (fs.existsSync(ENV_PATH)) {
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
      if (m && !entries[m[1]]) entries[m[1]] = m[2].trim();
    }
  }
  writeEnv(entries);
  if (rl) rl.close();
  console.log(`${ENV_PATH} に保存しました。次回からは start-agent.cmd のダブルクリックだけで起動できます。`);
}

main().catch((error) => { console.error(error.message); process.exit(1); });
