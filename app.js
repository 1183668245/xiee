import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.2/+esm";

const CHAIN_ID = 56;
const REQUIRED_CHAIN_HEX = "0x38";
const READ_RPC_URLS = [
    "https://rpc.ankr.com/bsc/7c004b989d92cf193ccd6641b47ad170357aa0debe7b42a6a23148d8d219200e",
    "https://binance.llamarpc.com",
    "https://bsc-rpc.publicnode.com"
];
const AXJ_ADDR = "0x9667bE23E1A2651bb70f20f92EC01af28880430e";
const PROJECT_TOKEN_ADDR = "0xB63c67e6dbdc66aBF1D7DE033882e7bE84427777";
const BSC_MAINNET_CONFIG = {
    chainId: REQUIRED_CHAIN_HEX,
    chainName: "Binance Smart Chain",
    rpcUrls: [
        "https://rpc.ankr.com/bsc/7c004b989d92cf193ccd6641b47ad170357aa0debe7b42a6a23148d8d219200e"
    ],
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    blockExplorerUrls: ["https://bscscan.com"]
};

const ABI = [
    "event TaxReceived(uint256 amount,uint256 treasuryShare,uint256 dividendShare)",
    "event BuySpecialAttack(address indexed buyer,uint256 indexed roundId,uint8 camp,uint8 identity,bytes32 tradeId,uint256 buyAmountUsd,uint256 damage)",
    "function currentRoundId() view returns(uint256)",
    "function treasury() view returns(address)",
    "function dividendPoolBalance() view returns(uint256)",
    "function rounds(uint256) view returns(uint256 startTime,uint256 battleStartTime,uint256 endTime,uint256 prizePool,uint256 redHP,uint256 blueHP,uint256 redAttack,uint256 blueAttack,uint256 redWeight,uint256 blueWeight,uint256 lastSettleTime,uint8 winner,bool ended)",
    "function roundPlayerWeight(uint256,address) view returns(uint256)",
    "function roundPlayerCamp(uint256,address) view returns(uint8)",
    "function rewardClaimed(uint256,address) view returns(bool)",
    "function players(address) view returns(uint8 camp,uint8 identity,uint256 stakedAmount,uint256 stakeTime,uint256 weight,uint256 lastRoundParticipated)",
    "function pendingRewards(address) view returns(uint256)",
    "function STAKE_LOCK_TIME() view returns(uint256)",
    "function identityStake(uint8) view returns(uint256)",
    "function stake(uint8,uint8)",
    "function joinCurrentRound()",
    "function unstake()",
    "function claimReward()",
    "function _settleCurrentRound()",
    "function settleReward(uint256)",
    "function setTrustedBuyCaller(address,bool)",
    "function emergencySweepAllBNBToTreasury()",
    "function onBuy(address,bytes32,uint256,uint8)"
];

let provider, signer, user, axj, token;
let readProvider, readAxj, readToken;
let readProviderIndex = 0;
let tokenDecimals = 18;
let tokenSymbol = "TOKEN";
let stakeLockSeconds = 7200n;
let listenersBound = false;
let txRunning = false;
let walletActionRunning = false;
let refreshLoopTimer = null;
let fastRefreshUntil = 0;
let lastRealtimeRefreshAt = 0;
let blockHandler = null;
let refreshing = false;
let lastTaxStatsAt = 0;
let taxStatsCache = { treasury: 0n, total: 0n };
let lastTaxScannedBlock = -1;
let taxScanBackoffUntil = 0;
let lastTaxErrorAt = 0;
let lastHeroHp = { red: null, blue: null };
let heroHpScale = { roundId: "-", red: 50000, blue: 50000 };
let selectedIdentity = 1;
let lastAttackScannedBlock = -1;
let lastAttackErrorAt = 0;
let nextRewardRoundToSettle = 0n;
let phaseTicker = null;
let lockTicker = null;
let livePhase = { active: false, roundId: "-", battleStartTime: 0, ended: false };
let liveBattle = { active: false, redHP: 0, blueHP: 0, redAtk: 0, blueAtk: 0, lastSettleTime: 0, battleStartTime: 0, ended: false };
let liveLock = { active: false, unlockAt: 0 };
let chainTimeOffset = 0; // 电脑时间与链上时间的偏移量
const HERO_VISUAL_SETTLE_SECONDS = 10;
const CAMP_LABEL = { 0: "未加入", 1: "红藤农庄", 2: "青黏农庄" };
const ID_LABEL = { 0: "无", 1: "捣蛋农夫", 2: "菜园管事", 3: "农场队长", 4: "果棚监工", 5: "农场庄主" };
const $ = (id) => document.getElementById(id);
const qs = (s) => document.querySelector(s);
const shortAddr = (addr = "") => addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "未连接";
function pushEvent(text, type = "trade") {
    const feed = $("eventFeed");
    if (!feed) return;
    const row = document.createElement("div");
    row.className = "event-item";
    row.innerHTML = `<div class="event-head"><span class="event-type ${type}">${type.toUpperCase()}</span><span>${new Date().toLocaleTimeString()}</span></div><div class="event-text"></div>`;
    row.querySelector(".event-text").textContent = text;
    feed.prepend(row);
    while (feed.children.length > 30) feed.removeChild(feed.lastChild);
}
function classifyEvent(text) {
    if (text.includes("失败") || text.includes("错误")) return "error";
    if (text.includes("领奖") || text.includes("收成") || text.includes("Reward")) return "reward";
    if (text.includes("onBuy") || text.includes("捣蛋爆发") || text.includes("买入")) return "attack";
    return "trade";
}
const log = (m) => {
    const logEl = $("log");
    if (logEl) {
        logEl.textContent += `[${new Date().toLocaleTimeString()}] ${m}\n`;
        logEl.scrollTop = logEl.scrollHeight;
    }
    
    // 过滤逻辑：如果是 RPC 报错、切换节点、超时等技术日志，不推送到“农场动态”
    const msg = m.toLowerCase();
    const isTechnical = msg.includes("rpc") || 
                        msg.includes("节点") || 
                        msg.includes("timeout") || 
                        msg.includes("切换") || 
                        msg.includes("missing response") ||
                        msg.includes("could not coalesce");
                        
    if (!isTechnical) {
        pushEvent(m, classifyEvent(m));
    }
};
const fmtWei = (v) => { try { return ethers.formatEther(v); } catch { return "-"; } };
const fmtBnbShort = (v, digits = 4) => {
    try { return Number(ethers.formatEther(v)).toFixed(digits); } catch { return "-"; }
};

