import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const CONFIG_PATH = process.argv[2] || path.join(process.cwd(), "config.json");
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
const ROOT = path.dirname(CONFIG_PATH);
const LOG = path.join(ROOT, "gateway.log");
const up = config.upstream || {};
const MODELS = Array.isArray(up.models) ? up.models : [];

function log() {
  const line = new Date().toISOString() + " " + Array.from(arguments).map(function (a) {
    return typeof a === "string" ? a : JSON.stringify(a);
  }).join(" ");
  try { fs.appendFileSync(LOG, line + "\n"); } catch {}
  if (process.env.CSTP_VERBOSE) process.stdout.write(line + "\n");
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": payload.length });
  res.end(payload);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    req.on("data", function (c) { chunks.push(c); });
    req.on("end", function () { resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

function resolveModel(id) {
  const wanted = String(id || "");
  for (const m of MODELS) if (m.id === wanted) return m;
  for (const m of MODELS) if (m.upstream === wanted) return m;
  const match = MODELS.find(function (m) { return /opus/i.test(wanted) && /opus/i.test(m.id); })
    || MODELS.find(function (m) { return /haiku/i.test(wanted) && /haiku/i.test(m.id); })
    || MODELS.find(function (m) { return /sonnet/i.test(wanted) && /sonnet/i.test(m.id); });
  if (match) return match;
  return { id: wanted, upstream: up.fallback || wanted, displayName: wanted };
}

function modelList() {
  const now = new Date().toISOString();
  return {
    data: disambiguate(MODELS.map(function (m) {
      return withCapabilities({ id: m.id, display_name: m.displayName || m.upstream || m.id, created_at: now });
    })),
    has_more: false,
    first_id: MODELS.length ? MODELS[0].id : null,
    last_id: MODELS.length ? MODELS[MODELS.length - 1].id : null,
  };
}

/// 虚拟账户名（默认 admin），同时用作 email 与 display_name。
function accountName() {
  return (config.account && config.account.name) || "admin";
}

function profile(cfg) {
  const org = config.virtualIdentity && config.virtualIdentity.orgUuid;
  const account = config.virtualIdentity && config.virtualIdentity.accountUuid;
  const name = accountName();
  return {
    account: { uuid: account, email: name, display_name: name },
    organization: { uuid: org, name: "Local Virtual Org", organization_type: "claude_max", billing_type: "none" },
    applications: [],
    enabled_plugins: [],
  };
}

function normalizeContent(content) {
  if (typeof content === "string") return { text: content, images: [], toolResults: [] };
  const out = { text: "", images: [], toolResults: [] };
  for (const block of content || []) {
    if (block.type === "text") out.text += block.text || "";
    else if (block.type === "image" && block.source) {
      const src = block.source;
      if (src.type === "base64") out.images.push("data:" + (src.media_type || "image/png") + ";base64," + src.data);
      else if (src.type === "url") out.images.push(src.url);
    } else if (block.type === "tool_result") {
      let text = "";
      if (typeof block.content === "string") text = block.content;
      else for (const inner of block.content || []) if (inner.type === "text") text += inner.text || "";
      out.toolResults.push({ id: block.tool_use_id, text: text || "(empty)" });
    }
  }
  return out;
}

function toOpenAIMessages(body) {
  const messages = [];
  const system = normalizeContent(body.system).text;
  if (system) messages.push({ role: "system", content: system });
  for (const msg of body.messages || []) {
    if (msg.role === "assistant") {
      const parts = Array.isArray(msg.content) ? msg.content : [];
      const textParts = parts.filter(function (p) { return p.type === "text"; }).map(function (p) { return p.text; }).join("");
      const calls = parts.filter(function (p) { return p.type === "tool_use"; }).map(function (p) {
        return { id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.input || {}) } };
      });
      const out = { role: "assistant" };
      if (textParts) out.content = textParts;
      if (calls.length) out.tool_calls = calls;
      if (out.content || out.tool_calls) messages.push(out);
    } else {
      const norm = normalizeContent(msg.content);
      for (const tr of norm.toolResults) messages.push({ role: "tool", tool_call_id: tr.id, content: tr.text });
      if (norm.text || norm.images.length) {
        if (norm.images.length) {
          const parts = [];
          if (norm.text) parts.push({ type: "text", text: norm.text });
          for (const url of norm.images) parts.push({ type: "image_url", image_url: { url: url } });
          messages.push({ role: "user", content: parts });
        } else {
          messages.push({ role: "user", content: norm.text });
        }
      }
    }
  }
  return messages;
}

function toOpenAITools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map(function (t) {
    return { type: "function", function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object", properties: {} } } };
  });
}

function sse(res, event, data) {
  res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
}

async function upstreamFetch(url, init) {
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, 600000);
  try {
    return await fetch(url, Object.assign({}, init, { signal: ctl.signal }));
  } finally { clearTimeout(timer); }
}

