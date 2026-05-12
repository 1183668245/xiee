const { ethers } = require("ethers");
require("dotenv").config({ path: ".env" });

const AXJ_ADDR = process.env.AXJ_ADDR || "";
const RPC_URL = process.env.BSC_RPC || "https://rpc.ankr.com/bsc/7c004b989d92cf193ccd6641b47ad170357aa0debe7b42a6a23148d8d219200e";
const OWNER_PK = process.env.PRIVATE_KEY || "";

async function main() {
  if (!AXJ_ADDR) throw new Error("缺少 AXJ_ADDR");
  if (!OWNER_PK) throw new Error("缺少 PRIVATE_KEY (Owner)");

  const provider = new ethers.JsonRpcProvider(RPC_URL, 56, { staticNetwork: true });
  const owner = new ethers.Wallet(OWNER_PK, provider);

  const axj = new ethers.Contract(
    AXJ_ADDR,
    [
      "function owner() view returns (address)",
      "function treasury() view returns (address)",
      "function emergencySweepAllBNBToTreasury() external",
    ],
    owner
  );

  const [ownerAddr, treasuryAddr, balance] = await Promise.all([
    axj.owner(),
    axj.treasury(),
    provider.getBalance(AXJ_ADDR)
  ]);

  const me = await owner.getAddress();

  console.log("------------ 提取合约资金到国库 ------------");
  console.log("合约地址:", AXJ_ADDR);
  console.log("合约余额:", ethers.formatEther(balance), "BNB");
  console.log("国库地址:", treasuryAddr);
  console.log("操作者 (Owner):", me);
  console.log("------------------------------------------");

  if (me.toLowerCase() !== ownerAddr.toLowerCase()) {
    throw new Error("当前私钥不是合约 Owner，无法执行提取操作");
  }

  if (balance === 0n) {
    console.log("合约当前没有可提取的 BNB 余额。");
    return;
  }

  console.log("正在发起提取交易...");
  const tx = await axj.emergencySweepAllBNBToTreasury();
  console.log("交易已发送:", tx.hash);
  
  const receipt = await tx.wait();
  console.log("交易已确认，资金已划转至国库。");
}

main().catch((e) => {
  console.error("提取失败:", e.shortMessage || e.message);
  process.exit(1);
});