function toFriendlyError(e) {
    const raw = e?.shortMessage || e?.message || "";
    const msg = raw.toLowerCase();
    if (msg.includes("user rejected") || msg.includes("denied") || e?.code === 4001) return "你取消了钱包确认";
    if (msg.includes("no ethereum provider") || msg.includes("install metamask")) return "未检测到钱包插件，请安装或启用MetaMask";
    if (msg.includes("insufficient funds")) return "钱包BNB不足，无法支付Gas";
    if (msg.includes("ownableunauthorizedaccount") || msg.includes("0x118cdaa7") || msg.includes("unknown custom error")) return "当前钱包不是合约Owner，无法执行管理员操作";
    if (msg.includes("wrong network") || msg.includes("chain")) return "当前网络不正确，请切换到BSC主网";
    if (msg.includes("unsupported method") && msg.includes("post")) return "本地静态服务器不处理POST，请检查RPC配置是否生效";
    if (msg.includes("unexpected error") && msg.includes("evmask")) return "检测到钱包扩展冲突，请仅保留一个EVM钱包插件后重试";
    if (msg.includes("missing response") || msg.includes("could not coalesce")) return "RPC节点无响应，请稍后重试（已自动切换备用节点）";
    if (msg.includes("general must choose camp")) return "当前身份为农场庄主，必须先选择红藤农庄或青黏农庄后再签约";
    if (msg.includes("already staked")) return "你已签约加入农庄，请先撤出当前身份";
    if (msg.includes("buyer not active")) return "该买入地址当前未入场，无法触发捣蛋爆发";
    if (msg.includes("identity mismatch")) return "身份参数不匹配，请刷新页面后重试";
    if (msg.includes("trade already processed")) return "这笔买入已经处理过了，请不要重复提交";
    if (msg.includes("one onbuy per block")) return "同一区块内已触发过一次捣蛋爆发，请等待下一笔有效买入";
    if (msg.includes("onbuy cooldown")) return "捣蛋爆发触发冷却中，请稍后再试";
    if (msg.includes("buy too small")) return "买入金额太小，未达到捣蛋门槛";
    if (msg.includes("already joined")) return "你已经加入当前赛季，无需重复加入";
    if (msg.includes("no round")) return "当前暂无可加入的新季次";
    if (msg.includes("no bnb")) return "当前合约内没有可提取的BNB";
    if (msg.includes("sweep transfer failed")) return "提取到农庄仓库失败，请检查农庄仓库地址是否可正常收款";
    if (msg.includes("reward settled")) return "这一季收成已经结算过了";
    if (msg.includes("round not ended")) return "当前赛季还未结束，暂时不能结算收成";
    if (msg.includes("no reward")) return "当前没有可领取的收成";
    if (msg.includes("unlock") || msg.includes("still locked")) return "签约锁定时间未到，暂时不能撤出";
    return raw || "未知错误";
}

function isRpcError(e) {
    const msg = (e?.shortMessage || e?.message || "").toLowerCase();
    return msg.includes("timeout") ||
        msg.includes("network") ||
        msg.includes("failed to fetch") ||
        msg.includes("missing response") ||
        msg.includes("disconnected") ||
        msg.includes("socket hang up");
}

async function retryRead(task, retries = 3, delayMs = 300) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
        try {
            return await task();
        } catch (e) {
            lastErr = e;
            if (i < retries && isRpcError(e)) switchReadProvider();
        }
        if (i < retries) await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
    throw lastErr;
}

async function ensureConnectedAndChain() {
    if (!window.ethereum) throw new Error("未检测到钱包插件");
    await syncWalletState(true);

    const chainId = await Promise.race([
        window.ethereum.request({ method: "eth_chainId" }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("钱包RPC超时，请点击“切换到BSC测试网”修复网络")), 6000))
    ]);

    if ((chainId || "").toLowerCase() !== REQUIRED_CHAIN_HEX.toLowerCase()) {
        throw new Error("当前网络不正确，请先切换到BSC测试网");
    }
}

function setConnStatus(text) { const el = $("connStatus"); if (el) el.textContent = text; }
function updateNetworkActionUI(chainIdLike = 0) {
    const btn = $("btnSwitchChain");
    if (!btn) return;
    const cid = Number(chainIdLike || 0);
    const wrong = cid !== CHAIN_ID;
    btn.style.display = wrong ? "" : "none";
    btn.disabled = !window.ethereum;
}
function setTopConnectBtn(addr = "") {
    const btn = $("btnConnect");
    if (!btn) return;
    if (addr) {
        btn.textContent = shortAddr(addr);
        btn.classList.add("connected");
        btn.title = "点击断开";
    } else {
        btn.textContent = "连接钱包";
        btn.classList.remove("connected");
        btn.title = "点击连接";
    }
}
function setTaxOverview({ treasury = "-", dividend = "-", total = "-" } = {}) {
    const a = $("treasuryTotal");
    const b = $("dividendPool80");
    const c = $("totalTax");
    if (a) a.textContent = treasury;
    if (b) b.textContent = dividend;
    if (c) c.textContent = total;
}

let cachedTreasuryAddr = "";

async function updateBalanceOverview(dividendPoolNow) {
    try {
        if (!cachedTreasuryAddr) {
            cachedTreasuryAddr = await retryRead(() => readAxj.treasury());
        }
        const [treasuryBal, contractBal] = await Promise.all([
            retryRead(() => readProvider.getBalance(cachedTreasuryAddr)),
            retryRead(() => readProvider.getBalance(AXJ_ADDR))
        ]);
        setTaxOverview({
            treasury: `${fmtBnbShort(treasuryBal)} BNB`,
            dividend: `${fmtBnbShort(dividendPoolNow)} BNB`,
            total: `${fmtBnbShort(contractBal)} BNB`
        });

        // 同步更新战场主视觉中的“仓库储备”
        const heroTreasuryEl = $("heroTreasuryStock");
        if (heroTreasuryEl) {
            heroTreasuryEl.textContent = `${fmtBnbShort(contractBal)} BNB`;
        }
    } catch (e) {
        setTaxOverview({
            treasury: "读取失败",
            dividend: `${fmtBnbShort(dividendPoolNow)} BNB`,
            total: "读取失败"
        });
    }
}

async function refreshTaxStatsManual() {
    const btn = $("btnRefreshTax");
    const old = btn ? btn.textContent : "";
    if (btn) {
        btn.disabled = true;
        btn.textContent = "累计刷新中...";
    }

    try {
        const latest = await retryRead(() => readProvider.getBlockNumber());
        const filter = readAxj.filters.TaxReceived();

        let treasury = taxStatsCache.treasury;
        let total = taxStatsCache.total;
        let from = lastTaxScannedBlock >= 0 ? lastTaxScannedBlock + 1 : 0;
        let chunk = 2000;

        while (from <= latest) {
            const to = Math.min(from + chunk - 1, latest);
            try {
                const logs = await retryRead(() => readAxj.queryFilter(filter, from, to), 2, 250);
                for (const ev of logs) {
                    treasury += (ev.args?.treasuryShare ?? ev.args?.[1] ?? 0n);
                    total += (ev.args?.amount ?? ev.args?.[0] ?? 0n);
                }
                from = to + 1;
            } catch (e) {
                if (chunk > 300) {
                    chunk = Math.max(300, Math.floor(chunk / 2));
                    log(`税收扫描区间过大，自动缩小窗口到 ${chunk} blocks`);
                    continue;
                }
                switchReadProvider();
                throw e;
            }
        }

        taxStatsCache = { treasury, total };
        lastTaxScannedBlock = latest;
        lastTaxStatsAt = Date.now();
        log("税收累计刷新成功");
    } catch (e) {
        log(`税收累计刷新失败: ${toFriendlyError(e)}`);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = old;
        }
    }
}
function setHeroPhase(state) {
    const hero = qs(".battle-hero");
    if (!hero) return;
    hero.classList.remove("phase-prep", "phase-battle", "phase-ended");
    if (state === "备耕阶段") hero.classList.add("phase-prep");
    else if (state === "抢收阶段") hero.classList.add("phase-battle");
    else hero.classList.add("phase-ended");
}
function setBattlePhaseBar(state, prepLeft = 0, battleElapsed = 0) {
    const prep = $("phaseStepPrep");
    const battle = $("phaseStepBattle");
    const ended = $("phaseStepEnded");
    [prep, battle, ended].forEach((el) => el && el.classList.remove("active", "done"));
    setHint("phasePrepTime", prepLeft > 0 ? `${Math.floor(prepLeft / 60).toString().padStart(2, "0")}:${(prepLeft % 60).toString().padStart(2, "0")}` : "--:--");
    setHint("phaseBattleTime", battleElapsed > 0 ? `抢收 ${Math.floor(battleElapsed / 60).toString().padStart(2, "0")}:${(battleElapsed % 60).toString().padStart(2, "0")}` : "等待抢收");
    setHint("phaseEndedText", state === "本季已结算" ? "已结束" : "等待结束");
    if (state === "备耕阶段" || state === "未开战") {
        prep?.classList.add("active");
    } else if (state === "抢收阶段") {
        prep?.classList.add("done");
        battle?.classList.add("active");
    } else if (state === "本季已结算") {
        prep?.classList.add("done");
        battle?.classList.add("done");
        ended?.classList.add("active");
    }
}
const ATTACK_INTERVAL_SEC = 10; // 与合约保持一致

