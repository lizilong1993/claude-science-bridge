//! 本地 CA 与按主机签发的叶子证书（供定向 MITM 使用）。
//! 私钥只落在工具目录 certs/ 下，不写入系统信任库。
import { execFileSync } from "node:child_process";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CERT_DIR = path.join(ROOT, "certs");
const CA_KEY = path.join(CERT_DIR, "ca.key");
const CA_PEM = path.join(CERT_DIR, "ca.pem");
const CA_SRL = path.join(CERT_DIR, "ca.srl");

const OPENSSL_CANDIDATES = [
  "openssl",
  "C:/Program Files/Git/usr/bin/openssl.exe",
  "C:/msys64/ucrt64/bin/openssl.exe",
];

let opensslBin = null;

export function findOpenssl() {
  if (opensslBin) return opensslBin;
  for (const candidate of OPENSSL_CANDIDATES) {
    try {
      execFileSync(candidate, ["version"], { stdio: "ignore" });
      opensslBin = candidate;
      return candidate;
    } catch { /* 继续尝试下一个 */ }
  }
  throw new Error("找不到 openssl，无法生成本地证书（可用 Git for Windows 自带的 openssl）");
}

function run(args) {
  execFileSync(findOpenssl(), args, { stdio: "ignore" });
}

/// 确保证书目录存在。
export function ensureCertDir() {
  fs.mkdirSync(CERT_DIR, { recursive: true });
}

/// 生成（或复用）本地 CA。返回 ca.pem 的绝对路径。
export function ensureCa() {
  ensureCertDir();
  if (fs.existsSync(CA_KEY) && fs.existsSync(CA_PEM)) return CA_PEM;
  run([
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "3650", "-nodes",
    "-keyout", CA_KEY, "-out", CA_PEM,
    "-subj", "/CN=Claude Science Local MITM CA/O=local-tool",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  return CA_PEM;
}

function safeName(host) {
  return host.replace(/[^a-zA-Z0-9.-]/g, "_");
}

/// 为指定主机签发（或复用）叶子证书，返回 { key, cert }。
export function leafFor(host) {
  ensureCa();
  const name = safeName(host);
  const keyPath = path.join(CERT_DIR, name + ".key");
  const certPath = path.join(CERT_DIR, name + ".pem");
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  const csrPath = path.join(CERT_DIR, name + ".csr");
  const extPath = path.join(CERT_DIR, name + ".ext");
  fs.writeFileSync(extPath, [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    "subjectAltName=DNS:" + host,
    "",
  ].join("\n"));
  run([
    "req", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", csrPath,
    "-subj", "/CN=" + host,
  ]);
  run([
    "x509", "-req", "-in", csrPath, "-CA", CA_PEM, "-CAkey", CA_KEY, "-CAcreateserial",
    "-out", certPath, "-days", "825", "-sha256", "-extfile", extPath,
  ]);
  fs.rmSync(csrPath, { force: true });
  fs.rmSync(extPath, { force: true });
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

/// SNI 回调：按主机名动态取证书。
export function sniContext(host) {
  const pair = leafFor(host);
  return tls.createSecureContext({ key: pair.key, cert: pair.cert });
}

export const paths = { dir: CERT_DIR, caPem: CA_PEM };
