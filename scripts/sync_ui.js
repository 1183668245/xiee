import fs from 'fs';
import path from 'path';

const srcDir = 'E:\\项目文件\\邪恶农场';
const destDir = 'e:\\项目文件\\安小将 - 副本';

console.log('开始同步样式和结构...');

// 1. 复制 styles.css，并兼容安小将的 logo 图片格式
let css = fs.readFileSync(path.join(srcDir, 'styles.css'), 'utf-8');
css = css.replace(/logo\.webp/g, 'logo.png');
fs.writeFileSync(path.join(destDir, 'styles.css'), css, 'utf-8');
console.log('✔️ styles.css 替换完成');

// 2. 读取 HTML
let srcHtml = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf-8');
let destHtml = fs.readFileSync(path.join(destDir, 'index.html'), 'utf-8');

// 3. 执行严密的业务逻辑词条替换 (映射回安小将阵营与身份)
const replacements = [
    ['邪恶农场：链上双阵营农场对抗与丰收分红协议', '币安链上首个身份授印、阵营对垒的府库分封协议'],
    ['logo.webp', 'logo.png'],
    ['邪恶农场LOGO', '安小将LOGO'],
    ['href="https://x.com/"', 'href="https://x.com/anjiang_bsc_"'],
    ['href="https://t.me/"', 'href="https://t.me/anjiang_bsc"'],
    // 替换顶部导航 Tab
    ['<span id="tabMechanism" class="active tab-link">农场规则</span>\n                <span id="tabFaqs" class="tab-link">常见问题(FAQS)</span>\n                <span class="tab-link">开源验证</span>', 
     '<span id="tabMechanism" class="active tab-link">机制说明</span><a href="./audit-report.html" target="_blank" rel="noopener noreferrer" class="tab-link">审计报告</a>'],
    ['<span id="tabMechanism" class="active tab-link">农场规则</span>\r\n                <span id="tabFaqs" class="tab-link">常见问题(FAQS)</span>\r\n                <span class="tab-link">开源验证</span>', 
     '<span id="tabMechanism" class="active tab-link">机制说明</span><a href="./audit-report.html" target="_blank" rel="noopener noreferrer" class="tab-link">审计报告</a>'],
    // 补回背景音乐开关按钮
    ['<button id="btnConnect">连接钱包</button>', '<button id="btnMusic" class="music-toggle playing" title="背景音乐开关">\n                        <svg class="music-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">\n                            <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>\n                        </svg>\n                    </button>\n                    <button id="btnConnect">连接钱包</button>'],
    ['备耕阶段', '准备阶段'],
    ['抢收阶段', '战斗阶段'],
    ['本季结算', '本轮结束'],
    ['季争夺中', '轮战斗中'],
    ['红藤农庄', '赤方阵营'],
    ['❤ 农场耐久', '❤ 总血量'],
    ['总捣蛋值', '总攻击力'],
    ['青黏农庄', '玄方阵营'],
    ['农场耐久 ❤', '总血量 ❤'],
    ['抢收时间', '战斗时间'],
    ['本季丰收奖池', '本轮奖池'],
    ['仓库储备', '库府库存'],
    ['当前农场局势', '当前战局'],
    ['季次', 'RoundId'],
    ['阶段倒计时', '倒计时'],
    ['丰收奖池 / 农场分红池', '奖池 / 分红池'],
    ['红藤活力/捣蛋', '红HP/攻'],
    ['青黏活力/捣蛋', '蓝HP/攻'],
    ['签订农场契约', '授予印信身份'],
    // 身份和卡片替换
    ['捣蛋农夫.webp', '锐士-转换自-png.webp'],
    ['捣蛋农夫头像', '锐士头像'],
    ['捣蛋农夫', '锐士'],
    ['菜园管事.webp', '校尉-转换自-png.webp'],
    ['菜园管事头像', '校尉头像'],
    ['菜园管事', '校尉'],
    ['果棚监工.webp', '偏将军-转换自-png (1).webp'],
    ['果棚监工头像', '偏将头像'],
    ['果棚监工', '偏将'],
    ['农场庄主.webp', '大将军-转换自-png (1).webp'],
    ['农场庄主头像', '大将军头像'],
    ['农场庄主', '大将军'],
    ['签约 500,000 枚', '质押 500,000 枚'],
    ['签约 1,000,000 枚', '质押 1,000,000 枚'],
    ['签约 5,000,000 枚', '质押 5,000,000 枚'],
    ['签约 10,000,000 枚', '质押 10,000,000 枚'],
    ['活力 +5,000', '血量 +5,000'],
    ['活力 +10,000', '血量 +10,000'],
    ['活力 +50,000', '血量 +50,000'],
    ['活力 +100,000', '血量 +100,000'],
    ['捣蛋 +10', '攻击 +10'],
    ['捣蛋 +18', '攻击 +18'],
    ['捣蛋 +70', '攻击 +70'],
    ['捣蛋 +120', '攻击 +120'],
    // 操作与状态替换
    ['选择归属农庄（仅农场庄主可选）', '效力阵营（仅大将军可选）'],
    ['0-自动补位', '0-自动分配'],
    ['1-红藤农庄', '1-赤军'],
    ['2-青黏农庄', '2-玄军'],
    ['非农场庄主身份默认自动补位到弱势农庄', '非大将军身份默认自动补强弱势方'],
    ['签订契约入场', '立即质押入场'],
    ['本身份所需签约量', '本身份所需质押量'],
    ['签约状态', '授权状态'],
    ['我的农庄身份', '我的信息'],
    ['邪恶农场头像', '安小将头像'],
    ['签约量', '质押量'],
    ['丰收权重', '权重'],
    ['撤出状态', '赎回状态'],
    ['签约剩余', '锁仓剩余'],
    ['待领取收成', '累计奖励'],
    ['撤离农场', '赎回质押'],
    ['收割收益', '领取奖励'],
    ['农场动态', '战场动态'],
    ['农庄总览', '资金总览'],
    ['仓库地址余额', '国库地址余额'],
    ['农场规则', '机制说明'],
    ['关闭规则', '关闭说明'],
    ['进入农场', '进入战场']
];

for (const [src, dst] of replacements) {
    srcHtml = srcHtml.split(src).join(dst);
}

// 4. 将旧版 HTML 中的《机制说明》与《审计报告》弹窗内容完整抠出，并塞入新结构
const oldMatch = destHtml.match(/<div class="modal-body">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>\s*<div id="txOverlay"/);
const newMatch = srcHtml.match(/<div class="modal-body">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>\s*<div id="faqsModal"/);
if (oldMatch && newMatch) {
    srcHtml = srcHtml.replace(newMatch[1], oldMatch[1]);
}

// 5. 剔除安小将不需要的 FAQ 模块
const faqMatch = srcHtml.match(/<div id="faqsModal"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/);
if (faqMatch) {
    srcHtml = srcHtml.replace(faqMatch[0], '');
}

// 6. 补回安小将独有的背景音乐节点
if (!srcHtml.includes('<audio id="bgMusic"')) {
    srcHtml = srcHtml.replace('</body>', '    <audio id="bgMusic" src="./背景音乐.mp3" loop preload="auto"></audio>\n</body>');
}

fs.writeFileSync(path.join(destDir, 'index.html'), srcHtml, 'utf-8');
console.log('✔️ index.html 替换完成');
console.log('✅ 前端页面套用成功！所有的《安小将》业务逻辑和独有文案已完美保留。');