function applyLiveBattleVisual(nowSec) {
    if (!liveBattle.active || liveBattle.ended || nowSec < liveBattle.battleStartTime) return;
    
    // 使用校准后的时间计算相对于上次结算的偏移
    const adjustedNow = nowSec + chainTimeOffset;
    const diff = Math.max(0, adjustedNow - Math.max(liveBattle.lastSettleTime, liveBattle.battleStartTime));
    
    // 模拟合约的 stepped 逻辑：
    // 1. 已经满足结算条件的整 10 秒周期（合约下次推进必扣）
    const intervals = Math.floor(diff / ATTACK_INTERVAL_SEC);
    const settledLossRed = intervals * liveBattle.blueAtk;
    const settledLossBlue = intervals * liveBattle.redAtk;

    // 2. 当前周期内未满 10 秒的部分（视觉上的平滑过渡）
    const remainder = diff % ATTACK_INTERVAL_SEC;
    const pendingLossRed = Math.floor((remainder * liveBattle.blueAtk) / ATTACK_INTERVAL_SEC);
    const pendingLossBlue = Math.floor((remainder * liveBattle.redAtk) / ATTACK_INTERVAL_SEC);

    const redHP = Math.max(0, liveBattle.redHP - settledLossRed - pendingLossRed);
    const blueHP = Math.max(0, liveBattle.blueHP - settledLossBlue - pendingLossBlue);
    
    if (isNaN(redHP) || isNaN(blueHP)) return;

    const redEl = $("heroRedHp");
    const blueEl = $("heroBlueHp");

    if (redEl) {
        if (redHP <= 0 && !liveBattle.ended) {
            redEl.textContent = "快被抢光";
            redEl.classList.add("hp-critical");
        } else {
            redEl.textContent = String(redHP);
            redEl.classList.remove("hp-critical");
        }
    }
    if (blueEl) {
        if (blueHP <= 0 && !liveBattle.ended) {
            blueEl.textContent = "快被抢光";
            blueEl.classList.add("hp-critical");
        } else {
            blueEl.textContent = String(blueHP);
            blueEl.classList.remove("hp-critical");
        }
    }

    if ($("redStats")) $("redStats").textContent = `${redHP} / ${liveBattle.redAtk}`;
    if ($("blueStats")) $("blueStats").textContent = `${blueHP} / ${liveBattle.blueAtk}`;

    // 自动纠偏：如果模拟已归零但链上未结束，且距离上次结算已超过 10 秒，尝试在后台静默触发一次结算
    if ((redHP <= 0 || blueHP <= 0) && !liveBattle.ended && !refreshing) {
        const now = Math.floor(Date.now() / 1000);
        if (now - liveBattle.lastSettleTime > ATTACK_INTERVAL_SEC + 5) {
            // 静默刷新，不弹遮罩
            readAxj._settleCurrentRound().catch(() => {});
        }
    }
}
function applyLivePhaseClock() {
    if (!livePhase.active) return;
    const now = Math.floor(Date.now() / 1000);
    const adjustedNow = now + chainTimeOffset;
    
    const state = livePhase.ended ? "本季已结算" : (adjustedNow < livePhase.battleStartTime ? "备耕阶段" : "抢收阶段");
    const prepLeft = livePhase.ended ? 0 : Math.max(0, livePhase.battleStartTime - adjustedNow);
    const battleElapsed = livePhase.ended || adjustedNow < livePhase.battleStartTime ? 0 : Math.max(0, adjustedNow - livePhase.battleStartTime);
    
    const heroTimer = state === "备耕阶段"
        ? `${Math.floor(prepLeft / 60).toString().padStart(2, "0")}:${(prepLeft % 60).toString().padStart(2, "0")}`
        : (state === "抢收阶段" ? `抢收 ${Math.floor(battleElapsed / 60).toString().padStart(2, "0")}:${(battleElapsed % 60).toString().padStart(2, "0")}` : "已结束");
    
    $("roundState").textContent = state;
    $("countdown").textContent = state === "备耕阶段" ? `${prepLeft}s` : (state === "抢收阶段" ? `抢收 ${battleElapsed}s` : "-");
    if ($("heroCountdown")) $("heroCountdown").textContent = heroTimer;
    setHeroPhase(state);
    setBattlePhaseBar(state, prepLeft, battleElapsed);
    
    // 叠加血量视觉推演
    applyLiveBattleVisual(now);
}
function setLivePhaseClock({ roundId = "-", battleStartTime = 0, ended = false, active = true } = {}) {
    livePhase = { roundId, battleStartTime, ended, active };
    applyLivePhaseClock();
    if (!phaseTicker) phaseTicker = setInterval(applyLivePhaseClock, 1000);
}
function pulseHp(el, prev, next) {
    if (!el || prev === null || Number.isNaN(prev) || Number.isNaN(next) || prev === next) return;
    const cls = next < prev ? "hp-down" : "hp-up";
    el.classList.remove("hp-down", "hp-up");
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 600);
}
function setSyncNow() {
    const el = $("syncAt");
    if (el) el.textContent = `同步 ${new Date().toLocaleTimeString()}`;
}
function syncHeroHpScale(roundId, redHP, blueHP) {
    if (heroHpScale.roundId !== String(roundId)) {
        heroHpScale = { roundId: String(roundId), red: Math.max(50000, Number(redHP) || 50000), blue: Math.max(50000, Number(blueHP) || 50000) };
        return;
    }
    heroHpScale.red = Math.max(heroHpScale.red, Number(redHP) || 0, 50000);
    heroHpScale.blue = Math.max(heroHpScale.blue, Number(blueHP) || 0, 50000);
}
function setHeroStats({ roundId = "-", redHP = "--", blueHP = "--", redAtk = "--", blueAtk = "--", timer = "--:--", prize = "-- BNB" } = {}) {
    const heroRound = $("heroRound");
    const heroRedHp = $("heroRedHp");
    const heroBlueHp = $("heroBlueHp");
    const heroRedAtk = $("heroRedAtk");
    const heroBlueAtk = $("heroBlueAtk");
    const heroCountdown = $("heroCountdown");
    const heroPrize = $("heroPrize");
    
    // 进度条元素
    const redBar = $("heroRedHpBar");
    const blueBar = $("heroBlueHpBar");

    if (heroRound) heroRound.textContent = String(roundId);
    
    const redBase = Math.max(50000, heroHpScale.red || 50000);
    const blueBase = Math.max(50000, heroHpScale.blue || 50000);

    if (heroRedHp) {
        const val = Number(redHP);
        const isNum = !isNaN(val) && redHP !== "--";
        pulseHp(heroRedHp, lastHeroHp.red, isNum ? val : null);
        
        if (isNum && val <= 0 && !liveBattle.ended) {
            heroRedHp.textContent = "快被抢光";
            heroRedHp.classList.add("hp-critical");
            if (redBar) redBar.style.width = "0%";
        } else {
            heroRedHp.textContent = isNum ? val.toLocaleString() : "--";
            heroRedHp.classList.remove("hp-critical");
            const pct = isNum ? Math.max(0, Math.min(100, (val / redBase) * 100)) : 0;
            if (redBar) redBar.style.width = `${pct}%`;
            // 更新百分比文字
            const pctEl = heroRedHp.parentElement.querySelector(".hp-pct");
            if (pctEl) pctEl.textContent = isNum ? `${pct.toFixed(2)}%` : "--%";
        }
        if (isNum) lastHeroHp.red = val;
    }
    
    if (heroBlueHp) {
        const val = Number(blueHP);
        const isNum = !isNaN(val) && blueHP !== "--";
        pulseHp(heroBlueHp, lastHeroHp.blue, isNum ? val : null);
        
        if (isNum && val <= 0 && !liveBattle.ended) {
            heroBlueHp.textContent = "快被抢光";
            heroBlueHp.classList.add("hp-critical");
            if (blueBar) blueBar.style.width = "0%";
        } else {
            heroBlueHp.textContent = isNum ? val.toLocaleString() : "--";
            heroBlueHp.classList.remove("hp-critical");
            const pct = isNum ? Math.max(0, Math.min(100, (val / blueBase) * 100)) : 0;
            if (blueBar) blueBar.style.width = `${pct}%`;
            // 更新百分比文字
            const pctEl = heroBlueHp.parentElement.querySelector(".hp-pct");
            if (pctEl) pctEl.textContent = isNum ? `${pct.toFixed(2)}%` : "--%";
        }
        if (isNum) lastHeroHp.blue = val;
    }
    
    if (heroRedAtk) heroRedAtk.textContent = `总捣蛋 ${redAtk}`;
    if (heroBlueAtk) heroBlueAtk.textContent = `总捣蛋 ${blueAtk}`;
    if (heroCountdown) heroCountdown.textContent = String(timer);
    if (heroPrize) heroPrize.textContent = String(prize);
}
function setHint(id, text = "") {
    const el = $(id);
    if (!el) return;
    el.textContent = text || "-";
}
function isMobileDevice() {
    return /android|iphone|ipad|ipod/i.test(navigator.userAgent || "");
}
function setWalletGuide(text = "") {
    const el = $("walletGuide");
    if (!el) return;
    el.textContent = text || "";
}
function setButtonDisabledReason(btn, reason = "") {
    if (!btn) return;
    const tip = reason || "当前不可操作";
    if (btn.disabled) {
        btn.title = tip;
        btn.setAttribute("aria-label", tip);
    } else {
        btn.title = "";
        btn.removeAttribute("aria-label");
    }
}
let txToastTimer = null;
function setUiBusy(show, title = "等待钱包确认", text = "请在钱包中完成签名或确认交易") {
    const overlay = $("txOverlay");
    const titleEl = $("txOverlayTitle");
    const tip = $("txOverlayText");
    if (overlay) {
        overlay.classList.toggle("show", !!show);
        overlay.setAttribute("aria-hidden", show ? "false" : "true");
    }
    if (titleEl) titleEl.textContent = title;
    if (tip) tip.textContent = text;
    document.body.classList.toggle("ui-busy", !!show);
    if (!show) txRunning = false; // 强行关闭时重置交易锁
}
window.setUiBusy = setUiBusy;
function showTxToast(text) {
    const toast = $("txToast");
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add("show");
    toast.setAttribute("aria-hidden", "false");
    if (txToastTimer) clearTimeout(txToastTimer);
    txToastTimer = setTimeout(() => {
        toast.classList.remove("show");
        toast.setAttribute("aria-hidden", "true");
    }, 2200);
}
async function walletRun(title, fn) {
    if (walletActionRunning || txRunning) {
        const msg = "已有操作处理中，请先在钱包完成当前确认";
        log(msg);
        showTxToast(msg);
        return;
    }
    walletActionRunning = true;
    setUiBusy(true, `等待${title}`, `请在钱包中完成${title}确认`);
    try {
        return await fn();
    } catch (e) {
        const msg = `${title}失败：${toFriendlyError(e)}`;
        log(msg);
        showTxToast(msg);
        throw e;
    } finally {
        walletActionRunning = false;
        setUiBusy(false);
    }
}
function bindClick(id, handler) { const el = $(id); if (el) el.onclick = handler; }
function currentReadRpc() { return READ_RPC_URLS[readProviderIndex] || "(未配置RPC)"; }
function renderRpcIndicator(prefix = "未连接") { setConnStatus(`${prefix} | RPC: ${currentReadRpc()}`); }