function upstreamAnthropicPath(base) {
  const b = String(base || "").replace(/\/+$/, "");
  return b + "/v1/messages";
}

function upstreamHeaders() {
  const h = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  if (up.bearerToken) h.authorization = "Bearer " + up.bearerToken;
  else h["x-api-key"] = up.apiKey || "";
  return h;
}

/// 原样透传一个 GET 端点（用于复用 cc-switch 的 /claude-desktop 模型目录）。
async function proxyUpstreamGet(pathname, res) {
  const url = String(up.baseUrl || "").replace(/\/+$/, "") + pathname;
  const r = await upstreamFetch(url, { method: "GET", headers: upstreamHeaders() });
  const text = await r.text();
  log("passthrough GET " + pathname + " ->", r.status);
  res.writeHead(r.status, { "content-type": "application/json" });
  res.end(Buffer.from(text));
}

function labelFor(id) {
  for (const m of MODELS) if (m.id === id) return m.displayName || m.upstream || id;
  return id;
}

function roleOf(id) {
  const s = String(id || "");
  for (const role of ["Opus", "Sonnet", "Haiku", "Fable"]) {
    if (s.toLowerCase().indexOf(role.toLowerCase()) >= 0) return role;
  }
  return s;
}

/// 补齐模型能力字段。
/// Science 只登记带 max_tokens / max_input_tokens / capabilities.effort.supported
/// 之一的模型（见二进制里的 _Vt）；全缺时模型选择器会是空的，reviewer model 也不可用。
function withCapabilities(m) {
  return Object.assign({}, m, {
    type: "model",
    created_at: m.created_at || new Date().toISOString(),
    display_name: m.display_name || m.displayName || labelFor(m.id),
    max_tokens: typeof m.max_tokens === "number" ? m.max_tokens : 64000,
    max_input_tokens: typeof m.max_input_tokens === "number"
      ? m.max_input_tokens
      : (m.supports1m ? 1000000 : 200000),
    capabilities: m.capabilities || { effort: { supported: true } },
  });
}

/// 多个角色映射到同一上游模型时（cc-switch 常见），给重名的加上角色后缀，避免选择器里无法区分。
function disambiguate(list) {
  const counts = {};
  for (const m of list) counts[m.display_name] = (counts[m.display_name] || 0) + 1;
  for (const m of list) {
    if (counts[m.display_name] > 1) m.display_name = m.display_name + " · " + roleOf(m.id);
  }
  return list;
}

/// 透传上游模型目录并补齐 display_name 与能力字段。
async function proxyUpstreamModels(res) {
  const url = String(up.baseUrl || "").replace(/\/+$/, "") + "/v1/models";
  const r = await upstreamFetch(url, { method: "GET", headers: upstreamHeaders() });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!body || !Array.isArray(body.data)) {
    log("models passthrough non-json ->", r.status);
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(Buffer.from(text));
    return;
  }
  body.data = disambiguate(body.data.map(withCapabilities));
  log("models passthrough ->", r.status, "count=" + body.data.length);
  json(res, 200, body);
}

