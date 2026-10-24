// Read-only helpers for the AP4M PaymentLedger + RLUSD, shared by agent and merchant.
const { ethers } = require("ethers");

const CHANNELS_ABI = [
  "function channels(bytes32 channelId) view returns (bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,uint256,uint256,address,uint64,uint8,address,uint64,address,uint64,uint64,uint64)",
];
const LEDGER_ABI = [
  ...CHANNELS_ABI,
  "function redeemVoucher((bytes32 channelId, uint256 cumulativeAmount) voucher, bytes agentSignature) returns (bytes32 claimId, uint256 amount, bytes32 digest)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

const VOUCHER_TYPES = { Voucher: [{ name: "channelId", type: "bytes32" }, { name: "cumulativeAmount", type: "uint256" }] };
const voucherDomain = (chainId, ledger) => ({ name: "AP4M Payment Ledger", version: "1", chainId, verifyingContract: ledger });

async function readChannel(provider, ledger, channelId) {
  const c = new ethers.Contract(ledger, CHANNELS_ABI, provider);
  const r = await c.channels(channelId);
  return { cap: r[7], redeemed: r[8], agent: r[9], status: Number(r[11]), payout: r[12], validAfter: r[16], validBefore: r[17] };
}

async function rlusdBalance(provider, token, who) {
  if (!token || !who) return null;
  return new ethers.Contract(token, ERC20_ABI, provider).balanceOf(who);
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(String(s), "base64").toString("utf8"));
const fmt = (wei) => ethers.formatUnits(wei, 18);

module.exports = { LEDGER_ABI, VOUCHER_TYPES, voucherDomain, readChannel, rlusdBalance, b64, unb64, fmt };