function getRefreshIntervalMs() {
    if (document.hidden) return 10000;
    if (Date.now() < fastRefreshUntil) return 1000;
    return 3000;
}

function scheduleRefreshLoop() {
    if (refreshLoopTimer) clearTimeout(refreshLoopTimer);
    refreshLoopTimer = setTimeout(async () => {
        if (axj) {
            try { await refreshAll(); } catch (_) {}
        }
        scheduleRefreshLoop();
    }, getRefreshIntervalMs());
}

function bindRealtimeBlockUpdates() {
    if (!readProvider) return;
    if (blockHandler) {
        try { readProvider.off("block", blockHandler); } catch (_) {}
    }
    blockHandler = async () => {
        if (!axj) return;
        const now = Date.now();
        if (now - lastRealtimeRefreshAt < 1200) return;
        lastRealtimeRefreshAt = now;
        try { await refreshAll(); } catch (_) {}
    };
    readProvider.on("block", blockHandler);
}

function applyStateClass(el, type) {
    if (!el) return;
    el.classList.remove("state-ok", "state-warn", "state-bad");
    if (type === "ok") el.classList.add("state-ok");
    if (type === "warn") el.classList.add("state-warn");
    if (type === "bad") el.classList.add("state-bad");
}

function formatRemain(sec) {
    const s = Number(sec);
    if (s <= 0) return "0秒";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return `${h}时 ${m}分 ${r}秒`;
}

function setUnstakeUi(ready, statusText, remainText = "-") {
    const btn = $("btnUnstake");
    const s = $("unstakeStatus");
    const r = $("lockRemain");
    setHint("unstakeBtnHint", ready ? "可点击发起撤离交易" : (statusText || "暂不可撤离"));
    if (btn) {
        btn.disabled = !ready;
        btn.textContent = ready ? "撤离农场" : "暂不可撤离";
        setButtonDisabledReason(btn, statusText || "暂不可撤离");
    }
    if (s) {
        s.textContent = statusText;
        applyStateClass(s, ready ? "ok" : (statusText.includes("锁仓") ? "warn" : "bad"));
    }
    if (r) r.textContent = remainText;
}
function applyLiveLockClock() {
    if (!liveLock.active) return;
    const now = Math.floor(Date.now() / 1000);
    const remain = Math.max(0, liveLock.unlockAt - now);
    if (remain <= 0) {
        liveLock.active = false;
        setUnstakeUi(true, "可撤离", "0秒");
        return;
    }
    setUnstakeUi(false, "契约锁定中", formatRemain(remain));
}
function setLiveLockClock(unlockAt = 0) {
    if (!unlockAt || unlockAt <= 0) {
        liveLock = { active: false, unlockAt: 0 };
        return;
    }
    liveLock = { active: true, unlockAt };
    applyLiveLockClock();
    if (!lockTicker) lockTicker = setInterval(applyLiveLockClock, 1000);
}

