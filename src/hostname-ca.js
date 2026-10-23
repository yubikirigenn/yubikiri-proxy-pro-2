'use strict';

// ホスト名モードのPC側で使う自己署名ルートCAと、SNI単位の葉証明書を生成する。
// ルートCA鍵・証明書はローカルフォルダ(既定: OSの一時ではなく ~/.yubikiri-hostname)
// に保存し、次回以降再利用する。葉証明書はメモリにキャッシュする。
// 秘密鍵は一切コミットしない(.gitignoreで対象フォルダを除外)。
//
// 注意: これは端末に自己署名ルートを信頼させる仕組みで、導入中は本中継が
// 当該端末のHTTPSを復号できる状態になる。ホスト名モードの性質上避けられない
// ため、解除スクリプトで証明書と鍵を削除して元に戻せるようにしている。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const forge = require('node-forge');

const pki = forge.pki;
const CA_SUBJECT = [{ name: 'commonName', value: 'Yubikiri Hostname Mode CA' }, { name: 'organizationName', value: 'Yubikiri Proxy' }];

function defaultCaDir() {
  if (process.env.HOSTNAME_CA_DIR) return process.env.HOSTNAME_CA_DIR;
  return path.join(os.homedir(), '.yubikiri-hostname');
}

function serial() {
  return '0' + forge.util.bytesToHex(forge.random.getBytesSync(8));
}

function generateKeyPairAndCert(isCa, subjectAttrs) {
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = isCa
    ? new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000)
    : new Date(Date.now() + 825 * 24 * 3600 * 1000);
  cert.setSubject(subjectAttrs);
  if (isCa) {
    cert.setIssuer(subjectAttrs);
    cert.setExtensions([
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true },
      { name: 'subjectKeyIdentifier' },
    ]);
  }
  return { keys, cert };
}

function loadOrCreateCa(caDir) {
  fs.mkdirSync(caDir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(caDir, 'ca.key.pem');
  const certPath = path.join(caDir, 'ca.cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return {
      key: pki.privateKeyFromPem(fs.readFileSync(keyPath, 'utf8')),
      cert: pki.certificateFromPem(fs.readFileSync(certPath, 'utf8')),
      certPath,
    };
  }
  const { keys, cert } = generateKeyPairAndCert(true, CA_SUBJECT);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  fs.writeFileSync(keyPath, pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
  fs.writeFileSync(certPath, pki.certificateToPem(cert));
  return { key: keys.privateKey, cert, certPath };
}

// 葉証明書はホスト名ごとに生成しキャッシュする(生成は重いので再利用)。
const leafCache = new Map();

function issueLeaf(ca, hostname) {
  const cached = leafCache.get(hostname);
  if (cached && cached.notAfter > Date.now()) return cached;
  const { keys, cert } = generateKeyPairAndCert(false, [{ name: 'commonName', value: hostname }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());
  const entry = {
    cert: pki.certificateToPem(cert),
    key: pki.privateKeyToPem(keys.privateKey),
    notAfter: cert.validity.notAfter.getTime(),
  };
  leafCache.set(hostname, entry);
  return entry;
}

module.exports = { defaultCaDir, loadOrCreateCa, issueLeaf };
