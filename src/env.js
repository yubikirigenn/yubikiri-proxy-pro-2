'use strict';

// リポジトリ直下の .env を読む最小ローダー(dotenv相当・依存なし)。
// 既に環境変数へ値がある場合は上書きしない。.env は .gitignore 済みで
// 秘密の値をコミットしない。起動をダブルクリック1回に簡素化するためのもの。

const fs = require('node:fs');
const path = require('node:path');

const ENV_PATH = path.join(__dirname, '..', '.env');

function loadEnv() {
  let raw;
  try { raw = fs.readFileSync(ENV_PATH, 'utf8'); } catch { return; }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

function writeEnv(entries) {
  const lines = ['# Yubikiri Proxy - start-agent.cmd / setup-agent が管理'];
  for (const [key, value] of Object.entries(entries)) {
    if (value) lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n');
}

module.exports = { loadEnv, writeEnv, ENV_PATH };
