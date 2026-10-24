// x402 merchants (payee side). The merchant never sees the agent's key or session.
// It answers 402 with payment requirements, verifies the agent's EIP-712 voucher
// against the PaymentLedger on-chain, and releases the resource immediately.
const crypto = require("crypto");
const { ethers } = require("ethers");
const { VOUCHER_TYPES, voucherDomain, readChannel, b64, unb64 } = require("./chain");

const rl = (x) => ethers.parseUnits(String(x), 18);

function createMerchants({ provider, ledger, chainId, rlusd, getPayout, emit }) {
  const state = {
    surge: false,                 // attack toggle: merchant quotes 3x on hosting at checkout
    accepted: new Map(),          // channelId -> last accepted cumulative amount
    statusAtOpen: new Map(),      // channelId -> ledger status when first seen
    sites: new Map(),             // slot -> storefront content
    deployTokens: new Map(),      // token -> slot
  };

  // LaunchKit is our team's registered merchant (its payout is bound to the channel).
  // QuickStock is NOT registered: it asks to be paid at an address no channel is bound to.
  const quickstockPayout = ethers.Wallet.createRandom().address;
  const catalogs = {
    launchkit: {
      name: "LaunchKit",
      verified: true,
      items: [
        { id: "domain", name: "bloomandco.shop domain (1 year)", price: "0.2", kind: "domain" },
        { id: "hosting-starter", name: "Starter hosting + SSL (1 month)", price: "0.3", kind: "hosting" },
        { id: "hosting-premium", name: "Premium hosting with global CDN (1 month)", price: "1.2", kind: "hosting" },
        { id: "images", name: "Flower photo pack (3 images)", price: "0.2", kind: "images" },
      ],
    },
    quickstock: {
      name: "QuickStock",
      verified: false,
      items: [{ id: "images-cheap", name: "Budget flower photos (3 images)", price: "0.05", kind: "images" }],
    },
  };

  function quote(mid, item) {
    let price = item.price;
    if (state.surge && mid === "launchkit" && item.kind === "hosting") price = (Number(item.price) * 3).toFixed(2);
    return price;
  }

  async function requirements(mid, item, base) {
    const payTo = mid === "launchkit" ? await getPayout() : quickstockPayout;
    return {
      x402Version: 1,
      error: "payment required",
      accepts: [{
        scheme: "ap4m-voucher",
        network: "xrpl-evm-testnet",
        chainId: Number(chainId),
        ledger,
        asset: "RLUSD",
        assetAddress: rlusd,
        payTo,
        merchant: catalogs[mid].name,
        resource: `${base}/m/${mid}/buy/${item.id}`,
        description: item.name,
        maxAmountRequired: rl(quote(mid, item)).toString(),
      }],
    };
  }

  async function verifyPayment(mid, item, header) {
    let p;
    try { p = unb64(header); } catch { return "malformed PAYMENT-SIGNATURE"; }
    const cumulative = BigInt(p.cumulativeAmount);
    const signer = ethers.verifyTypedData(voucherDomain(chainId, ledger), VOUCHER_TYPES, { channelId: p.channelId, cumulativeAmount: cumulative }, p.signature);
    const ch = await readChannel(provider, ledger, p.channelId);
    const payTo = mid === "launchkit" ? await getPayout() : quickstockPayout;
    if (ch.cap === 0n) return "unknown channel";
    if (signer.toLowerCase() !== ch.agent.toLowerCase()) return "voucher not signed by the channel's agent";
    if (ch.payout.toLowerCase() !== payTo.toLowerCase()) return "channel is not bound to this merchant";
    if (!state.statusAtOpen.has(p.channelId)) state.statusAtOpen.set(p.channelId, ch.status);
    if (ch.status !== state.statusAtOpen.get(p.channelId)) return "channel is closed";
    if (ch.validBefore > 0n && ch.validBefore < BigInt(Math.floor(Date.now() / 1000))) return "channel expired";
    if (cumulative > ch.cap) return "voucher exceeds channel cap";
    const last = state.accepted.get(p.channelId) ?? ch.redeemed;
    if (cumulative - last !== rl(quote(mid, item))) return "voucher amount does not match the price";
    state.accepted.set(p.channelId, cumulative);
    return { ok: true, channelId: p.channelId, cumulative, digest: ethers.TypedDataEncoder.hash(voucherDomain(chainId, ledger), VOUCHER_TYPES, { channelId: p.channelId, cumulativeAmount: cumulative }) };
  }

  function deliver(mid, item, base) {
    if (item.kind === "domain") return { domain: "bloomandco.shop", status: "registered", expires: new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10) };
    if (item.kind === "hosting") {
      const token = crypto.randomBytes(12).toString("hex");
      state.deployTokens.set(token, "bloomandco");
      return { plan: item.name, site: "bloomandco", deploy_url: `${base}/m/launchkit/deploy/${token}`, live_url: `${base}/sites/bloomandco/` };
    }
    if (item.kind === "images") {
      const seeds = [1, 2, 3].map(() => crypto.randomBytes(3).toString("hex"));
      return { images: seeds.map((s) => `${base}/m/${mid}/img/${s}.svg`), license: "commercial" };
    }
  }

  // procedural flower art, so "images" are a real deliverable
  function flowerSvg(seed) {
    const h = parseInt(seed, 16) || 1;
    const hue = h % 360, petals = 5 + (h % 4), bg = (hue + 160) % 360;
    let p = "";
    for (let i = 0; i < petals; i++) p += `<ellipse cx="200" cy="120" rx="38" ry="80" fill="hsl(${hue},75%,${60 + (i % 2) * 8}%)" transform="rotate(${(360 / petals) * i} 200 200)" opacity=".92"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="hsl(${bg},40%,92%)"/><path d="M200 230 C 195 300, 205 330, 200 400" stroke="hsl(120,35%,35%)" stroke-width="10" fill="none"/>${p}<circle cx="200" cy="200" r="30" fill="hsl(${(hue + 40) % 360},85%,50%)"/></svg>`;
  }

  function storefront(site) {
    const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const imgs = site.images || [];
    const products = (site.products || []).map((p, i) => `<div class="p">${imgs[i % (imgs.length || 1)] ? `<img src="${esc(imgs[i % imgs.length])}"/>` : ""}<h3>${esc(p.name)}</h3><p>${esc(p.description)}</p><b>${esc(p.price)}</b></div>`).join("");
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(site.name)}</title>
<style>body{margin:0;font-family:Georgia,serif;background:#fbf7f2;color:#2b2620}header{padding:48px 24px;text-align:center;background:#f3e7dc}h1{margin:0;font-size:42px}.t{color:#7b6a5b;margin-top:8px}.about{max-width:640px;margin:32px auto;padding:0 24px;line-height:1.6}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px;max-width:900px;margin:0 auto 48px;padding:0 24px}.p{background:#fff;border-radius:12px;padding:14px;box-shadow:0 1px 3px rgba(0,0,0,.08)}.p img{width:100%;border-radius:8px}.p h3{margin:10px 0 4px}.p p{color:#6b5d50;font-size:14px}footer{text-align:center;color:#9a8b7c;font:12px system-ui;padding:24px}</style></head>
<body><header><h1>${esc(site.name)}</h1><div class="t">${esc(site.tagline)}</div></header><div class="about">${esc(site.about)}</div><div class="grid">${products}</div>
<footer>${esc(site.domain || "")} · launched autonomously by an AI agent · paid via Mastercard AP4M on XRPL EVM in RLUSD</footer></body></html>`;
  }

  async function handle(req, res, url, base) {
    const parts = url.pathname.split("/").filter(Boolean); // m, mid, action, arg
    if (parts[0] === "sites") {
      const site = state.sites.get(parts[1]);
      if (!site) return res.writeHead(404, { "content-type": "text/html" }).end("<h2 style='font-family:system-ui'>Not deployed yet</h2>"), true;
      return res.writeHead(200, { "content-type": "text/html" }).end(storefront(site)), true;
    }
    if (parts[0] !== "m") return false;
    const mid = parts[1], cat = catalogs[mid];
    if (!cat) return res.writeHead(404).end(), true;

    if (parts[2] === "catalog") {
      const items = cat.items.map((i) => ({ ...i, merchant: cat.name, merchant_id: mid, url: `${base}/m/${mid}/buy/${i.id}` }));
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ merchant: cat.name, items })), true;
    }
    if (parts[2] === "img") {
      return res.writeHead(200, { "content-type": "image/svg+xml" }).end(flowerSvg(parts[3].replace(".svg", ""))), true;
    }
    if (parts[2] === "deploy" && req.method === "POST") {
      const slot = state.deployTokens.get(parts[3]);
      if (!slot) return res.writeHead(403).end(), true;
      let body = ""; for await (const c of req) body += c;
      state.sites.set(slot, JSON.parse(body || "{}"));
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, live_url: `${base}/sites/${slot}/` })), true;
    }
    if (parts[2] === "buy") {
      const item = cat.items.find((i) => i.id === parts[3]);
      if (!item) return res.writeHead(404).end(), true;
      const sig = req.headers["payment-signature"];
      if (!sig) {
        const reqs = await requirements(mid, item, base);
        return res.writeHead(402, { "content-type": "application/json", "PAYMENT-REQUIRED": b64(reqs) }).end(JSON.stringify(reqs)), true;
      }
      const v = await verifyPayment(mid, item, sig);
      if (v?.ok !== true) {
        const reqs = await requirements(mid, item, base);
        return res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify({ ...reqs, error: v })), true;
      }
      const resource = deliver(mid, item, base);
      const receipt = { success: true, channelId: v.channelId, cumulativeAmount: v.cumulative.toString(), amount: rl(quote(mid, item)).toString(), voucherDigest: v.digest, merchant: cat.name };
      return res.writeHead(200, { "content-type": "application/json", "PAYMENT-RESPONSE": b64(receipt) }).end(JSON.stringify(resource)), true;
    }
    return res.writeHead(404).end(), true;
  }

  return { handle, state, catalogs };
}

module.exports = { createMerchants };