function setStakeFlowEnabled(enabled, reason = "", disabledText = "暂不可签约", enabledText = "立即签约") {
    const stakeBtn = $("btnStake");
    const hintEl = $("stakeBtnHint");
    const enabledHint = reason || (enabledText === "加入本季" ? "当前仓位可直接加入本季，无需重新授权" : "点击立即签约，系统会自动先授权再签约");
    setHint("stakeBtnHint", enabled ? enabledHint : (reason || "当前不可签约"));
    if (hintEl) applyStateClass(hintEl, enabled ? "ok" : "bad");

    if (stakeBtn) {
        stakeBtn.disabled = !enabled;
        stakeBtn.textContent = enabled ? enabledText : disabledText;
        setButtonDisabledReason(stakeBtn, reason || "当前不可签约");
    }
}

function syncCampByIdentity() {
    const identity = Number(selectedIdentity || 1);
    const campEl = $("camp");
    const isCommander = identity === 5;
    if (!campEl) return;

    if (!isCommander) campEl.value = "0";
    campEl.disabled = !isCommander;
    setButtonDisabledReason(campEl, isCommander ? "农场庄主可手动选择效力阵营" : "仅农场庄主可自选阵营");
    setHint("campHint", isCommander ? "当前身份为农场庄主：必须手动选择红藤农庄或青黏农庄" : "非农场庄主身份默认自动分配至弱势阵营");
    const campHintEl = $("campHint");
    if (campHintEl) applyStateClass(campHintEl, isCommander ? (campEl.value === "0" ? "bad" : "ok") : "warn");
}

function syncIdentityCards() {
    const selected = String(selectedIdentity || 1);
    document.querySelectorAll("#identityCards .id-card").forEach((card) => {
        card.classList.toggle("active", card.dataset.identity === selected);
    });
}

async function findNextRewardRound(userAddr, currentRid) {
    for (let rid = Number(currentRid); rid >= 1; rid--) {
        const [r, weight, camp, claimed] = await Promise.all([
            retryRead(() => readAxj.rounds(rid)),
            retryRead(() => readAxj.roundPlayerWeight(rid, userAddr)),
            retryRead(() => readAxj.roundPlayerCamp(rid, userAddr)),
            retryRead(() => readAxj.rewardClaimed(rid, userAddr))
        ]);
        if (!r.ended || claimed || weight === 0n) continue;
        if (Number(camp) !== 0 && Number(camp) === Number(r.winner)) return BigInt(rid);
    }
    return 0n;
}

function setRewardActionUi(pending, nextRound) {
    const btn = $("btnClaim");
    const hint = $("rewardHint");
    if (!btn || !hint) return;
    if (nextRound > 0n) {
        btn.disabled = false;
        btn.textContent = `同步第${nextRound}季收成`;
        hint.textContent = `检测到第${nextRound}季收成尚未同步，点击后自动结转到累计收成`;
        return;
    }
    if (pending > 0n) {
        btn.disabled = false;
        btn.textContent = "收割收益";
        hint.textContent = "累计收成已就绪，可直接领取";
        return;
    }
    btn.disabled = true;
    btn.textContent = "暂无收成";
    hint.textContent = "当前没有待同步或可领取的收成";
}

function bindIdentityCards() {
    document.querySelectorAll("#identityCards .id-card").forEach((card) => {
            card.style.cursor = "pointer";
            card.onclick = () => {
                const identity = Number(card.dataset.identity || "1");
                selectedIdentity = identity;
                syncIdentityCards();
                syncCampByIdentity();
                updateStakeDiagnostics().catch(e => log(`刷新签约检查失败: ${e.message}`));
            };
        });
        const campEl = $("camp");
        if (campEl) {
            campEl.onchange = () => {
                syncCampByIdentity();
                updateStakeDiagnostics().catch(e => log(`刷新签约检查失败: ${e.message}`));
            };
        }
}

function rebuildReadClients() {
    if (readProvider && blockHandler) {
        try { readProvider.off("block", blockHandler); } catch (_) {}
    }

    const rpc = currentReadRpc();
    readProvider = new ethers.JsonRpcProvider(rpc, CHAIN_ID);
    readAxj = new ethers.Contract(AXJ_ADDR, ABI, readProvider);
    readToken = new ethers.Contract(PROJECT_TOKEN_ADDR, [
        "function balanceOf(address) view returns(uint256)",
        "function allowance(address,address) view returns(uint256)",
        "function decimals() view returns(uint8)",
        "function symbol() view returns(string)"
    ], readProvider);
    renderRpcIndicator(user ? "已连接" : "未连接");
    if (user) bindRealtimeBlockUpdates();
}

function switchReadProvider() {
    if (!READ_RPC_URLS.length) return;
    readProviderIndex = (readProviderIndex + 1) % READ_RPC_URLS.length;
    rebuildReadClients();
    log(`读取RPC切换为: ${currentReadRpc()}`);
}

function initReadClients() {
    if (readProvider) return;
    rebuildReadClients();
}

function disconnectUI() {
    user = undefined; signer = undefined; axj = undefined; token = undefined;
    updateNetworkActionUI(0);
    setWalletGuide("");
    setTopConnectBtn("");
    const wm = $("walletMini"); if (wm) wm.textContent = "未连接";
    $("network").textContent = "-";
    $("roundId").textContent = "-";
    $("roundState").textContent = "-";
    $("countdown").textContent = "-";
    setHeroStats();
    $("pools").textContent = "-";
    setTaxOverview();
    $("redStats").textContent = "-";
    $("blueStats").textContent = "-";
    $("myRole").textContent = "-";
    $("myStake").textContent = "-";
    $("myWeight").textContent = "-";
    const t = $("myTokenBalance"); if (t) t.textContent = "-";
    $("myPending").textContent = "-";
    const n = $("needStake"); if (n) n.textContent = "-";
    const a = $("allowanceNow"); if (a) a.textContent = "-";
    const s = $("allowanceState");
    if (s) {
        s.textContent = "-";
        applyStateClass(s, "");
    }
    setStakeFlowEnabled(true);
    setUnstakeUi(false, "未连接", "-");
    setConnStatus("未连接");
}

async function syncWalletState(requireConnected = false) {
    if (!window.ethereum) {
        if (requireConnected) throw new Error("未检测到钱包插件");
        return false;
    }
    provider = provider || new ethers.BrowserProvider(window.ethereum);
    const accounts = await provider.send("eth_accounts", []);
    if (!accounts || accounts.length === 0) {
        if (requireConnected) throw new Error("请先连接钱包");
        disconnectUI();
        return false;
    }

    const active = ethers.getAddress(accounts[0]);
    if (!user || user.toLowerCase() !== active.toLowerCase() || !signer || !axj || !token) {
        signer = await provider.getSigner(active);
        user = active;
        axj = new ethers.Contract(AXJ_ADDR, ABI, signer);
        token = new ethers.Contract(PROJECT_TOKEN_ADDR, [
            "function balanceOf(address) view returns(uint256)",
            "function allowance(address,address) view returns(uint256)",
            "function approve(address,uint256) returns(bool)",
            "function decimals() view returns(uint8)",
            "function symbol() view returns(string)"
        ], signer);
    }

    setTopConnectBtn(user);
    const wm = $("walletMini"); if (wm) wm.textContent = shortAddr(user);
    return true;
}

