const { ethers } = require("ethers");
require("dotenv").config({ path: ".env" });

const AXJ_ADDR = process.env.AXJ_ADDR || "0x9667bE23E1A2651bb70f20f92EC01af28880430e";
const TOKEN_ADDR = (process.env.TOKEN_ADDR || process.env.PROJECT_TOKEN_ADDRESS || "0xB63c67e6dbdc66aBF1D7DE033882e7bE84427777").toLowerCase();
const RPC_URL = process.env.RPC_URL || process.env.BSC_RPC || "https://binance.llamarpc.com";
const PK = process.env.LISTENER_PK || process.env.PRIVATE_KEY;
const BNB_PRICE_USD = BigInt(process.env.BNB_PRICE_USD || "600");
const SCAN_MS = Number(process.env.SCAN_INTERVAL_MS || 8000);

if (!PK) {
  console.error("缺少 LISTENER_PK");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL, 56, { staticNetwork: true });
const wallet = new ethers.Wallet(PK, provider);
const axj = new ethers.Contract(AXJ_ADDR, [
  "function onBuy(address buyer, bytes32 tradeId, uint256 buyAmountUsd, uint8 identityHint) external",
  "function trustedBuyCallers(address) view returns (bool)",
  "function currentRoundId() view returns (uint256)",
  "function rounds(uint256) view returns (uint256 startTime,uint256 battleStartTime,uint256 endTime,uint256 prizePool,uint256 redHP,uint256 blueHP,uint256 redAttack,uint256 blueAttack,uint256 redWeight,uint256 blueWeight,uint256 lastSettleTime,uint8 winner,bool ended)",
  "function _settleCurrentRound() external"
], wallet);

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const seen = new Set();
let lastBlock = 0;
let settling = false;
let settleUnlockTimer = null;
let ticking = false;
const SETTLE_MS = Number(process.env.SETTLE_INTERVAL_MS || 15000);
const SETTLE_UNLOCK_MS = Number(process.env.SETTLE_UNLOCK_MS || 45000);
const ATTACK_INTERVAL = 10n;
const CONFIRM_BLOCKS = Number(process.env.CONFIRM_BLOCKS || 3);
const OVERLAP_BLOCKS = Number(process.env.OVERLAP_BLOCKS || 2);

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

async function maybeSettle(reason = "定时") {
  if (settling) return;
  const rid = await axj.currentRoundId();
  if (rid === 0n) return;
  const r = await axj.rounds(rid);
  const battleStart = BigInt(r[1]);
  const lastSettleTime = BigInt(r[10]);
  const ended = !!r[12];
  const now = BigInt(Math.floor(Date.now() / 1000));

  if (ended || now < battleStart || now < lastSettleTime + ATTACK_INTERVAL) return;

  settling = true;
  if (settleUnlockTimer) clearTimeout(settleUnlockTimer);
  settleUnlockTimer = setTimeout(() => {
    settling = false;
    log(`推进等待超时，已自动解锁`);
  }, SETTLE_UNLOCK_MS);
  try {
    const tx = await axj._settleCurrentRound();
    log(`${reason}推进回合: ${tx.hash}`);
    tx.wait().then(() => {
      log(`${reason}推进已确认: ${tx.hash}`);
    }).catch((waitErr) => {
      log(`推进已发送，等待确认失败: ${waitErr.shortMessage || waitErr.reason || waitErr.message}`);
    }).finally(() => {
      if (settleUnlockTimer) clearTimeout(settleUnlockTimer);
      settleUnlockTimer = null;
      settling = false;
    });
    return;
  } catch (e) {
    if (settleUnlockTimer) clearTimeout(settleUnlockTimer);
    settleUnlockTimer = null;
    log(`推进跳过: ${e.shortMessage || e.reason || e.message}`);
  }
  settling = false;
}

async function handleMatchedLog(ev) {
  const txHash = ev.transactionHash;
  if (!txHash || seen.has(txHash)) return false;
  seen.add(txHash);

  const tx = await provider.getTransaction(txHash);
  if (!tx || tx.value <= 0n) return false;

  const buyer = ethers.getAddress(tx.from);
  const buyAmountUsd = tx.value * BNB_PRICE_USD;

  log(`命中代币日志: ${txHash}`);
  log(`发现买单: ${buyer} | ${ethers.formatEther(tx.value)} BNB`);
  try {
    const sent = await axj.onBuy(buyer, tx.hash, buyAmountUsd, 0);
    log(`捣蛋爆发已发送: ${sent.hash}`);
    sent.wait().then(() => {
      log(`捣蛋爆发已确认: ${sent.hash}`);
    }).catch((waitErr) => {
      log(`捣蛋爆发已发送，等待确认失败: ${waitErr.shortMessage || waitErr.reason || waitErr.message}`);
    });
    maybeSettle("买单后").catch((e) => {
      log(`买单后推进异常: ${e.shortMessage || e.reason || e.message}`);
    });
    return true;
  } catch (e) {
    log(`触发跳过: ${e.shortMessage || e.reason || e.message}`);
    return false;
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const current = await provider.getBlockNumber();
    const safeTo = current - CONFIRM_BLOCKS;
    if (!lastBlock) {
      lastBlock = Math.max(0, safeTo - 1);
      log(`初始区块: ${lastBlock}，开始监听代币日志`);
      return;
    }
    if (safeTo <= lastBlock) return;

    const from = Math.max(0, lastBlock + 1 - OVERLAP_BLOCKS);
    const logs = await provider.getLogs({
      address: TOKEN_ADDR,
      fromBlock: from,
      toBlock: safeTo,
      topics: [TRANSFER_TOPIC]
    });

    let matched = 0;
    log(`扫描日志区间 ${from}-${safeTo}，命中日志 ${logs.length} 条`);
    for (const ev of logs) {
      try {
        if (await handleMatchedLog(ev)) matched++;
      } catch (e) {
        log(`处理日志失败 ${ev.transactionHash}: ${e.shortMessage || e.message}`);
      }
    }
    log(`日志区间 ${from}-${safeTo} 扫描完成，命中 ${matched} 笔`);
    lastBlock = safeTo;
  } finally {
    ticking = false;
  }
}

async function main() {
  await provider.getNetwork();
  const trusted = await axj.trustedBuyCallers(wallet.address);
  console.log("--------------------------------------");
  console.log("🚀 买单特攻自动上报器");
  console.log(`RPC: ${RPC_URL}`);
  console.log(`代币: ${TOKEN_ADDR}`);
  console.log(`机器人: ${wallet.address}`);
  console.log(`白名单: ${trusted ? "已加入" : "未加入"}`);
  console.log("--------------------------------------");
  setInterval(() => tick().catch(e => log(`监听异常: ${e.shortMessage || e.message}`)), SCAN_MS);
  setInterval(() => maybeSettle().catch(e => log(`推进异常: ${e.shortMessage || e.message}`)), SETTLE_MS);
}

process.on("uncaughtException", (e) => {
  log(`未捕获异常: ${e.shortMessage || e.message}`);
});
process.on("unhandledRejection", (e) => {
  log(`未处理拒绝: ${e?.shortMessage || e?.message || e}`);
});

main().catch(e => {
  console.error(`启动失败: ${e.shortMessage || e.message}`);
  process.exit(1);
});