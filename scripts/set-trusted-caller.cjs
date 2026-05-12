const { ethers } = require("ethers");
require("dotenv").config({ path: ".env" });

const AXJ_ADDR = process.env.AXJ_ADDR || "";
const RPC_URL = process.env.BSC_RPC || "https://bsc-rpc.publicnode.com";
const OWNER_PK = process.env.PRIVATE_KEY || process.env.LISTENER_PK || "";

function arg(name, fallback = "") {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

async function main() {
  const target = arg("--addr");
  const enableRaw = arg("--enable", "true").toLowerCase();
  const enable = enableRaw === "true" || enableRaw === "1";

  if (!AXJ_ADDR) throw new Error("缺少 AXJ_ADDR");
  if (!OWNER_PK) throw new Error("缺少 OWNER_PK（或 LISTENER_PK）");
  if (!target) throw new Error("缺少参数 --addr");
  if (!ethers.isAddress(target)) throw new Error("回调地址格式错误");

  const provider = new ethers.JsonRpcProvider(RPC_URL, 56, { staticNetwork: true });
  const owner = new ethers.Wallet(OWNER_PK, provider);

  const axj = new ethers.Contract(
    AXJ_ADDR,
    [
      "function owner() view returns (address)",
      "function trustedBuyCallers(address) view returns (bool)",
      "function setTrustedBuyCaller(address caller, bool ok) external",
    ],
    owner
  );

  const chain = await provider.getNetwork();
  const ownerOnChain = await axj.owner();
  const me = await owner.getAddress();

  console.log("------------ 白名单回调设置 ------------");
  console.log("链ID:", chain.chainId.toString());
  console.log("合约:", AXJ_ADDR);
  console.log("操作者:", me);
  console.log("合约owner:", ownerOnChain);
  console.log("目标地址:", target);
  console.log("设置值:", enable);
  console.log("----------------------------------------");

  if (me.toLowerCase() !== ownerOnChain.toLowerCase()) {
    throw new Error("当前私钥不是合约 owner，无法设置白名单");
  }

  const before = await axj.trustedBuyCallers(target);
  console.log("设置前:", before);

  if (before === enable) {
    console.log("无需修改，状态已一致。");
    return;
  }

  const tx = await axj.setTrustedBuyCaller(target, enable);
  console.log("交易已发送:", tx.hash);
  await tx.wait();
  console.log("交易已确认");

  const after = await axj.trustedBuyCallers(target);
  console.log("设置后:", after);
}

main().catch((e) => {
  console.error("执行失败:", e.shortMessage || e.reason || e.message);
  process.exit(1);
});