function bindWalletListeners() {
    if (!window.ethereum || listenersBound) return;
    window.ethereum.on("accountsChanged", async () => {
        try {
            const ok = await syncWalletState(false);
            if (!ok) return;
            await refreshAll();
        } catch (e) {
            log(`钱包切换后同步失败: ${toFriendlyError(e)}`);
            disconnectUI();
        }
    });
    window.ethereum.on("chainChanged", async () => {
        try {
            await syncWalletState(false);
            await refreshAll();
            showTxToast("网络已切换，状态已同步");
        } catch (e) {
            log(`网络切换后刷新失败: ${toFriendlyError(e)}`);
        }
    });
    listenersBound = true;
}

function closeMobileGuide() {
    const modal = $("mobileGuideModal");
    if (modal) modal.classList.remove("show");
}
window.closeMobileGuide = closeMobileGuide;

async function connect(silent = false) {
    initReadClients();
    
    if (!window.ethereum) {
        if (silent) return;
        if (isMobileDevice()) {
            const currentUrl = encodeURIComponent(window.location.href);
            $("linkTP").href = `tphub://download?url=${currentUrl}`;
            $("linkMM").href = `https://metamask.app.link/dapp/${window.location.host}${window.location.pathname}`;
            $("linkOKX").href = `okx://download?url=${currentUrl}`;
            
            const modal = $("mobileGuideModal");
            if (modal) modal.classList.add("show");
            return;
        }
        setWalletGuide("未检测到钱包插件，请在钱包App内置浏览器打开");
        showTxToast("未检测到钱包插件");
        return;
    }
    setWalletGuide("");
    provider = new ethers.BrowserProvider(window.ethereum);

    if (silent) {
        const accounts = await provider.send("eth_accounts", []);
        if (accounts.length === 0) return;
    } else {
        await provider.send("eth_requestAccounts", []);
    }

    await syncWalletState(true);
    const net = await provider.getNetwork();

    try {
        tokenDecimals = Number(await readToken.decimals());
        tokenSymbol = await readToken.symbol();
        stakeLockSeconds = await readAxj.STAKE_LOCK_TIME();
    } catch {
        tokenDecimals = 18;
        tokenSymbol = "TOKEN";
        stakeLockSeconds = 7200n;
    }

    setTopConnectBtn(user);
    const wm = $("walletMini"); if (wm) wm.textContent = shortAddr(user);
    $("network").textContent = `${net.name} (${net.chainId})`;
    $("contractAddr").textContent = AXJ_ADDR;
    $("contractAddr").style.cursor = "pointer";
    $("contractAddr").onclick = () => {
        navigator.clipboard.writeText(AXJ_ADDR);
        showTxToast("合约地址已复制");
    };
    setConnStatus(Number(net.chainId) === CHAIN_ID ? "已连接" : "网络错误");
    updateNetworkActionUI(Number(net.chainId));
    if (Number(net.chainId) !== CHAIN_ID && !silent) {
        log("请先切换到 BSC主网（56）再进行交易");
        showTxToast("当前网络不正确，请先切换到BSC主网");
    }
    bindWalletListeners();
    bindRealtimeBlockUpdates();
    scheduleRefreshLoop();
    await refreshAll();
}

async function updateStakeDiagnostics(playerInfo = null) {
    if (!user) return;
    initReadClients();

    const needEl = $("needStake");
    const allEl = $("allowanceNow");
    const stateEl = $("allowanceState");

    try {
        const identity = Number(selectedIdentity || 1);
        const need = await retryRead(() => readAxj.identityStake(identity));
        const allowance = await retryRead(() => readToken.allowance(user, AXJ_ADDR));
        const bal = await retryRead(() => readToken.balanceOf(user));
        const p = playerInfo ?? await retryRead(() => readAxj.players(user));
        const currentRid = await retryRead(() => readAxj.currentRoundId());

        if (needEl) needEl.textContent = `${ethers.formatUnits(need, tokenDecimals)} ${tokenSymbol}`;
        if (allEl) allEl.textContent = `${ethers.formatUnits(allowance, tokenDecimals)} ${tokenSymbol}`;

        if (stateEl && p.stakedAmount > 0n) {
            if (currentRid === 0n) {
                stateEl.textContent = "已签约，等待新一轮开启";
                applyStateClass(stateEl, "warn");
                setStakeFlowEnabled(false, "当前暂无可加入季次，请等待新一轮开启", "等待新轮");
                return;
            }
            if (p.lastRoundParticipated < currentRid) {
                stateEl.textContent = "已签约，点击加入本季继续参战";
                applyStateClass(stateEl, "warn");
                setStakeFlowEnabled(true, "当前仓位可直接加入本季，无需重新授权", "暂不可操作", "加入本季");
                return;
            }
            stateEl.textContent = "已在本季参战（无需再次授权）";
            applyStateClass(stateEl, "ok");
            setStakeFlowEnabled(false, "你已在本季参战", "已在本季参战");
            return;
        }

        const mustChooseCamp = identity === 5 && $("camp")?.value === "0";
        if (mustChooseCamp) {
            if (stateEl) {
                stateEl.textContent = "农场庄主必须先选择红藤农庄或青黏农庄";
                applyStateClass(stateEl, "bad");
            }
            setStakeFlowEnabled(false, "当前身份为农场庄主，请先选择红藤农庄或青黏农庄", "请选择阵营");
            return;
        }

        const enoughAllowance = allowance >= need;
        const enoughBalance = bal >= need;

        if (stateEl) {
            if (!enoughBalance) {
                stateEl.textContent = "余额不足";
                applyStateClass(stateEl, "bad");
                setStakeFlowEnabled(false, "代币余额不足，暂时不能签约", "余额不足");
            } else if (enoughAllowance) {
                stateEl.textContent = "已满足，可签约";
                applyStateClass(stateEl, "ok");
                setStakeFlowEnabled(true, "点击立即签约，系统会自动先授权再签约", "立即签约");
            } else {
                stateEl.textContent = "授权不足，点击“立即签约”将自动授权";
                applyStateClass(stateEl, "warn");
                setStakeFlowEnabled(true, "点击立即签约，系统会自动先授权再签约", "立即签约");
            }
        }
    } catch (e) {
        if (needEl) needEl.textContent = "-";
        if (allEl) allEl.textContent = "-";
        if (stateEl) {
            stateEl.textContent = "读取失败";
            applyStateClass(stateEl, "warn");
        }
        log(`签约检查读取失败: ${toFriendlyError(e)}`);
    }
}

