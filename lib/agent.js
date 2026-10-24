// The buy side: a Claude-driven agent that pays x402 merchants through an AP4M channel.
// Guardrails run before every signature; the PaymentLedger enforces the channel cap on-chain.
const { ethers } = require("ethers");
const sdk = require("./ap4m-sdk");
const { LEDGER_ABI, VOUCHER_TYPES, voucherDomain, readChannel, rlusdBalance, unb64, fmt } = require("./chain");

const rl = (x) => ethers.parseUnits(String(x), 18);

function createAgent(cfg, emit) {
  const S = {
    token: null, config: null, provider: null, wallet: null,
    channelId: null, cap: 0n, payout: null,
    signed: 0n,          // cumulative amount of vouchers the agent has signed
    redeemed: 0n,        // confirmed on-chain
    settled: 0n,         // paid out to the merchant
    receipts: [],
    running: false, killed: false,
    queue: Promise.resolve(), pendingRedeem: null,
    startBalance: null,
  };

  async function init() {
    const r = await fetch(`${cfg.apiUrl}/public/config`);
    S.config = await r.json();
    if (!r.ok) throw new Error("could not read AP4M config");
    S.ledger = cfg.ledger || S.config.contracts.paymentLedger;
    S.rlusd = S.config.contracts.rlusdToken;
    S.rpcUrl = cfg.rpcUrl || S.config.network.rpcUrl;
    S.explorer = S.config.network.explorerUrl;
    S.chainId = S.config.network.chainId;
    S.provider = new ethers.JsonRpcProvider(S.rpcUrl, S.chainId, { staticNetwork: true });
    S.wallet = new ethers.Wallet(cfg.agentKey, S.provider);
    return S;
  }

  async function session() {
    if (S.token) return S.token;
    emit("info", { text: `Signing in as team ${cfg.team} with the registered agent wallet ${short(S.wallet.address)}` });
    const s = await sdk.signIn(cfg.apiUrl, cfg.team, S.wallet);
    S.token = s.token;
    emit("kya", { agent: S.wallet.address, team: cfg.team, registry: S.config.contracts.participantRegistry });
    return S.token;
  }

  // Reuse an open channel that has room, else open a new one (one vault tx from the agent wallet).
  async function ensureChannel(need) {
    await session();
    const chans = await sdk.listChannels(cfg.apiUrl, S.token);
    for (const c of chans.filter((c) => c.channel_status === "open")) {
      const st = await readChannel(S.provider, S.ledger, c.channel_id);
      if (st.cap - st.redeemed >= need) { adopt(c.channel_id, st); emit("channel", { reused: true, ...channelView() }); return; }
    }
    const capRlusd = Math.max(Number(cfg.channelCap), Number(fmt(need)));
    emit("info", { text: `Opening a funded channel with a ${capRlusd} RLUSD hard cap...` });
    const c = await sdk.requestChannel(cfg.apiUrl, S.token, S.wallet, { capRlusd });
    adopt(c.channel_id, await readChannel(S.provider, S.ledger, c.channel_id));
    emit("channel", { reused: false, ...channelView() });
  }
  function adopt(id, st) {
    if (S.channelId !== id) { S.channelId = id; S.signed = st.redeemed; S.settled = st.redeemed; }
    S.cap = st.cap; S.redeemed = st.redeemed; S.payout = st.payout;
  }
  const channelView = () => ({ channelId: S.channelId, cap: fmt(S.cap), signed: fmt(S.signed), redeemed: fmt(S.redeemed), settled: fmt(S.settled), payout: S.payout });

  // ---------- planning ----------
  async function plan(goal, budget, catalog) {
    const list = catalog.map((i) => `- ${i.merchant_id}/${i.id}: ${i.name} — ${i.price} RLUSD (merchant ${i.merchant})`).join("\n");
    const sys = `You are a purchasing agent with a spending budget. Pick which catalog items to buy to achieve the goal, within budget. Then write the storefront content.
Reply with JSON only:
{"purchases":[{"item":"merchant_id/item_id","why":"<=100 chars"}],
 "store":{"name":"...","tagline":"<=60 chars","about":"2 sentences","products":[{"name":"...","price":"$..","description":"<=80 chars"}]}}
Give 3 products. Order purchases in the order you'd buy them.`;
    const user = `GOAL: ${goal}\nBUDGET: ${budget} RLUSD total\nCATALOG:\n${list}`;
    if (!cfg.anthropicKey) return fallbackPlan(catalog, "no ANTHROPIC_API_KEY set");
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": cfg.anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: cfg.model, max_tokens: 900, system: sys, messages: [{ role: "user", content: user }] }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || r.status);
      const text = j.content.map((c) => c.text || "").join("");
      const p = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
      p.brain = cfg.model;
      return p;
    } catch (e) {
      return fallbackPlan(catalog, e.message);
    }
  }
  function fallbackPlan(catalog, why) {
    return {
      brain: `offline plan (${why})`,
      purchases: [
        { item: "launchkit/domain", why: "Every store needs its own domain" },
        { item: "launchkit/hosting-starter", why: "Starter hosting is enough for launch traffic" },
        { item: "launchkit/images", why: "Product photos sell flowers" },
      ],
      store: {
        name: "Bloom & Co.", tagline: "Fresh stems, delivered across Manhattan",
        about: "Bloom & Co. arranges seasonal flowers by hand every morning. Order by noon for same-day delivery.",
        products: [
          { name: "Morning Market Bouquet", price: "$48", description: "Seasonal stems picked at dawn" },
          { name: "Peony Cloud", price: "$65", description: "Blush peonies with eucalyptus" },
          { name: "Desk Bud Vase", price: "$22", description: "A single statement bloom" },
        ],
      },
    };
  }

  // ---------- one x402 purchase ----------
  async function buy(item, why, limits) {
    const step = { item: item.name, merchant: item.merchant, why, url: item.url };
    emit("request", step);
    const r1 = await fetch(item.url);
    if (r1.status !== 402) { emit("error", { ...step, text: `expected 402, got ${r1.status}` }); return null; }
    const reqs = (await r1.json()).accepts[0];
    const price = BigInt(reqs.maxAmountRequired);
    emit("402", { ...step, price: fmt(price), payTo: reqs.payTo, scheme: reqs.scheme });

    // guardrails: all must pass before the agent signs anything
    const checks = [
      ["Merchant verified: payee is the payout bound to this AP4M channel", reqs.payTo.toLowerCase() === String(S.payout).toLowerCase(), `${item.merchant} is not a verified merchant on this channel (asked to be paid at ${short(reqs.payTo)})`],
      ["Correct ledger and chain", reqs.ledger.toLowerCase() === S.ledger.toLowerCase() && Number(reqs.chainId) === Number(S.chainId), "402 points at a different ledger or chain"],
      [`Price matches catalog quote (${item.price} RLUSD)`, price <= rl(item.price), `Merchant raised the price at checkout: quoted ${item.price}, asked ${fmt(price)} RLUSD`],
      [`Under per-purchase cap (${limits.perPurchase} RLUSD)`, price <= rl(limits.perPurchase), `${fmt(price)} RLUSD is over the ${limits.perPurchase} RLUSD per-purchase cap`],
      [`Within mandate budget (${fmt(limits.spent + price)} / ${limits.budget} RLUSD)`, limits.spent + price <= rl(limits.budget), `Would exceed the ${limits.budget} RLUSD budget`],
      [`Within channel cap (${fmt(S.signed + price)} / ${fmt(S.cap)} RLUSD)`, S.signed + price <= S.cap, "Would exceed the funded channel cap"],
    ];
    const failed = checks.find(([, ok]) => !ok);
    emit("checks", { ...step, checks: checks.map(([label, ok]) => ({ label, ok })) });
    if (failed) { emit("blocked", { ...step, price: fmt(price), reason: failed[2] }); return null; }

    // sign the voucher (EIP-712, cumulative) — key never leaves this machine
    const cumulative = S.signed + price;
    const signature = await sdk.signVoucher(S.wallet, S.ledger, S.channelId, cumulative);
    const header = Buffer.from(JSON.stringify({ channelId: S.channelId, cumulativeAmount: cumulative.toString(), signature })).toString("base64");
    emit("voucher", { ...step, cumulative: fmt(cumulative), signature: signature.slice(0, 18) + "..." });

    const r2 = await fetch(item.url, { headers: { "PAYMENT-SIGNATURE": header } });
    if (r2.status !== 200) { const e = await r2.json().catch(() => ({})); emit("error", { ...step, text: `merchant rejected voucher: ${e.error || r2.status}` }); return null; }
    S.signed = cumulative;
    const receipt = unb64(r2.headers.get("payment-response"));
    const resource = await r2.json();
    emit("paid", { ...step, price: fmt(price), resource, digest: receipt.voucherDigest, ...channelView() });
    enqueueSettlement();
    return { resource, price };
  }

  // ---------- redeem + settle off the hot path ----------
  function enqueueSettlement() {
    S.pendingRedeem = S.signed;
    S.queue = S.queue.then(async () => {
      const target = S.pendingRedeem;
      if (target == null || target <= S.redeemed) return; // already covered by a later voucher
      try {
        emit("redeeming", { cumulative: fmt(target) });
        const { txHash, claimId } = await sdk.redeemVoucher(S.wallet, S.ledger, S.rpcUrl, S.channelId, target);
        S.redeemed = target;
        emit("redeemed", { tx: txHash, claimId, ...channelView() });
        const owed = S.redeemed - S.settled;
        const balBefore = await payoutBalance().catch(() => null);

        // record-redemption: retry on gateway/HTML errors; "already recorded" counts as success
        await retry(async () => {
          const rec = await fetch(`${cfg.apiUrl}/public/participant/record-redemption`, {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${S.token}` }, body: JSON.stringify({ tx_hash: txHash }),
          });
          const text = await rec.text();
          if (!rec.ok && !/already|recorded|exists/i.test(text)) throw new Error(`record-redemption ${rec.status}`);
        });

        let st = null;
        try { st = await retry(() => sdk.settle(cfg.apiUrl, S.token, S.channelId)); } catch (e) { console.error("settle call failed, confirming on-chain instead:", e.message); }

        if (st) {
          S.settled = S.redeemed;
          const receiptUrl = st.receipt_url ? (st.receipt_url.startsWith("http") ? st.receipt_url : cfg.apiUrl + st.receipt_url) : null;
          S.receipts.unshift({ amount: st.amount_rlusd, settlement_tx: st.settlement_tx, payout_tx: st.payout_tx, receipt_url: receiptUrl, t: Date.now() });
          emit("settled", { amount: st.amount_rlusd, settlementTx: st.settlement_tx, payoutTx: st.payout_tx, receiptUrl, ...channelView() });
        } else {
          // The service also settles automatically. Confirm by watching the merchant's RLUSD balance.
          const ok = balBefore != null && (await waitFor(async () => (await payoutBalance()) >= balBefore + owed, 120000));
          if (ok) {
            S.settled = S.redeemed;
            S.receipts.unshift({ amount: fmt(owed), settlement_tx: null, payout_tx: null, receipt_url: null, t: Date.now(), auto: true });
            emit("settled", { amount: fmt(owed), auto: true, ...channelView() });
          } else {
            emit("error", { text: "settlement not confirmed yet; the AP4M service will settle it automatically (check the portal)" });
          }
        }
      } catch (e) {
        emit("error", { text: "settlement: " + (e.shortMessage || e.message) });
      }
    });
    return S.queue;
  }

  // ---------- full run ----------
  async function run({ goal, budget, perPurchase }) {
    if (S.running) throw new Error("already running");
    S.running = true; S.killed = false;
    try {
      if (!S.provider) await init();
      if (S.startBalance == null) S.startBalance = await payoutBalance().catch(() => null);
      emit("start", { goal, budget, perPurchase });
      await ensureChannel(rl(budget));

      const catalog = [];
      for (const mid of ["launchkit", "quickstock"]) {
        const c = await (await fetch(`${cfg.merchantBase}/m/${mid}/catalog`)).json();
        catalog.push(...c.items);
      }
      emit("thinking", { text: "Planning purchases..." });
      const p = await plan(goal, budget, catalog);
      emit("plan", { brain: p.brain, purchases: p.purchases });

      const limits = { budget, perPurchase, spent: 0n };
      const got = {};
      for (const step of p.purchases || []) {
        if (S.killed) { emit("info", { text: "Kill switch engaged: agent stopped." }); break; }
        const [mid, id] = String(step.item).split("/");
        const item = catalog.find((i) => i.merchant_id === mid && i.id === id);
        if (!item) { emit("info", { text: `Skipping unknown item ${step.item}` }); continue; }
        const r = await buy(item, step.why, limits);
        if (r) { limits.spent += r.price; got[item.kind] = r.resource; }
      }

      if (got.hosting && !S.killed) {
        const site = { ...p.store, domain: got.domain?.domain, images: got.images?.images || [] };
        const d = await (await fetch(got.hosting.deploy_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(site) })).json();
        emit("store", { url: d.live_url, domain: site.domain, name: site.name });
      }
      await S.queue;
      emit("done", { spent: fmt(limits.spent), ...channelView() });
    } catch (e) {
      emit("error", { text: e.shortMessage || e.message });
    } finally {
      S.running = false;
    }
  }

  // ---------- controls ----------
  async function kill() {
    S.killed = true;
    if (!S.provider) await init();
    await session();
    emit("info", { text: "Kill switch: finishing in-flight settlement, then closing the channel on-chain..." });
    await S.queue;
    if (!S.channelId) { emit("info", { text: "No channel to close." }); return; }
    const r = await sdk.closeChannel(cfg.apiUrl, S.token, S.wallet, S.channelId);
    emit("closed", { tx: r.tx_hash, channelId: S.channelId });
    S.channelId = null; S.cap = 0n; S.signed = 0n; S.redeemed = 0n; S.settled = 0n;
  }

  // Sign a voucher above the cap and ask the PaymentLedger to accept it (simulation only, no gas, no money).
  async function overcapTest() {
    if (!S.provider) await init();
    if (!S.channelId) await ensureChannel(1n); // any open channel will do; avoids opening a new one
    const st = await readChannel(S.provider, S.ledger, S.channelId);
    const bad = st.cap + rl("1");
    const sig = await sdk.signVoucher(S.wallet, S.ledger, S.channelId, bad);
    const ledger = new ethers.Contract(S.ledger, LEDGER_ABI, S.wallet);
    emit("overcap-try", { cumulative: fmt(bad), cap: fmt(st.cap) });
    try {
      await ledger.redeemVoucher.staticCall({ channelId: S.channelId, cumulativeAmount: bad }, sig);
      emit("overcap", { rejected: false, reason: "ledger did not reject (unexpected)" });
    } catch (e) {
      const raw = e.reason || e.shortMessage || e.message;
      emit("overcap", { rejected: true, reason: `Reverted on-chain: cumulative ${fmt(bad)} RLUSD is above the ${fmt(st.cap)} RLUSD cap (${raw})` });
    }
  }

  async function payoutBalance() {
    if (!S.provider) await init();
    const who = cfg.payout || S.payout;
    const b = await rlusdBalance(S.provider, S.rlusd, who);
    return b == null ? null : b;
  }

  async function status() {
    if (!S.provider) await init();
    const bal = await payoutBalance().catch(() => null);
    return {
      team: cfg.team, agent: S.wallet.address, ledger: S.ledger, registry: S.config.contracts.participantRegistry, explorer: S.explorer,
      running: S.running, payout: cfg.payout || S.payout,
      payoutBalance: bal == null ? null : fmt(bal), payoutStart: S.startBalance == null ? null : fmt(S.startBalance),
      receipts: S.receipts, ...channelView(),
    };
  }

  return { init, run, kill, overcapTest, status, state: S };
}

const short = (a) => a.slice(0, 6) + "..." + a.slice(-4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn, tries = 3, delay = 4000) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) { if (i >= tries - 1) throw e; await sleep(delay); }
  }
}
async function waitFor(check, timeout, every = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await check()) return true; } catch {} await sleep(every); }
  return false;
}
module.exports = { createAgent };
