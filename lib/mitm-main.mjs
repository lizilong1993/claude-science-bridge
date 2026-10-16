//! MITM 进程入口：由 start.mjs 以 detached 方式拉起。
import fs from "node:fs";

import { createAccountApi } from "./account-api.mjs";
import { ensureCa, leafFor } from "./ca.mjs";
import { createMitm } from "./mitm.mjs";

const configPath = process.argv[2];
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const em = config.accountEmulation || {};

const accountApi = createAccountApi({
  accountName: em.accountName,
  orgUuid: em.orgUuid,
  accountUuid: em.accountUuid,
  skillsDir: em.skillsDir,
  emulateSkillRegistry: em.emulateSkillRegistry,
});

// 证书必须"先于 app 启动"就绪：若首次运行时 ca.pem 还不存在，
// 启动器传给 app 的 NODE_EXTRA_CA_CERTS 会指向空文件，导致 daemon 之后全部 TLS 校验失败。
ensureCa();
for (const host of (em.interceptHosts || [])) {
  try { leafFor(host); } catch (error) { process.stderr.write("leaf for " + host + " failed: " + error.message + "\n"); }
}

const mitm = createMitm({
  interceptHosts: em.interceptHosts,
  accountApi: accountApi,
  upstreamProxy: em.upstreamProxy,
  unmatchedAccountPathStatus: em.unmatchedAccountPathStatus,
});

mitm.listen(em.port).then(function (port) {
  process.stdout.write("mitm listening on 127.0.0.1:" + port + "\n");
}).catch(function (error) {
  process.stderr.write("mitm failed: " + error.message + "\n");
  process.exit(1);
});
