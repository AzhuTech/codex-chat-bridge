#!/usr/bin/env node
import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DEFAULT_CONFIG_PATH = path.join(ROOT, "config", "config.json");
const DEFAULT_STATE_PATH = path.join(ROOT, "data", "state.json");

function log(level, message, meta = {}) {
  const safe = JSON.stringify(meta, (_, value) => {
    if (typeof value === "string" && value.length > 24 && /token|secret|authorization/i.test(_ || "")) {
      return `${value.slice(0, 4)}...redacted`;
    }
    return value;
  });
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, message, ...JSON.parse(safe) }));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") out.config = argv[++i];
    else if (arg === "--state") out.state = argv[++i];
    else if (arg === "--env-file") out.envFile = argv[++i];
  }
  return out;
}

async function loadEnvFile(file) {
  if (!file || !existsSync(file)) return;
  const text = await readFile(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function loadConfig(configPath) {
  const fileConfig = await readJson(configPath, {});
  const config = {
    server: { host: "127.0.0.1", port: 8088, ...(fileConfig.server || {}) },
    codex: {
      url: process.env.CODEX_REMOTE_URL || "ws://127.0.0.1:17374",
      defaultCwd: process.env.CODEX_DEFAULT_CWD || process.cwd(),
      defaultModel: process.env.CODEX_MODEL || null,
      ...(fileConfig.codex || {}),
    },
    telegram: {
      botTokenEnv: "TELEGRAM_BOT_TOKEN",
      pollIntervalMs: 1200,
      ...(fileConfig.telegram || {}),
    },
    security: {
      adminTokenEnv: "BRIDGE_ADMIN_TOKEN",
      allowedChatIds: [],
      ...(fileConfig.security || {}),
    },
    channels: { ...(fileConfig.channels || {}) },
  };
  config.server.host = process.env.BRIDGE_HOST || config.server.host;
  config.server.port = Number(process.env.BRIDGE_PORT || config.server.port);
  config.codex.url = process.env.CODEX_REMOTE_URL || config.codex.url;
  if (process.env.TELEGRAM_CHAT_ID) {
    if (!config.channels.default?.chatId) {
      config.channels.default = { transport: "telegram", chatId: process.env.TELEGRAM_CHAT_ID };
    }
    if (!config.channels.automation?.chatId) {
      config.channels.automation = { transport: "telegram", chatId: process.env.TELEGRAM_CHAT_ID };
    }
  }
  return config;
}

class Store {
  constructor(file) {
    this.file = file;
    this.state = { bindings: {}, channels: {}, telegram: { offset: 0 } };
  }

  async load() {
    this.state = await readJson(this.file, this.state);
  }

  async save() {
    await writeJson(this.file, this.state);
  }

  key(transport, chatId) {
    return `${transport}:${chatId}`;
  }

  getBinding(transport, chatId) {
    return this.state.bindings[this.key(transport, chatId)] || null;
  }

  async setBinding(binding) {
    const now = new Date().toISOString();
    const key = this.key(binding.transport, binding.chatId);
    this.state.bindings[key] = {
      createdAt: this.state.bindings[key]?.createdAt || now,
      updatedAt: now,
      ...binding,
    };
    await this.save();
    return this.state.bindings[key];
  }

  async setTelegramOffset(offset) {
    this.state.telegram.offset = offset;
    await this.save();
  }
}

class Telegram {
  constructor(token) {
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
    this.token = token;
    this.base = `https://api.telegram.org/bot${token}`;
  }

  async call(method, payload = {}) {
    const response = await fetch(`${this.base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description || response.status}`);
    return data.result;
  }

  async getUpdates(offset, timeout = 25) {
    return this.call("getUpdates", {
      offset,
      timeout,
      allowed_updates: ["message"],
    });
  }

  async sendMessage(chatId, text, options = {}) {
    const chunks = splitTelegram(text);
    let last;
    for (const chunk of chunks) {
      last = await this.call("sendMessage", {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
        ...options,
      });
    }
    return last;
  }

  async sendChatAction(chatId, action = "typing") {
    try {
      await this.call("sendChatAction", { chat_id: chatId, action });
    } catch {
      // Non-critical.
    }
  }
}

function splitTelegram(text) {
  const max = 3900;
  if (!text) return ["(empty response)"];
  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  chunks.push(rest);
  return chunks;
}

class CodexClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.loadedThreads = new Set();
    this.threadStatuses = new Map();
    this.statusWaiters = new Map();
  }

  async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener("message", (event) => this.onMessage(event));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${this.url}`)), 10_000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`Could not connect to ${this.url}`));
      }, { once: true });
    });
    await this.request("initialize", {
      clientInfo: { name: "codex-chat-bridge", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
  }

  onMessage(event) {
    const msg = JSON.parse(event.data);
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }

    const params = msg.params || {};
    const turnId = params.turnId || params.turn?.id;
    const key = params.threadId && turnId ? `${params.threadId}:${turnId}` : null;
    if (msg.method === "thread/status/changed" && params.threadId) {
      this.threadStatuses.set(params.threadId, params.status);
      this.resolveStatusWaiters(params.threadId);
    }

    if (!key || !this.turns.has(key)) return;
    const turn = this.turns.get(key);

    if (msg.method === "item/agentMessage/delta") {
      turn.text += params.delta || "";
    } else if (msg.method === "item/completed" && params.item?.type === "agentMessage") {
      if (params.item.phase === "final" || !turn.finalText) {
        turn.finalText = params.item.text || "";
      }
    } else if (msg.method === "error") {
      turn.errors.push(params.error?.message || JSON.stringify(params));
    } else if (msg.method === "turn/completed") {
      clearTimeout(turn.timer);
      this.turns.delete(key);
      turn.resolve({
        text: (turn.finalText || turn.text).trim(),
        errors: turn.errors,
        threadId: params.threadId,
        turnId,
      });
    }
  }

  request(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  async listThreads(limit = 20) {
    await this.connect();
    return this.request("thread/list", { limit, sourceKinds: [] });
  }

  async startThread({ cwd, model }) {
    await this.connect();
    const result = await this.request("thread/start", {
      cwd,
      model: model || null,
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
      sessionStartSource: "startup",
    });
    this.loadedThreads.add(result.thread.id);
    return result.thread;
  }

  async resumeThread(threadId, { cwd, model } = {}) {
    await this.connect();
    if (this.loadedThreads.has(threadId)) return;
    await this.request("thread/resume", {
      threadId,
      cwd: cwd || null,
      model: model || null,
      persistExtendedHistory: true,
    });
    this.loadedThreads.add(threadId);
  }

  async readThread(threadId, includeTurns = false) {
    await this.connect();
    const result = await this.request("thread/read", { threadId, includeTurns });
    if (result.thread?.status) this.threadStatuses.set(threadId, result.thread.status);
    return result.thread;
  }

  async waitForIdle(threadId, timeoutMs = 30 * 60 * 1000) {
    const startedAt = Date.now();
    while (true) {
      const thread = await this.readThread(threadId, false);
      if (thread.status?.type !== "active") return thread;
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        const flags = thread.status.activeFlags?.length ? ` (${thread.status.activeFlags.join(", ")})` : "";
        throw new Error(`Codex session stayed busy${flags} for ${Math.round(timeoutMs / 1000)}s.`);
      }
      await this.waitForStatusChangeOrDelay(threadId, remaining);
    }
  }

  waitForStatusChangeOrDelay(threadId, remainingMs) {
    return new Promise((resolve) => {
      const waiters = this.statusWaiters.get(threadId) || new Set();
      const waiter = () => {
        clearTimeout(timeout);
        waiters.delete(waiter);
        if (!waiters.size) this.statusWaiters.delete(threadId);
        resolve();
      };
      const timeout = setTimeout(waiter, Math.min(remainingMs, 10_000));
      waiters.add(waiter);
      this.statusWaiters.set(threadId, waiters);
    });
  }

  resolveStatusWaiters(threadId) {
    const waiters = this.statusWaiters.get(threadId);
    if (!waiters) return;
    this.statusWaiters.delete(threadId);
    for (const waiter of waiters) waiter();
  }

  async sendTurn({ threadId, text, cwd, model, timeoutMs = 30 * 60 * 1000 }) {
    await this.waitForIdle(threadId, timeoutMs);
    await this.resumeThread(threadId, { cwd, model });
    const started = await this.request("turn/start", {
      threadId,
      model: model || null,
      cwd: cwd || null,
      input: [{ type: "text", text, text_elements: [] }],
    });
    const turnId = started.turn.id;
    const key = `${threadId}:${turnId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turns.delete(key);
        reject(new Error(`Codex turn timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.turns.set(key, { text: "", finalText: "", errors: [], resolve, reject, timer });
    });
  }
}

class ChatQueue {
  constructor() {
    this.queues = new Map();
  }

  enqueue(key, task) {
    const previous = this.queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.queues.set(key, next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }));
    return next;
  }
}

function requireAdmin(req, config) {
  const envName = config.security.adminTokenEnv || "BRIDGE_ADMIN_TOKEN";
  const token = process.env[envName];
  if (!token) return true;
  const header = req.headers.authorization || "";
  return header === `Bearer ${token}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value, null, 2));
}

function renderSetup(config, store) {
  const bindings = Object.values(store.state.bindings);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>codex-chat-bridge</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 32px; max-width: 880px; line-height: 1.5; }
    code, input { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    input { width: 100%; padding: 8px; box-sizing: border-box; }
    label { display: block; margin-top: 14px; font-weight: 600; }
    button { margin-top: 16px; padding: 8px 12px; }
    pre { background: #f6f6f6; padding: 12px; overflow: auto; }
  </style>
</head>
<body>
  <h1>codex-chat-bridge</h1>
  <p>Codex remote: <code>${config.codex.url}</code></p>
  <p>Default cwd: <code>${config.codex.defaultCwd}</code></p>
  <h2>Bindings</h2>
  <pre>${escapeHtml(JSON.stringify(bindings, null, 2))}</pre>
  <h2>Bind Chat</h2>
  <form method="post" action="/setup/bind">
    <label>Admin token</label><input name="adminToken" type="password" />
    <label>Telegram chat id</label><input name="chatId" />
    <label>Codex thread id</label><input name="threadId" />
    <label>Name</label><input name="name" value="main" />
    <button type="submit">Bind</button>
  </form>
</body>
</html>`;
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

async function handleSetupBind(req, res, config, store) {
  const form = new URLSearchParams(Buffer.concat(await collect(req)).toString("utf8"));
  if (process.env[config.security.adminTokenEnv] && form.get("adminToken") !== process.env[config.security.adminTokenEnv]) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  await store.setBinding({
    transport: "telegram",
    chatId: form.get("chatId"),
    threadId: form.get("threadId"),
    name: form.get("name") || "main",
    cwd: config.codex.defaultCwd,
    model: config.codex.defaultModel,
  });
  res.writeHead(303, { location: "/" });
  res.end();
}

async function collect(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks;
}

function chatAllowed(config, store, chatId) {
  const explicit = config.security.allowedChatIds || [];
  if (explicit.map(String).includes(String(chatId))) return true;
  return Boolean(store.getBinding("telegram", String(chatId)));
}

async function handleTelegramMessage({ telegram, codex, store, config, queue, message }) {
  const chatId = String(message.chat.id);
  const chatKey = `telegram:${chatId}`;
  const text = (message.text || "").trim();
  if (!text) return;

  if (text === "/start" || text === "/help") {
    const binding = store.getBinding("telegram", chatId);
    await telegram.sendMessage(chatId, [
      "codex-chat-bridge is online.",
      binding ? `Bound thread: ${binding.threadId}` : "This chat is not bound yet.",
      "",
      "Commands:",
      "/status - show binding",
      "/new - create a new Codex thread",
      "If the bound Codex thread is busy, messages from this chat are queued in order.",
      "Any other message is sent to the bound Codex thread.",
    ].join("\n"));
    return;
  }

  if (text === "/status") {
    const binding = store.getBinding("telegram", chatId);
    await telegram.sendMessage(chatId, binding ? JSON.stringify(binding, null, 2) : "No binding for this chat.");
    return;
  }

  if (!chatAllowed(config, store, chatId)) {
    await telegram.sendMessage(chatId, "This chat is not authorized. Bind it from the setup page or admin API first.");
    return;
  }

  let binding = store.getBinding("telegram", chatId);
  if (text === "/new") {
    await telegram.sendChatAction(chatId);
    const thread = await codex.startThread({ cwd: config.codex.defaultCwd, model: config.codex.defaultModel });
    binding = await store.setBinding({
      transport: "telegram",
      chatId,
      threadId: thread.id,
      name: thread.name || "telegram",
      cwd: config.codex.defaultCwd,
      model: config.codex.defaultModel,
    });
    await telegram.sendMessage(chatId, `Created and bound new Codex thread:\n${binding.threadId}`);
    return;
  }

  if (!binding) {
    await telegram.sendMessage(chatId, "No Codex thread is bound to this chat. Send /new or bind a thread from setup.");
    return;
  }

  const ack = telegram.sendMessage(chatId, "收到，已加入队列转给 Codex。");
  telegram.sendChatAction(chatId).catch(() => {});
  queue.enqueue(chatKey, async () => {
    try {
      await ack;
      await telegram.sendChatAction(chatId);
      const result = await codex.sendTurn({
        threadId: binding.threadId,
        text,
        cwd: binding.cwd || config.codex.defaultCwd,
        model: binding.model || config.codex.defaultModel,
      });
      const prefix = result.errors?.length ? `Codex reported errors:\n${result.errors.join("\n")}\n\n` : "";
      await telegram.sendMessage(chatId, `${prefix}${result.text || "(Codex completed without final text.)"}`);
    } catch (error) {
      log("error", "codex turn failed", { chatId, error: error.message });
      await telegram.sendMessage(chatId, `Codex 执行失败：${error.message}`);
    }
  }).catch((error) => {
    log("error", "queued telegram message failed", { chatId, error: error.message });
  });
}

async function startTelegramPolling(context) {
  const { telegram, store, config } = context;
  let offset = Number(store.state.telegram?.offset || 0);
  log("info", "telegram polling started", { offset });
  while (true) {
    try {
      const updates = await telegram.getUpdates(offset || undefined);
      for (const update of updates) {
        offset = update.update_id + 1;
        await store.setTelegramOffset(offset);
        if (update.message) {
          handleTelegramMessage({ ...context, message: update.message }).catch((error) => {
            log("error", "telegram message handler failed", { error: error.message });
          });
        }
      }
    } catch (error) {
      log("error", "telegram polling failed", { error: error.message });
      await sleep(config.telegram.pollIntervalMs || 1200);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createServer(context) {
  const { config, store, telegram, codex } = context;
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, 200, { ok: true });
      } else if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderSetup(config, store));
      } else if (req.method === "POST" && url.pathname === "/setup/bind") {
        await handleSetupBind(req, res, config, store);
      } else if (req.method === "POST" && url.pathname === "/api/bind") {
        if (!requireAdmin(req, config)) return sendJson(res, 403, { error: "forbidden" });
        const body = await readBody(req);
        const binding = await store.setBinding({
          transport: body.transport || "telegram",
          chatId: String(body.chatId),
          threadId: String(body.threadId),
          name: body.name || "main",
          cwd: body.cwd || config.codex.defaultCwd,
          model: body.model || config.codex.defaultModel,
        });
        sendJson(res, 200, { ok: true, binding });
      } else if (req.method === "POST" && url.pathname === "/api/notify") {
        if (!requireAdmin(req, config)) return sendJson(res, 403, { error: "forbidden" });
        const body = await readBody(req);
        const channel = body.channel || "default";
        const target = config.channels[channel] || store.state.channels[channel];
        if (!target?.chatId) return sendJson(res, 404, { error: `unknown channel: ${channel}` });
        const text = body.text || [body.title, body.summary, Array.isArray(body.details) ? body.details.join("\n") : body.details].filter(Boolean).join("\n\n");
        await telegram.sendMessage(target.chatId, text || "(empty notification)");
        sendJson(res, 200, { ok: true });
      } else if (req.method === "GET" && url.pathname === "/api/threads") {
        if (!requireAdmin(req, config)) return sendJson(res, 403, { error: "forbidden" });
        sendJson(res, 200, await codex.listThreads(20));
      } else {
        sendJson(res, 404, { error: "not found" });
      }
    } catch (error) {
      log("error", "http request failed", { error: error.message });
      sendJson(res, 500, { error: error.message });
    }
  });
}

async function main() {
  const args = parseArgs(process.argv);
  await loadEnvFile(args.envFile || process.env.BRIDGE_ENV_FILE);
  const configPath = args.config || process.env.BRIDGE_CONFIG || DEFAULT_CONFIG_PATH;
  const statePath = args.state || process.env.BRIDGE_STATE || DEFAULT_STATE_PATH;
  const config = await loadConfig(configPath);
  const token = process.env[config.telegram.botTokenEnv] || process.env.TELEGRAM_BOT_TOKEN;
  const telegram = new Telegram(token);
  const codex = new CodexClient(config.codex.url);
  const store = new Store(statePath);
  const queue = new ChatQueue();
  await store.load();

  const context = { config, telegram, codex, store, queue };
  const server = await createServer(context);
  server.listen(config.server.port, config.server.host, () => {
    log("info", "bridge listening", { host: config.server.host, port: config.server.port, codexUrl: config.codex.url });
  });

  startTelegramPolling(context).catch((error) => {
    log("error", "telegram polling stopped", { error: error.message });
    process.exitCode = 1;
  });
}

main().catch((error) => {
  log("error", "startup failed", { error: error.message });
  process.exit(1);
});