async function refreshAttackFeed() {
    try {
        const latest = await retryRead(() => readProvider.getBlockNumber());
        if (lastAttackScannedBlock < 0) {
            lastAttackScannedBlock = Math.max(0, latest - 50);
            return;
        }
        if (latest <= lastAttackScannedBlock) return;

        const from = lastAttackScannedBlock + 1;
        const to = latest;
        const logs = await retryRead(() => readAxj.queryFilter(readAxj.filters.BuySpecialAttack(), from, to), 2, 200);
        for (const ev of logs) {
            const buyer = ev.args?.buyer ?? ev.args?.[0] ?? "-";
            const roundId = ev.args?.roundId ?? ev.args?.[1] ?? 0n;
            const usd = ev.args?.buyAmountUsd ?? ev.args?.[5] ?? 0n;
            const damage = ev.args?.damage ?? ev.args?.[6] ?? 0n;
            pushEvent(`捣蛋爆发触发：${shortAddr(String(buyer))} 在第${roundId}季造成 ${damage} 伤害（买入 ${Number(ethers.formatUnits(usd, 18)).toFixed(2)} USD）`, "attack");
        }
        lastAttackScannedBlock = latest;
    } catch (e) {
        if (Date.now() - lastAttackErrorAt > 60000) {
            log(`农场动态同步失败: ${toFriendlyError(e)}`);
            lastAttackErrorAt = Date.now();
        }
    }
}

async function refreshAll() {
    if (refreshing) return;
    refreshing = true;
    try {
        initReadClients();
        if (!user || !provider) return;

        const net = await provider.getNetwork();
        $("network").textContent = `${net.name} (${net.chainId})`;
        setConnStatus(Number(net.chainId) === CHAIN_ID ? "已连接" : "网络错误");
        updateNetworkActionUI(Number(net.chainId));
        if (Number(net.chainId) !== CHAIN_ID) return;

        await refreshAttackFeed();

        const rid = await retryRead(() => readAxj.currentRoundId());
        $("roundId").textContent = rid.toString();
        const now = Math.floor(Date.now() / 1000);
        
        // 关键：获取区块时间并计算偏移量，实现时钟对齐
        const latestBlock = await retryRead(() => readProvider.getBlock("latest"));
        if (latestBlock) {
            // 增加 1 秒的预估延迟补偿，解决 RPC 传输时差
            chainTimeOffset = (Number(latestBlock.timestamp) - now) + 1;
        }

        const pool = await retryRead(() => readAxj.dividendPoolBalance());
        await updateBalanceOverview(pool);

        if (rid > 0n) {
            const r = await retryRead(() => readAxj.rounds(rid));
            const state = r.ended ? "本季已结算" : (now < Number(r.battleStartTime) ? "备耕阶段" : "抢收阶段");
            const prepLeft = r.ended ? 0 : Math.max(0, Number(r.battleStartTime) - now);
            const battleElapsed = r.ended || now < Number(r.battleStartTime) ? 0 : Math.max(0, now - Number(r.battleStartTime));
            const heroTimer = state === "备耕阶段"
                ? `${Math.floor(prepLeft / 60).toString().padStart(2, "0")}:${(prepLeft % 60).toString().padStart(2, "0")}`
                : (state === "抢收阶段" ? `抢收 ${Math.floor(battleElapsed / 60).toString().padStart(2, "0")}:${(battleElapsed % 60).toString().padStart(2, "0")}` : "已结束");

            setLivePhaseClock({ roundId: rid.toString(), battleStartTime: Number(r.battleStartTime), ended: !!r.ended, active: true });
            
            // 同步实时推演基准数据
            liveBattle = {
                active: !r.ended,
                redHP: Number(r.redHP),
                blueHP: Number(r.blueHP),
                redAtk: Number(r.redAttack),
                blueAtk: Number(r.blueAttack),
                lastSettleTime: Number(r.lastSettleTime),
                battleStartTime: Number(r.battleStartTime),
                ended: !!r.ended
            };

            $("pools").textContent = `${fmtBnbShort(r.prizePool)} / ${fmtBnbShort(pool)}`;
            $("redStats").textContent = `${r.redHP} / ${r.redAttack}`;
            $("blueStats").textContent = `${r.blueHP} / ${r.blueAttack}`;
            syncHeroHpScale(rid, r.redHP, r.blueHP);

            setHeroStats({
                roundId: rid.toString(),
                redHP: r.redHP,
                blueHP: r.blueHP,
                redAtk: r.redAttack,
                blueAtk: r.blueAttack,
                timer: heroTimer,
                prize: `${fmtBnbShort(r.prizePool)} BNB`
            });
        } else {
            livePhase = { active: false, roundId: "-", battleStartTime: 0, ended: false };
            liveBattle = { active: false, redHP: 0, blueHP: 0, redAtk: 0, blueAtk: 0, lastSettleTime: 0, battleStartTime: 0, ended: false };
            heroHpScale = { roundId: "-", red: 50000, blue: 50000 };
            $("roundState").textContent = "未开战";
            setHeroPhase("未开战");
            setBattlePhaseBar("未开战", 0, 0);
            $("countdown").textContent = "-";
            $("pools").textContent = `- / ${fmtWei(pool)}`;
            $("redStats").textContent = "-";
            $("blueStats").textContent = "-";
            setHeroStats({ roundId: "-", redHP: "--", blueHP: "--", redAtk: "--", blueAtk: "--", timer: "--:--", prize: "-- BNB" });
        }

        const p = await retryRead(() => readAxj.players(user));
        const pending = await retryRead(() => readAxj.pendingRewards(user));
        $("myRole").textContent = `${CAMP_LABEL[Number(p.camp)] || p.camp}/${ID_LABEL[Number(p.identity)] || p.identity}`;
        $("myStake").textContent = fmtWei(p.stakedAmount);
        $("myWeight").textContent = ethers.formatUnits(p.weight, 18);

        const nowSec = BigInt(Math.floor(Date.now() / 1000));
        if (p.stakedAmount === 0n) {
            liveLock = { active: false, unlockAt: 0 };
            setUnstakeUi(false, "当前无签约仓位", "-");
            setStakeFlowEnabled(true);
        } else {
            setStakeFlowEnabled(false, "你已在本季签约，先撤出后再签约");
            const unlockAt = p.stakeTime + stakeLockSeconds;
            if (nowSec >= unlockAt) {
                liveLock = { active: false, unlockAt: 0 };
                setUnstakeUi(true, "可撤离", "0秒");
            } else {
                setLiveLockClock(Number(unlockAt));
            }
        }

        const bal = await retryRead(() => readToken.balanceOf(user));
        const tokenEl = $("myTokenBalance");
        if (tokenEl) {
            const balInt = bal / (10n ** BigInt(tokenDecimals));
            tokenEl.textContent = `${balInt.toString()} ${tokenSymbol}`;
        }
        $("myPending").textContent = fmtWei(pending);

        nextRewardRoundToSettle = await findNextRewardRound(user, rid);
        setRewardActionUi(pending, nextRewardRoundToSettle);

        await updateStakeDiagnostics(p);
        setSyncNow();
    } catch (e) {
        log(`刷新失败: ${toFriendlyError(e)}`);
    } finally {
        refreshing = false;
    }
}

async function txRun(fn, title, buttonId = "") {
    if (txRunning) {
        log(`已有交易处理中，请等待上一笔完成后再操作`);
        return;
    }

    const btn = buttonId ? $(buttonId) : null;
    const oldText = btn ? btn.textContent : "";

    txRunning = true;
    setUiBusy(true, `等待${title}确认`, `请在钱包中确认${title}请求，不要重复点击`);
    if (btn) {
        btn.disabled = true;
        btn.textContent = `${title}处理中...`;
    }

    try {
        const tx = await fn();
        log(`${title} 已发送: ${tx.hash}`);
        setUiBusy(true, `${title}已发送`, "交易已提交到链上，正在等待确认");
        await tx.wait();
        log(`${title} 成功`);
        setUiBusy(false);
        showTxToast(`${title}成功`);
        fastRefreshUntil = Date.now() + 15000;
        scheduleRefreshLoop();
        refreshAll().catch((e) => log(`刷新失败: ${toFriendlyError(e)}`));
    } catch (e) {
        setUiBusy(false);
        const msg = `${title}失败: ${toFriendlyError(e)}`;
        log(msg);
        showTxToast(msg);
    } finally {
        txRunning = false;
        if (btn) btn.textContent = oldText;
    }
}

