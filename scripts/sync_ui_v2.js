import fs from 'fs';
import path from 'path';

const srcDir = 'E:\\项目文件\\邪恶农场';
const destDir = 'e:\\项目文件\\安小将 - 副本';

console.log('开始深度同步《邪恶农场》UI与文案...');

// 1. 完全拷贝 index.html 和 styles.css，只修改网络描述
let html = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf-8');
html = html.replace(/BSC 测试网/g, 'BSC 主网');
fs.writeFileSync(path.join(destDir, 'index.html'), html, 'utf-8');
console.log('✔️ index.html 同步完成 (网络提示已修正为主网)');

let css = fs.readFileSync(path.join(srcDir, 'styles.css'), 'utf-8');
fs.writeFileSync(path.join(destDir, 'styles.css'), css, 'utf-8');
console.log('✔️ styles.css 同步完成');

// 2. 拷贝缺失的静态资源文件 (.webp, .png, .mp3)
const files = fs.readdirSync(srcDir);
for (const file of files) {
    if (file.endsWith('.webp') || file.endsWith('.png') || file.endsWith('.mp3')) {
        fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
    }
}
console.log('✔️ 静态图片及音频资源同步完成');

// 3. 读取并深度替换 app.js 中的中文文案
let appJs = fs.readFileSync(path.join(destDir, 'app.js'), 'utf-8');

const replacements = [
    ['"赤军"', '"红藤农庄"'],
    ['"玄军"', '"青黏农庄"'],
    ['"锐士"', '"捣蛋农夫"'],
    ['"校尉"', '"菜园管事"'],
    ['"将领"', '"农场队长"'],
    ['"偏将"', '"果棚监工"'],
    ['"大将军"', '"农场庄主"'],
    ['大将军', '农场庄主'],
    ['赤军或玄军', '红藤农庄或青黏农庄'],
    ['赤军', '红藤农庄'],
    ['玄军', '青黏农庄'],
    ['获得授印', '签约加入农庄'],
    ['赎回当前身份', '撤出当前身份'],
    ['入伍参战', '入场'],
    ['触发特攻', '触发捣蛋爆发'],
    ['特攻门槛', '捣蛋门槛'],
    ['特攻', '捣蛋爆发'],
    ['新回合', '新季次'],
    ['国库', '农庄仓库'],
    ['这一轮奖励', '这一季收成'],
    ['当前轮次', '当前赛季'],
    ['结算奖励', '结算收成'],
    ['可领取的奖励', '可领取的收成'],
    ['领取奖励', '收割收益'],
    ['锁仓时间', '签约锁定时间'],
    ['暂不能赎回', '暂时不能撤出'],
    ['库府库存', '仓库储备'],
    ['战场动态', '农场动态'],
    ['准备阶段', '备耕阶段'],
    ['战斗阶段', '抢收阶段'],
    ['本轮已结束', '本季已结算'],
    ['等待开战', '等待抢收'],
    ['进行 ', '抢收 '],
    ['壁垒已破', '快被抢光'],
    ['总攻 ', '总捣蛋 '],
    ['总攻', '总捣蛋'],
    ['可赎回', '可撤离'],
    ['锁仓中', '契约锁定中'],
    ['赎回质押', '撤离农场'],
    ['暂不可赎回', '暂不可撤离'],
    ['发起赎回交易', '发起撤离交易'],
    ['加入当前轮次', '加入当前季次'],
    ['本轮奖池', '本季丰收奖池'],
    ['进入战场', '进入农场'],
    ['质押', '签约'],
    ['赎回', '撤出'],
    ['奖励', '收成'],
    ['轮次', '季次']
];

for (let [src, dst] of replacements) {
    appJs = appJs.split(src).join(dst);
}

fs.writeFileSync(path.join(destDir, 'app.js'), appJs, 'utf-8');
console.log('✔️ app.js 业务逻辑文案替换完成');

console.log('✅ UI和文案已完美同步为《邪恶农场》，并保留了主网及核心业务逻辑！请刷新页面查看。');