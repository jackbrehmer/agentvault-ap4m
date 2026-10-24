// AgentVault x AP4M demo: one process runs the dashboard, the x402 merchants, and the agent.
// Agent and merchant share nothing but HTTP and the chain: the merchant never sees the agent key.
require("dotenv").config({ quiet: true });
const http = require("http");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { createAgent } = require("./lib/agent");
const { createMerchants } = require("./lib/merchant");

const PORT = Number(process.env.PORT || 3001);
const BASE = `http://localhost:${PORT}`;
const cfg = {
  agentKey: process.env.AGENT_PRIVATE_KEY,
  team: process.env.TEAM_NAME || "JackBrehmer",
  apiUrl: (process.env.AP4M_API_URL || "https://hackathon.ap4m.build").replace(/\/$/, ""),
  ledger: process.env.PAYMENT_LEDGER || "",
  rpcUrl: process.env.AP4M_RPC_URL || "",
  channelCap: process.env.CHANNEL_CAP || "2",
  payout: process.env.MERCHANT_PAYOUT || "",
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  model: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
  merchantBase: BASE,
};
if (!cfg.agentKey || !/^0x?[0-9a-fA-F]{64}$/.test(cfg.agentKey.trim())) {
  console.error("Set AGENT_PRIVATE_KEY in .env (your registered agent wallet's private key).");
  process.exit(1);
}
cfg.agentKey = cfg.agentKey.trim().startsWith("0x") ? cfg.agentKey.trim() : "0x" + cfg.agentKey.trim();

// ---------- live event stream ----------
const events = [];
const clients = new Set();
function emit(type, data = {}) {
  const ev = { id: events.length + 1, t: Date.now(), type, ...data };
  events.push(ev);
  if (events.length > 500) events.shift();
  for (const c of clients) c.write(`data: ${JSON.stringify(ev)}\n\n`);
  const line = data.text || data.reason || data.item || "";
  console.log(`[${type}] ${line}`);
}

const agent = createAgent(cfg, emit);
let merchants;

async function boot() {
  const S = await agent.init();
  merchants = createMerchants({
    provider: S.provider, ledger: S.ledger, chainId: S.chainId, rlusd: S.rlusd,
    getPayout: async () => cfg.payout || S.payout || (await agent.status()).payout,
    emit,
  });
  console.log(`Agent ${S.wallet.address} | ledger ${S.ledger}`);
  console.log(`Brain: ${cfg.anthropicKey ? cfg.model : "offline plan (add ANTHROPIC_API_KEY to .env for Claude)"}`);
}

const json = (res, code, obj) => res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(obj));
async function body(req) { let b = ""; for await (const c of req) b += c; try { return JSON.parse(b || "{}"); } catch { return {}; } }

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  try {
    if (merchants && (await merchants.handle(req, res, url, BASE))) return;

    if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname === "/api/status") return json(res, 200, { ...(await agent.status()), surge: merchants?.state.surge, brain: cfg.anthropicKey ? cfg.model : "offline plan" });
    if (url.pathname === "/api/run" && req.method === "POST") {
      const b = await body(req);
      agent.run({ goal: String(b.goal || "Launch Bloom & Co's online flower shop"), budget: String(b.budget || "1"), perPurchase: String(b.perPurchase || "0.5") });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/burst" && req.method === "POST") {
      const b = await body(req);
      agent.burst({ count: Math.max(1, Math.min(100, Number(b.count) || 25)), budget: String(b.budget || "1"), perPurchase: String(b.perPurchase || "0.5") });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/kill" && req.method === "POST") { agent.kill().catch((e) => emit("error", { text: "kill: " + e.message })); return json(res, 200, { ok: true }); }
    if (url.pathname === "/api/overcap" && req.method === "POST") { agent.overcapTest().catch((e) => emit("error", { text: "over-cap test: " + e.message })); return json(res, 200, { ok: true }); }
    if (url.pathname === "/api/attack" && req.method === "POST") {
      merchants.state.surge = !!(await body(req)).on;
      emit("attack", { on: merchants.state.surge, text: merchants.state.surge ? "Merchant attack ON: LaunchKit will quote 3x on hosting at checkout" : "Merchant attack OFF" });
      return json(res, 200, { surge: merchants.state.surge });
    }
    if (url.pathname === "/api/reset" && req.method === "POST") { events.length = 0; return json(res, 200, { ok: true }); }

    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = path.join(__dirname, "web", path.normalize(p));
    if (!file.startsWith(path.join(__dirname, "web"))) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end("not found");
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" }).end(data);
    });
  } catch (e) {
    json(res, 500, { error: e.shortMessage || e.message });
  }
}).listen(PORT, async () => {
  try { await boot(); } catch (e) { console.error("Startup failed:", e.message); process.exit(1); }
  console.log(`\nDashboard: ${BASE}\n`);
});