async function handleAnthropicPassthrough(body, res) {
  const model = resolveModel(body.model);
  const target = up.rewriteModel === false ? body.model : model.upstream || body.model;
  const payload = Object.assign({}, body, { model: target });
  const r = await upstreamFetch(upstreamAnthropicPath(up.baseUrl), {
    method: "POST",
    headers: upstreamHeaders(),
    body: JSON.stringify(payload),
  });
  log("upstream anthropic ->", r.status);
  if (!r.ok) { const t = await r.text(); log("upstream error body", t.slice(0, 500)); return json(res, r.status, { type: "error", error: { type: "api_error", message: t.slice(0, 500) } }); }
  res.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json", "cache-control": "no-cache" });
  if (!body.stream) { res.end(Buffer.from(await r.text())); return; }
  const reader = r.body.getReader();
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; res.write(chunk.value); }
  res.end();
}

async function handleOpenAI(body, res) {
  const model = resolveModel(body.model);
  const streaming = !!body.stream;
  const payload = { model: model.upstream || body.model, messages: toOpenAIMessages(body), stream: streaming };
  const tools = toOpenAITools(body.tools);
  if (tools) payload.tools = tools;
  if (body.temperature != null) payload.temperature = body.temperature;
  if (body.max_tokens != null) payload.max_tokens = body.max_tokens;
  if (streaming) payload.stream_options = { include_usage: true };
  const url = String(up.baseUrl || "").replace(/\/+$/, "") + "/chat/completions";
  const r = await upstreamFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + (up.apiKey || "") },
    body: JSON.stringify(payload),
  });
  log("upstream openai ->", r.status);
  if (!r.ok) {
    const t = await r.text();
    log("upstream error body", t.slice(0, 800));
    let message = t.slice(0, 800);
    try { const parsed = JSON.parse(t); message = (parsed.error && parsed.error.message) || parsed.message || message; } catch {}
    return json(res, r.status, { type: "error", error: { type: "api_error", message: message } });
  }
  if (!streaming) {
    const data = await r.json();
    const out = openAIResponseToAnthropic(data, body.model);
    return json(res, 200, out);
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  await streamOpenAIToAnthropic(r, res, body.model);
}

function openAIResponseToAnthropic(data, requestedModel) {
  const choice = (data.choices || [])[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const call of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(call.function.arguments || "{}"); } catch {}
    content.push({ type: "tool_use", id: call.id || ("toolu_" + crypto.randomBytes(12).toString("hex")), name: call.function.name, input: input });
  }
  const usage = data.usage || {};
  return {
    id: data.id || ("msg_" + crypto.randomBytes(12).toString("hex")),
    type: "message",
    role: "assistant",
    model: requestedModel,
    content: content,
    stop_reason: mapFinish(choice.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
  };
}

function mapFinish(reason) {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  return "end_turn";
}

