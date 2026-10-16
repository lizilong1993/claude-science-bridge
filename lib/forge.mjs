import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const KEY_NAMES = [
  "ANTHROPIC_API_KEY_ENCRYPTION_KEY",
  "OAUTH_ENCRYPTION_KEY",
  "JWT_SIGNING_SECRET",
  "USER_SECRET_ENCRYPTION_KEY",
];
const HKDF_INFO = "operon:aes-256-gcm:oauth";
const AAD = Buffer.from("v2:oauth", "utf-8");
const MAGIC = "v2:";

function deriveKey(oauthKeyB64) {
  const ikm = Buffer.from(oauthKeyB64.trim(), "base64");
  return Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), HKDF_INFO, 32));
}

export function encryptTokenV2(plaintext, oauthKeyB64) {
  const key = deriveKey(oauthKeyB64);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  return MAGIC + Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64");
}

export function decryptTokenV2(body, oauthKeyB64) {
  const raw = Buffer.from(body.slice(MAGIC.length), "base64");
  const iv = raw.subarray(0, 12);
  const rest = raw.subarray(12);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(oauthKeyB64), iv, { authTagLength: 16 });
  decipher.setAAD(AAD);
  decipher.setAuthTag(rest.subarray(rest.length - 16));
  return Buffer.concat([decipher.update(rest.subarray(0, rest.length - 16)), decipher.final()]).toString("utf-8");
}

function parseKeyFile(text) {
  const keys = new Map();
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k && v) keys.set(k, v);
  }
  return keys;
}

function readExistingKeys(keyFile) {
  if (!fs.existsSync(keyFile)) return new Map();
  return parseKeyFile(fs.readFileSync(keyFile, "utf-8"));
}

export function ensureEncryptionKey(dataDir) {
  const keyFile = path.join(dataDir, "encryption.key");
  const keys = readExistingKeys(keyFile);
  const oauthOk = (() => {
    const v = keys.get("OAUTH_ENCRYPTION_KEY");
    if (!v) return false;
    try { return Buffer.from(v, "base64").length >= 16; } catch { return false; }
  })();
  if (!oauthOk) keys.delete("OAUTH_ENCRYPTION_KEY");
  for (const name of KEY_NAMES) {
    if (!keys.has(name)) keys.set(name, randomBytes(32).toString("base64"));
  }
  const blob = KEY_NAMES.map((n) => n + "=" + keys.get(n)).join("\n") + "\n";
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(keyFile, blob, { mode: 0o600 });
  return keys.get("OAUTH_ENCRYPTION_KEY");
}

function uuidV4() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join("-");
}

export function readExistingLogin(dataDir) {
  const tokDir = path.join(dataDir, ".oauth-tokens");
  if (!fs.existsSync(tokDir)) return null;
  const encs = fs.readdirSync(tokDir).filter((f) => f.endsWith(".enc"));
  if (encs.length !== 1) return null;
  const oauthKey = readExistingKeys(path.join(dataDir, "encryption.key")).get("OAUTH_ENCRYPTION_KEY");
  if (!oauthKey) return null;
  try {
    const blob = JSON.parse(decryptTokenV2(fs.readFileSync(path.join(tokDir, encs[0]), "utf-8"), oauthKey));
    if (blob.provider !== "claude_ai" || !blob.account_uuid || !blob.org_uuid) return null;
    return blob;
  } catch { return null; }
}

export function writeVirtualLogin(dataDir, { email = "virtual@localhost.invalid", accountUuid, orgUuid, accessToken } = {}) {
  // 允许裸账户名（如 admin）；带 @ 的必须仍是 .invalid 保留域，确保永远不会是真实账号。
  if (!email || (email.includes("@") && !email.endsWith("localhost.invalid"))) {
    throw new Error("refusing: account name must not look like a real email address");
  }
  const previous = readExistingLogin(dataDir);
  const oauthKey = ensureEncryptionKey(dataDir);
  const account = accountUuid ?? previous?.account_uuid ?? uuidV4();
  const org = orgUuid ?? previous?.org_uuid ?? uuidV4();

  const blob = {
    access_token: accessToken ?? "sk-ant-virtual-" + randomBytes(24).toString("hex"),
    refresh_token: "",
    api_key: null,
    token_expires_at: "2099-01-01T00:00:00.000Z",
    provider: "claude_ai",
    scopes: "user:inference user:file_upload user:profile user:mcp_servers user:plugins",
    email,
    account_uuid: account,
    subscription_type: "max",
    rate_limit_tier: null,
    seat_tier: null,
    org_uuid: org,
    billing_type: null,
    has_extra_usage_enabled: false,
  };
  const body = encryptTokenV2(JSON.stringify(blob), oauthKey);
  const roundTrip = JSON.parse(decryptTokenV2(body, oauthKey));
  if (roundTrip.email !== email || roundTrip.org_uuid !== org) throw new Error("self-check failed");

  const tokDir = path.join(dataDir, ".oauth-tokens");
  fs.mkdirSync(tokDir, { recursive: true });
  for (const f of fs.readdirSync(tokDir)) {
    if (f.endsWith(".enc")) fs.rmSync(path.join(tokDir, f));
  }
  const userId = account.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!userId) throw new Error("empty user id after sanitization");
  fs.writeFileSync(path.join(tokDir, userId + ".enc"), body, { mode: 0o600 });
  fs.writeFileSync(
    path.join(dataDir, "active-org.json"),
    JSON.stringify({ org_uuid: org }, null, 2) + "\n",
    { mode: 0o600 },
  );
  return { email, account_uuid: account, org_uuid: org };
}