bindClick("btnConnect", async () => {
    if (user) {
        disconnectUI();
        log("已断开前端会话（钱包授权需在钱包插件中管理）");
        return;
    }
    await walletRun("连接钱包", async () => {
        try { await connect(); }
        catch (e) {
            log(`连接钱包失败: ${toFriendlyError(e)}`);
            if (!window.ethereum && isMobileDevice()) {
                setWalletGuide("检测到手机环境：请复制链接后用钱包App内置浏览器打开");
            }
        }
    });
});
bindClick("btnSwitchChain", async () => {
    if (!window.ethereum) {
        showTxToast("未检测到钱包插件");
        return;
    }
    await walletRun("切换网络", async () => {
        try {
            await window.ethereum.request({ method: "wallet_addEthereumChain", params: [BSC_MAINNET_CONFIG] });
        } catch (_) {}

        try {
            await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: REQUIRED_CHAIN_HEX }] });
            log("已切换到 BSC主网（稳定RPC配置）");
        } catch (e) {
            log(`切换网络失败: ${toFriendlyError(e)}`);
        }
    });
});
bindClick("btnRefresh", refreshAll);
bindClick("btnRefreshTax", async () => { await refreshTaxStatsManual(); await refreshAll(); });

const mechanismModal = $("mechanismModal");
const faqsModal = $("faqsModal");
const tabMechanism = $("tabMechanism");
const tabFaqs = $("tabFaqs");
const openModal = (modal) => {
    if (!modal) return;
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
};
const closeModal = (modal) => {
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
};
const closeMechanism = () => closeModal(mechanismModal);
const closeFaqs = () => closeModal(faqsModal);

if (tabMechanism) tabMechanism.onclick = () => openModal(mechanismModal);
if (tabFaqs) tabFaqs.onclick = () => openModal(faqsModal);
const btnCloseMechanism = $("btnCloseMechanism");
const btnCloseFaqs = $("btnCloseFaqs");
if (btnCloseMechanism) btnCloseMechanism.onclick = closeMechanism;
if (btnCloseFaqs) btnCloseFaqs.onclick = closeFaqs;
if (mechanismModal) {
    mechanismModal.addEventListener("click", (e) => {
        if (e.target?.dataset?.close === "1") closeMechanism();
    });
}
if (faqsModal) {
    faqsModal.addEventListener("click", (e) => {
        if (e.target?.dataset?.close === "1") closeFaqs();
    });
}
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        closeMechanism();
        closeFaqs();
    }
});
document.querySelectorAll(".faq-question").forEach((btn) => {
    btn.addEventListener("click", () => {
        const item = btn.closest(".faq-item");
        const answer = item?.querySelector(".faq-answer");
        if (!item || !answer) return;
        const active = item.classList.contains("active");
        document.querySelectorAll(".faq-item").forEach((node) => {
            node.classList.remove("active");
            const panel = node.querySelector(".faq-answer");
            if (panel) panel.style.maxHeight = null;
        });
        if (!active) {
            item.classList.add("active");
            answer.style.maxHeight = `${answer.scrollHeight}px`;
        }
    });
});
bindIdentityCards();
syncIdentityCards();
syncCampByIdentity();
bindClick("btnStake", () => txRun(async () => {
    await ensureConnectedAndChain();
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== CHAIN_ID) throw new Error("当前网络不正确，请先切换到BSC主网");

    const me = await axj.players(user);
    const currentRid = await axj.currentRoundId();
    if (me.stakedAmount > 0n) {
        if (currentRid === 0n) throw new Error("当前暂无可加入季次，请等待新一轮开启");
        if (me.lastRoundParticipated < currentRid) return axj.joinCurrentRound();
        throw new Error("你已在本季参战，无需重复加入");
    }
    const identity = Number(selectedIdentity || 1);
    const need = await axj.identityStake(identity);
    const bal = await token.balanceOf(user);
    if (bal < need) throw new Error("代币余额不足，无法签约");

    const allowance = await token.allowance(user, AXJ_ADDR);
    if (allowance < need) {
        log("授权不足，先发起授权...");
        const approveTx = await token.approve(AXJ_ADDR, need);
        log(`授权已发送: ${approveTx.hash}`);
        await approveTx.wait();
        log("授权成功，继续发起签约...");
    }

    const camp = identity === 5 ? Number($("camp").value) : 0;
    return axj.stake(camp, identity);
}, ($("btnStake")?.textContent || "立即签约").includes("加入本季") ? "加入本季" : "签约", "btnStake"));
bindClick("btnUnstake", () => txRun(async () => {
    await ensureConnectedAndChain();
    const me = await axj.players(user);
    if (me.stakedAmount === 0n) throw new Error("当前没有可撤离的签约仓位");
    return axj.unstake();
}, "撤出", "btnUnstake"));
bindClick("btnClaim", () => txRun(async () => {
    await ensureConnectedAndChain();
    const pending = await axj.pendingRewards(user);
    if (nextRewardRoundToSettle > 0n) return axj.settleReward(nextRewardRoundToSettle);
    if (pending > 0n) return axj.claimReward();
    throw new Error("当前没有可同步或可领取的收成");
}, nextRewardRoundToSettle > 0n ? `同步第${nextRewardRoundToSettle}季收成` : "收割收益", "btnClaim"));

// 背景音乐控制
function initBgMusic() {
    const audio = $("bgMusic");
    const btn = $("btnMusic");
    if (!audio || !btn) return;

    let isPlaying = true; // 默认设为 true，符合用户期望的默认开启

    const toggle = async () => {
        try {
            if (isPlaying) {
                audio.pause();
                btn.classList.remove("playing");
                btn.classList.add("muted");
                isPlaying = false;
            } else {
                await audio.play();
                btn.classList.add("playing");
                btn.classList.remove("muted");
                isPlaying = true;
            }
        } catch (err) {
            console.log("播放失败:", err);
        }
    };

    btn.onclick = toggle;

    // 尝试在用户第一次交互时自动播放
    const autoPlayOnce = async () => {
        if (!isPlaying) {
            try {
                await audio.play();
                isPlaying = true;
                btn.classList.add("playing");
                btn.classList.remove("muted");
                document.removeEventListener("click", autoPlayOnce);
                document.removeEventListener("touchstart", autoPlayOnce);
            } catch (_) {}
        }
    };

    document.addEventListener("click", autoPlayOnce);
    document.addEventListener("touchstart", autoPlayOnce);
}

initReadClients();
log(`启动RPC: ${currentReadRpc()}`);
renderRpcIndicator("未连接");
updateNetworkActionUI(0);
initBgMusic(); // 初始化音乐
scheduleRefreshLoop();

// 页面加载时尝试自动重连（静默模式）
connect(true).catch(() => {});

document.addEventListener("visibilitychange", () => {
    scheduleRefreshLoop();
    if (!document.hidden && axj) refreshAll().catch(() => {});
});