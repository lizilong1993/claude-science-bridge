//! 定向 MITM：只对白名单主机做 TLS 终止与账号接口仿真，其余一律盲隧道透传。
//! 不修改 hosts、不写入系统信任库；证书信任由启动器注入的 NODE_EXTRA_CA_CERTS 提供。
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import { leafFor, sniContext } from "./ca.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG = path.join(ROOT, "mitm.log");

function log() {
  const line = new Date().toISOString() + " " + Array.from(arguments).map(function (a) {
    return typeof a === "string" ? a : JSON.stringify(a);
  }).join(" ");
  try { fs.appendFileSync(LOG, line + "\n"); } catch { /* 日志失败不影响代理 */ }
  if (process.env.CSTP_VERBOSE) process.stdout.write(line + "\n");
}

/// 通过上游代理（如 Clash）建立到 host:port 的 TCP 隧道；无上游则直连。
function dialUpstream(host, port, upstreamProxy) {
  return new Promise(function (resolve, reject) {
    if (!upstreamProxy) {
      const socket = net.connect({ host: host, port: port }, function () { resolve(socket); });
      socket.on("error", reject);
      return;
    }
    let proxyHost, proxyPort;
    try {
      const u = new URL(upstreamProxy);
      proxyHost = u.hostname;
      proxyPort = Number(u.port || 80);
    } catch (error) { reject(error); return; }
    const socket = net.connect({ host: proxyHost, port: proxyPort }, function () {
      socket.write("CONNECT " + host + ":" + port + " HTTP/1.1\r\nHost: " + host + ":" + port + "\r\n\r\n");
    });
    socket.on("error", reject);
    let buffered = "";
    const onData = function (chunk) {
      buffered += chunk.toString("latin1");
      if (buffered.indexOf("\r\n\r\n") < 0) return;
      socket.removeListener("data", onData);
      const status = Number((buffered.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1] || 0);
      if (status !== 200) { reject(new Error("上游代理 CONNECT 失败: " + status)); return; }
      const rest = buffered.slice(buffered.indexOf("\r\n\r\n") + 4);
      if (rest) socket.unshift(Buffer.from(rest, "latin1"));
      resolve(socket);
    };
    socket.on("data", onData);
  });
}

/// 从流里读出一个完整的 HTTP/1.1 请求（含正文），返回 {raw, parsed}。
function readRequest(socket) {
  return new Promise(function (resolve, reject) {
    let buffer = Buffer.alloc(0);
    const onData = function (chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) { if (buffer.length > 65536) fail(new Error("请求头过大")); return; }
      const head = buffer.subarray(0, headerEnd).toString("latin1");
      const lines = head.split("\r\n");
      const match = lines[0].match(/^([A-Z]+) (\S+) HTTP\/(\d\.\d)$/);
      if (!match) { fail(new Error("无法解析请求行")); return; }
      const headers = {};
      for (const line of lines.slice(1)) {
        const index = line.indexOf(":");
        if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
      }
      const length = Number(headers["content-length"] || 0);
      const bodyStart = headerEnd + 4;
      if (buffer.length - bodyStart < length) return;
      cleanup();
      resolve({
        raw: buffer.subarray(0, bodyStart + length),
        method: match[1],
        path: match[2],
        httpVersion: match[3],
        headers: headers,
        body: buffer.subarray(bodyStart, bodyStart + length),
      });
    };
    const fail = function (error) { cleanup(); reject(error); };
    const cleanup = function () { socket.removeListener("data", onData); socket.removeListener("error", fail); };
    socket.on("data", onData);
    socket.on("error", fail);
  });
}

function writeResponse(socket, status, headers, body) {
  const lines = ["HTTP/1.1 " + status + " " + (status === 200 ? "OK" : "Error")];
  const merged = Object.assign({}, headers);
  merged["content-length"] = String(body.length);
  merged.connection = "keep-alive";
  for (const key of Object.keys(merged)) lines.push(key + ": " + merged[key]);
  socket.write(lines.join("\r\n") + "\r\n\r\n");
  if (body.length) socket.write(body);
}

export function createMitm(options) {
  const intercept = new Set(options.interceptHosts || []);
  const accountApi = options.accountApi;
  const upstreamProxy = options.upstreamProxy || "";
  const fallbackStatus = options.unmatchedAccountPathStatus || 404;

  const inner = http.createServer(function (req, res) {
    // 理论不会走到这里：所有请求都经 readRequest 手工处理。
    res.writeHead(501);
    res.end();
  });

  async function handleInner(socket, host) {
    for (;;) {
      let request;
      try { request = await readRequest(socket); } catch { return; }
      const handled = accountApi({ method: request.method, path: request.path, headers: request.headers, body: request.body, host: host });
      if (handled) {
        writeResponse(socket, handled.status, handled.headers, handled.body);
        log("emulated", request.method, host, request.path, "->", handled.status);
        continue;
      }
      // 白名单主机 + 虚拟账号：未实现的账号路径不可能在真实上游成功，
      // 拨号只会超时（实测 /skills/list-skills 会挂 4-9s）。因此快速返回 fallbackStatus，
      // 让 Science 走它自己的降级分支（404 → 认定远程注册表不可用、以内嵌目录为准）。
      writeResponse(socket, fallbackStatus, { "content-type": "application/json" }, Buffer.from("{}"));
      log("fallback", request.method, host, request.path, "->", fallbackStatus);
    }
  }

  const proxy = http.createServer(function (req, res) {
    res.writeHead(501);
    res.end();
  });

  proxy.on("connect", async function (req, clientSocket, head) {
    const target = req.url || "";
    const index = target.lastIndexOf(":");
    const host = index > 0 ? target.slice(0, index) : target;
    const port = index > 0 ? Number(target.slice(index + 1)) : 443;
    if (!intercept.has(host)) {
      // 盲隧道：工具看不到内容。
      try {
        const upstream = await dialUpstream(host, port, upstreamProxy);
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
        const done = function () { try { upstream.destroy(); } catch {} try { clientSocket.destroy(); } catch {} };
        upstream.on("error", done);
        clientSocket.on("error", done);
      } catch (error) {
        log("tunnel failed", host, String(error && error.message || error));
        try { clientSocket.destroy(); } catch {}
      }
      return;
    }
    log("intercept", host);
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    let tlsSocket;
    try {
      const pair = leafFor(host);
      tlsSocket = new tls.TLSSocket(clientSocket, {
        isServer: true,
        key: pair.key,
        cert: pair.cert,
        SNICallback: function (servername, cb) { cb(null, sniContext(servername)); },
      });
    } catch (error) {
      log("tls setup failed", host, String(error && error.message || error));
      try { clientSocket.destroy(); } catch {}
      return;
    }
    tlsSocket.on("error", function (error) { log("tls error", host, String(error && error.message || error)); });
    handleInner(tlsSocket, host);
  });

  return {
    listen: function (port) {
      return new Promise(function (resolve, reject) {
        proxy.once("error", reject);
        proxy.listen(port, "127.0.0.1", function () { resolve(port); });
      });
    },
    server: proxy,
  };
}