async function streamOpenAIToAnthropic(r, res, requestedModel) {
  const id = "msg_" + crypto.randomBytes(12).toString("hex");
  sse(res, "message_start", { type: "message_start", message: { id: id, type: "message", role: "assistant", model: requestedModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  let blockIndex = -1;
  let blockKind = null;
  let toolCounter = 0;
  let finish = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  let textOpen = false;

  function closeBlock() {
    if (blockIndex < 0) return;
    sse(res, "content_block_stop", { type: "content_block_stop", index: blockIndex });
    blockIndex = -1;
    blockKind = null;
    textOpen = false;
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (raw === "[DONE]") continue;
      let evt;
      try { evt = JSON.parse(raw); } catch { continue; }
      if (evt.usage) usage = { input_tokens: evt.usage.prompt_tokens || usage.input_tokens, output_tokens: evt.usage.completion_tokens || usage.output_tokens };
      const choice = (evt.choices || [])[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (choice.finish_reason) finish = choice.finish_reason;
      if (delta.content) {
        if (blockKind !== "text") {
          closeBlock();
          blockIndex = ++toolCounter - 1;
          if (blockIndex < 0) blockIndex = 0;
          sse(res, "content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } });
          blockKind = "text";
          textOpen = true;
        }
        sse(res, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: delta.content } });
      }
      for (const call of delta.tool_calls || []) {
        if (call.id) {
          closeBlock();
          blockIndex = toolCounter++;
          blockKind = "tool";
          sse(res, "content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id: call.id, name: (call.function && call.function.name) || "tool", input: {} } });
        }
        if (call.function && call.function.arguments) {
          sse(res, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: call.function.arguments } });
        }
      }
    }
  }
  closeBlock();
  sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: mapFinish(finish), stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

function virtualTokenCount(body) {
  return Math.max(1, Math.ceil(JSON.stringify(body.messages || []).length / 4));
}

const server = http.createServer(async function (req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    if (req.method === "GET" && (p === "/v1/models" || p === "/v1/models/")) {
      if (up.passthroughModels && up.baseUrl) return await proxyUpstreamModels(res);
      return json(res, 200, modelList());
    }
    if (req.method === "GET" && p.startsWith("/v1/models/")) {
      const id = decodeURIComponent(p.slice("/v1/models/".length));
      const m = MODELS.find(function (x) { return x.id === id; });
      if (!m) return json(res, 404, { type: "error", error: { type: "not_found_error", message: "model not found" } });
      return json(res, 200, { type: "model", id: m.id, display_name: m.displayName || m.id, created_at: new Date().toISOString() });
    }
    if (p === "/api/oauth/profile") return json(res, 200, profile(1));
    if (p === "/api/oauth/account") return json(res, 200, { uuid: (config.virtualIdentity || {}).accountUuid, email: accountName(), display_name: accountName(), memberships: [] });
    if (p === "/api/oauth/usage") return json(res, 200, { five_hour: { utilization: 0.01, resets_at: null }, seven_day: { utilization: 0.01, resets_at: null }, seven_day_opus: null });
    if (p === "/api/oauth/account/settings") return json(res, 200, {});
    if (p === "/api/oauth/operon/create_api_key" || p === "/api/oauth/operon/create") {
      const raw = await readBody(req);
      log("operon create body", raw.toString("utf-8").slice(0, 600));
      return json(res, 200, { api_key: "sk-ant-virtual-" + crypto.randomBytes(24).toString("hex"), organization_uuid: (config.virtualIdentity || {}).orgUuid });
    }
    if (req.method === "POST" && (p === "/v1/messages" || p === "/v1/messages?beta=true")) {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw.toString("utf-8")); } catch { return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "bad json" } }); }
      log("messages", { model: body.model, stream: !!body.stream, msgs: (body.messages || []).length, tools: (body.tools || []).length });
      if (!up.type || up.type === "openai") return await handleOpenAI(body, res);
      return await handleAnthropicPassthrough(body, res);
    }
    if (req.method === "POST" && p === "/v1/messages/count_tokens") {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString("utf-8")); } catch {}
      return json(res, 200, { input_tokens: virtualTokenCount(body) });
    }
    log("unhandled", req.method, p);
    return json(res, 404, { type: "error", error: { type: "not_found_error", message: "no route for " + p } });
  } catch (err) {
    log("handler error", String(err && err.message || err));
    try { json(res, 500, { type: "error", error: { type: "api_error", message: String(err && err.message || err) } }); } catch {}
  }
});

const port = (config.gateway && config.gateway.port) || 18991;
const host = (config.gateway && config.gateway.host) || "127.0.0.1";
server.listen(port, host, function () {
  log("gateway listening on http://" + host + ":" + port + " upstream=" + (up.type || "openai") + " " + (up.baseUrl || ""));
  process.stdout.write("gateway listening on http://" + host + ":" + port + "\n");
});