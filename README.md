# AgentVault x Mastercard AP4M

**An AI agent that launches a business on its own, paying verified merchants over x402 through a funded AP4M channel, settling in RLUSD on XRPL EVM.**

You give the agent one mandate: *"Launch Bloom & Co's online flower shop, budget 1 RLUSD."* Claude plans what to buy, the agent pays each merchant autonomously, and a live storefront comes out the other end. Every payment is bounded by rules the human set and the chain enforces.

This is Mastercard's own AP4M use case (an agent buys a domain, hosting, and images within a set budget), built end to end on the AP4M builder stack.

## The trusted payment loop

| AP4M step | What happens in the demo |
|---|---|
| **Register (KYA)** | Agent signs in to AP4M as the team's registered agent wallet (ParticipantRegistry) |
| **Fund (ASL)** | Agent opens a funded channel with a hard RLUSD cap via `requestChannel()`, or reuses an open one with room |
| **Pay (x402 + EIP-712)** | Merchant answers `402 Payment Required`. Agent runs its guardrails, signs a cumulative EIP-712 voucher, retries with `PAYMENT-SIGNATURE`. Merchant verifies the voucher against the PaymentLedger and releases the resource immediately with `PAYMENT-RESPONSE`. No chain write on the hot path |
| **Settle (RLUSD)** | Off the hot path: `redeemVoucher()` on-chain (`VoucherRedeemed`), `record-redemption`, `settle()`. RLUSD lands in the merchant payout wallet, and a verifiable receipt is shown |

## Trust and control, layered

1. **Agent guardrails (before any signature)**
   - Merchant verified: the 402's payee must be the payout bound to this AP4M channel
   - Right ledger and chain
   - Price must match the catalog quote (no bait-and-switch at checkout)
   - Under the per-purchase cap
   - Within the human's mandate budget
   - Within the channel's funded cap
2. **Merchant verification:** recovers the EIP-712 signer, checks it is the channel's agent, that the channel is bound to this merchant and open, and that the voucher increments by exactly the price
3. **PaymentLedger:** `settled ≤ redeemed ≤ cap`, enforced on-chain no matter what the agent or merchant does
4. **Kill switch:** finishes in-flight settlement, then closes the channel on-chain

## Live demo controls

| Button | What it proves |
|---|---|
| **Run agent** | Full loop: plan → 402 → guardrails → voucher → resource → VoucherRedeemed → RLUSD settlement → live storefront |
| **Merchant attack** | A verified merchant quotes 3x at checkout. The agent refuses to sign; no money moves |
| **Over-cap voucher test** | Agent signs a voucher above the channel cap and submits it to the real PaymentLedger as a simulation. The ledger rejects it. No gas, no RLUSD spent |
| **Kill switch** | Channel closed on-chain; nothing further can be redeemed |

An unverified merchant (QuickStock) is also in the catalog. If the agent tries to buy from it, the merchant-verification guardrail blocks it.

## Run it

Node 22.13+.

```bash
npm install
cp .env.example .env     # Windows: copy .env.example .env
# put your agent wallet key in AGENT_PRIVATE_KEY, optionally ANTHROPIC_API_KEY
npm start                # http://localhost:3001
```

A run with the default mandate spends about 0.7 RLUSD (domain 0.2, starter hosting 0.3, photos 0.2).

## Path to production

- Swap the local merchants for real x402 APIs (registrars, hosts, stock libraries) onboarded through a Payee PSP
- Move redemption to the payee facilitator so the agent never pays gas
- Mandates as signed EIP-712 intents, so the merchant can verify the human's authorization too
- Per-category limits (MCC-style) and time-boxed channels per task

## Files

```
server.js            dashboard, merchants, and agent runtime in one process
lib/agent.js         buy side: Claude plan, guardrails, vouchers, redeem + settle, kill switch, over-cap test
lib/merchant.js      sell side: x402 merchants (LaunchKit verified, QuickStock not), voucher verification, storefront hosting
lib/chain.js         PaymentLedger and RLUSD reads
lib/ap4m-sdk.js      AP4M hackathon SDK, extracted from the starter kit
web/index.html       live dashboard
```

The AP4M SDK is provided by Mastercard for hackathon use only.
