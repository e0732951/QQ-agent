// jy-tarot 3.0 版面（HTML + CSS）
//
// 为什么单独成文件：这个模块**同时**被插件的出图流程和构建期的静态预览生成器引用，
// 保证「预览看到的版面」与「实际渲染出来的」是同一份代码 —— 不会出现预览好看、
// 上线走样的经典问题（本项目为"只看锚点和语法、没跑渲染"付过代价，见插件协议）。
//
// ── v3 相对 v2 的版面变化（只有三处）────────────────────────────────────
//   1) 图一从**两牌**变**三牌**：大阿卡纳（主题）+ 小阿卡纳（事件）+ 宫廷牌（第三维度）。
//      因此页宽从 1180 加到 1500（卡宽 292 与正文列宽都不动）；
//      两页的宽度**各自常量**，由 builder 一并返回，渲染层照它设置窗口/截图矩形。
//   2) 图一正文列新增一个「宫 廷」块（含义 + 核心词），带金色左边线以示"另一维度"。
//      ⚠️ 图一仍然**不出建议**（v2 的不变量，用户明确要求）；宫廷牌的 advice 只在图二用。
//   3) 图二版面**不动**，只在「最 终 建 议」块末尾接一段「宫 廷 指 引」（牌名 + 核心词 + 含义）。
//
// 配色：**整页深色**（深蓝→紫的渐变，与卡面的暖米边框形成对比，卡像"贴在夜空上"）。
//   ⚠️ 深色必须同时给 html 和 body —— 只给 body 的话四边会露出一圈 html 的底色。
//
// ⚠️ 这里一律用普通字符串拼接，不用模板字符串嵌套 —— 协议里记过
//    "模板串里出现反引号会把整个串截断"的坑。

/** 图一页宽：三张卡 + 正文列（1500 = 72 内边距 + 876 卡 + 60 间距 + 492 正文） */
export const TAROT_WIDTH = 1500;
/** 图二页宽：与 v2 完全一致（1180 = 72 + 292 卡 + 40 间距 + 476 正文） */
export const LUCK_WIDTH = 1180;

export const CARD_W = 292;
const CARD_H = 511;              // 与素材 680x1190 同比例（4:7）
const CARD_GAP = 20;

const FONT = '"Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif';

/** HTML 转义。 */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/**
 * 整页 CSS（页宽是参数 —— 图一 1500 / 图二 1180 共用同一套样式）。
 *
 * 关键点：
 *   · html/body 背景必须**同时**显式给色 —— 截图时占位区域会露出底色，不能是透明/黑
 *   · 所有尺寸写死，不做响应式（出图要字节稳定，不能因窗口抖动而变宽变窄）
 *   · body 宽度必须与渲染层 setContentSize/capturePage 用的宽度**完全一致**，
 *     否则截图会多出一条（或切掉一条）—— 所以宽度跟 HTML 一起由 builder 返回
 */
export function pageCss(width) {
  const w = Math.max(320, Math.round(Number(width) || TAROT_WIDTH));
  return [
    '*{margin:0;padding:0;box-sizing:border-box}',
    'html,body{background:#0b1020;overflow:hidden}',
    'body{width:' + w + 'px;font-family:' + FONT + ';color:#e8e6f2;',
    'background:linear-gradient(160deg,#0b1020 0%,#141a33 55%,#1c1430 100%);padding:30px 36px 24px}',
    // 顶部
    '.top{display:flex;align-items:baseline;padding-bottom:13px;border-bottom:1px solid rgba(255,255,255,.14)}',
    '.brand{font-size:21px;font-weight:700;letter-spacing:.30em;color:#cfc9e6}',
    '.brand b{color:#b79ae0}',
    '.date{margin-left:auto;font-size:14px;color:#8f99c4;letter-spacing:.06em}',
    // 左栏：卡（v3 是三张）
    '.main{display:flex;gap:' + CARD_GAP + 'px;margin-top:20px;align-items:flex-start}',
    '.card{flex:0 0 ' + CARD_W + 'px;width:' + CARD_W + 'px}',
    '.card img{width:' + CARD_W + 'px;height:' + CARD_H + 'px;display:block;border-radius:10px;',
    'box-shadow:0 14px 38px rgba(0,0,0,.62),0 0 0 1px rgba(183,154,224,.16)}',
    '.cap{margin-top:9px;text-align:center;font-size:15px;color:#cfc9e6;letter-spacing:.04em}',
    '.cap b{color:#f0eeff;font-weight:600}',
    '.cap .tag{display:inline-block;margin-left:5px;padding:1px 8px;border-radius:20px;font-size:12px;color:#fff}',
    '.cap .kind{font-size:12px;color:#9a8cc4;margin-left:4px;letter-spacing:.06em}',
    '.tag.up{background:#3f8f74}',
    '.tag.rev{background:#b4673f}',
    // 正文列
    '.right{flex:1;min-width:0;padding-top:2px}',
    '.zh{font-size:16px;color:#8f99c4;letter-spacing:.24em;margin-bottom:6px}',
    '.name{font-size:34px;font-weight:700;color:#f0eeff;letter-spacing:.04em}',
    '.name .en{font-size:15px;font-weight:400;color:#8f99c4;letter-spacing:.06em;margin-left:9px}',
    '.sub{margin-top:7px;font-size:14px;color:#8f99c4;letter-spacing:.05em}',
    '.lucky{display:inline-block;margin-top:14px;padding:8px 24px;border-radius:28px;',
    'font-size:23px;font-weight:700;color:#fff;background:#7c5fb5;letter-spacing:.06em}',
    '.lucky small{font-size:14px;font-weight:400;opacity:.92;margin-left:9px;letter-spacing:0}',
    '.theme{margin-top:15px;font-size:23px;line-height:1.6;color:#f0eeff;font-weight:600}',
    '.block{margin-top:14px;padding:14px 17px;border-radius:10px;background:rgba(255,255,255,.06);',
    'border-left:3px solid #b79ae0;font-size:18px;line-height:1.62;color:#e8e6f2}',
    '.block .k{display:block;font-size:12.5px;letter-spacing:.22em;color:#8f99c4;margin-bottom:6px;font-weight:400}',
    '.block .ev{font-size:15.5px;color:#b3bce0;margin-bottom:5px}',
    // 宫廷块（只出现在图一）：金色左边线 = "另一维度的信息"
    '.block.court{border-left-color:#e0b46a;background:linear-gradient(92deg,rgba(224,180,106,.13),rgba(224,180,106,.03))}',
    '.block.court .k{color:#d9b273}',
    '.block .core{font-size:17px;color:#f0eeff;font-weight:600;margin-bottom:5px}',
    // 四领域（只出现在图一；图二不出）
    // 单列不折行：两列时每条 14 字要折成 2~3 行，读起来很碎（实测看过渲染图）。
    '.doms{margin-top:14px;padding-top:13px;border-top:1px solid rgba(255,255,255,.13)}',
    '.dom{font-size:14.5px;line-height:1.56;color:#cfc9e6;margin-top:5px}',
    '.dom:first-child{margin-top:0}',
    '.dom .lb{display:inline-block;width:40px;color:#9a8cc4;letter-spacing:.06em}',
    '.note{margin-top:14px;padding:14px 17px;border-radius:10px;',
    'background:linear-gradient(92deg,rgba(183,154,224,.16),rgba(183,154,224,.04));',
    'font-size:18px;line-height:1.7;color:#e8e6f2}',
    '.note .k{display:block;font-size:12.5px;letter-spacing:.22em;color:#a58ad0;margin-bottom:6px}',
    // 图二里的「宫廷指引」小段（v3 唯一新增的图二内容）
    '.court-tip{margin-top:11px;padding-top:10px;border-top:1px solid rgba(255,255,255,.16);',
    'font-size:16.5px;line-height:1.62;color:#dcd6ee}',
    '.court-tip .h{display:block;color:#e8c98f;font-size:15px;margin-bottom:4px}',
    '.field{margin-top:12px;font-size:16.5px;line-height:1.66;color:#cfc9e6}',
    '.field b{color:#f0eeff}',
    '.who{margin-top:14px;font-size:15.5px;color:#8f99c4}',
    '.who b{color:#f0eeff;font-weight:600}',
    // 页脚
    '.foot{margin-top:18px;padding-top:12px;border-top:1px solid rgba(255,255,255,.12);',
    'font-size:12.5px;color:#6f78a0;line-height:1.7;letter-spacing:.02em}'
  ].join('');
}

/** 一张牌的图 + 图注。 */
function cardHtml(file, label, reversed, extraTag) {
  const tag = reversed ? '<span class="tag rev">逆位</span>' : '<span class="tag up">正位</span>';
  return '<div class="card">'
    + '<img src="/asset/' + encodeURIComponent(file) + '" alt="">'
    + '<div class="cap"><b>' + esc(label) + '</b>' + tag + (extraTag ? ' ' + extraTag : '') + '</div>'
    + '</div>';
}

const FOOT = '塔罗为传统文化象征系统，结果仅供娱乐与自我觉察，不构成任何专业建议。';

/**
 * 图一：今日塔罗（三牌）。
 *
 * 内容 = 主题（大阿卡纳）+ 事件（小阿卡纳）+ 宫廷牌（另一维度）+ 四领域
 *      （爱情/事业/财运/健康，取大阿卡纳当前那位态）。
 * ⚠️ 这里刻意**不出「今日建议」**（用户明确要求：建议只属于 /抽签解读 那张图）。
 *    宫廷牌的 `advice` 字段同样**不在图一出现**，只用于图二的最终建议。
 *
 * @param {object} p
 * @param {object} p.major    data-major 的一张
 * @param {boolean} p.majorRev
 * @param {object} p.minor    data-minor 的一条
 * @param {boolean} p.minorRev
 * @param {object} p.court    data-court 的一张（v3 起必填）
 * @param {boolean} p.courtRev
 * @param {Array<{label:string,text:string}>} [p.domains] 四领域文案（约四行）
 * @param {string} p.dateText 右上角日期（YYYY-MM-DD 周X）
 * @param {string} [p.who]    抽牌人昵称
 * @returns {{html:string, width:number}} width 必须原样传给渲染层（见 pageCss 注释）
 */
export function buildTarotHtml({
  major, majorRev, minor, minorRev, court, courtRev, domains, dateText, who = ''
}) {
  if (!court || typeof court !== 'object') throw new Error('buildTarotHtml 缺少宫廷牌数据');
  const ms = majorRev ? major.rev : major.up;
  const ns = minorRev ? minor.rev : minor.up;
  const cs = courtRev ? court.rev : court.up;
  const field = String(minor.field || '');
  const dirCn = majorRev ? '逆位' : '正位';
  const zodiac = [major.zodiac, major.weekday].filter(Boolean).join(' · ');
  const courtSub = [court.suitCn, court.rankCn, court.dimension, court.stage]
    .filter(Boolean).join(' · ');

  return {
    width: TAROT_WIDTH,
    html: '<!doctype html><html><head><meta charset="utf-8"><style>' + pageCss(TAROT_WIDTH) + '</style></head><body>'
      + '<div class="top"><div class="brand">今 日 <b>塔 罗</b></div>'
      + '<div class="date">' + esc(dateText) + '</div></div>'

      + '<div class="main">'
      + cardHtml(majorAssetName(major.id, majorRev), major.cn || major.name, majorRev)
      + cardHtml(minorAssetName(minor, minorRev), minor.cn || minor.name, minorRev)
      + cardHtml(courtAssetName(court, courtRev), court.cn || court.name, courtRev,
        '<span class="kind">宫廷牌</span>')

      + '<div class="right">'
      + '<div class="zh">主 题</div>'
      + '<div class="name">' + esc(major.cn || major.name) + '<span class="en">' + esc(major.en || '') + '</span></div>'
      + '<div class="sub">' + esc(major.roman || '') + ' · ' + esc(dirCn) + (zodiac ? ' · ' + esc(zodiac) : '') + '</div>'
      + '<div class="theme">' + esc(ms.theme) + '</div>'

      + '<div class="block"><span class="k">事 件</span>'
      + '<div class="ev">' + esc(minor.cn || minor.name) + '（' + (minorRev ? '逆位' : '正位')
      + (field ? ' · ' + esc(field) : '') + '）</div>'
      + esc(ns.event) + '</div>'

      // 宫廷牌块：v3 新增。只出"含义"，不出 advice（图一不给建议）。
      + '<div class="block court"><span class="k">宫 廷 · ' + esc(courtSub) + '</span>'
      + '<div class="ev">' + esc(court.cn || court.name) + '（' + (courtRev ? '逆位' : '正位') + '）</div>'
      + '<div class="core">' + esc(cs.core || '') + '</div>'
      + esc(cs.meaning) + '</div>'

      // 四领域：只出现在**图一**（用户要求"补回事业/爱情，填右下角的空白"）。
      // 图二（抽签解读）刻意不出这一段 —— 那边是"针对主题+事件给一条建议"，领域只出抽到的那一个。
      + domainsHtml(domains)

      + (who ? '<div class="who">摸牌人：<b>' + esc(who) + '</b></div>' : '')
      + '</div>'
      + '</div>'

      + '<div class="foot">' + esc(FOOT) + '</div>'
      + '</body></html>'
  };
}

/**
 * 四领域小格子（爱情 / 事业 / 财运 / 健康）。
 * @param {Array<{label:string, text:string}>} domains 空数组则不渲染这一段
 */
function domainsHtml(domains) {
  const list = (Array.isArray(domains) ? domains : [])
    .filter((d) => d && String(d.text ?? '').trim());
  if (!list.length) return '';
  return '<div class="doms">' + list.map((d) => (
    '<div class="dom"><span class="lb">' + esc(d.label) + '</span>' + esc(d.text) + '</div>'
  )).join('') + '</div>';
}

/**
 * 图二：抽签解读。抽签图 + 签位 + 今日牌面 + 最终建议 +（只出抽到那一个领域）。
 *
 * v3 只改一处：最终建议块末尾追加「宫 廷 指 引」（宫廷牌名 + 核心词 + 含义 + 建议句）。
 * 版面尺寸、签位块、今日牌面块、领域行、解读者**都不动**。
 *
 * @param {object} p
 * @param {object} p.luck       data-luck 的一档
 * @param {string} p.luckAction 本次命中的 action 词（由种子派生）
 * @param {string} p.template   命中组合模板（已不含占位符的成品句）
 * @param {object} p.major
 * @param {boolean} p.majorRev
 * @param {object} p.minor
 * @param {boolean} p.minorRev
 * @param {object} p.court      data-court 的一张（v3 起必填）
 * @param {boolean} p.courtRev
 * @param {string} p.fieldText  该领域的解读文案（可能为空 = 综合）
 * @param {string} p.fieldLabel 领域名
 * @param {string} p.dateText
 * @param {string} [p.who]
 * @returns {{html:string, width:number}}
 */
export function buildLuckHtml({
  luck, luckAction, template, major, majorRev, minor, minorRev, court, courtRev,
  fieldText, fieldLabel, dateText, who = ''
}) {
  if (!court || typeof court !== 'object') throw new Error('buildLuckHtml 缺少宫廷牌数据');
  const ms = majorRev ? major.rev : major.up;
  const lesson = ms.lesson || ms.advice || '';
  const cs = courtRev ? court.rev : court.up;

  const fieldRow = fieldText
    ? '<div class="field"><b>' + esc(fieldLabel) + '：</b>' + esc(fieldText) + '</div>'
    : '';
  // 宫廷指引：只在图二出现（图一不给建议），是 v3 对图二的**唯一**改动
  const adviceText = String(cs.advice ?? '').trim();
  const courtTip = '<div class="court-tip">'
    + '<span class="h">宫 廷 指 引 · ' + esc(court.cn || court.name) + '（'
    + (courtRev ? '逆位' : '正位') + '）· ' + esc(cs.core || '') + '</span>'
    + esc(cs.meaning) + (adviceText ? '<br>' + esc(adviceText) : '')
    + '</div>';

  return {
    width: LUCK_WIDTH,
    html: '<!doctype html><html><head><meta charset="utf-8"><style>' + pageCss(LUCK_WIDTH) + '</style></head><body>'
      + '<div class="top"><div class="brand">抽 签 <b>解 读</b></div>'
      + '<div class="date">' + esc(dateText) + '</div></div>'

      + '<div class="main">'
      + cardHtml(luckAssetName(luck), luck.name, false)

      + '<div class="right">'
      + '<div class="zh">签 位</div>'
      + '<div class="lucky">' + esc(luck.name) + '<small>把握 ' + esc(String(luck.confidence)) + '% · '
      + esc(luck.tone) + '</small></div>'

      + '<div class="block"><span class="k">今 日 牌 面</span>'
      + esc(major.cn || major.name) + '（' + (majorRev ? '逆位' : '正位') + '）'
      + ' · ' + esc(ms.theme) + '<br>'
      + esc(minor.cn || minor.name) + '（' + (minorRev ? '逆位' : '正位') + ' · ' + esc(minor.field || '') + '）'
      + '</div>'

      + '<div class="note"><span class="k">最 终 建 议</span>'
      + esc(template)
      + (lesson ? '<br>' + esc(lesson) : '')
      + courtTip
      + '</div>'

      + fieldRow

      + (who ? '<div class="who">解读者：<b>' + esc(who) + '</b></div>' : '')
      + '</div>'
      + '</div>'

      + '<div class="foot">' + esc(FOOT) + '</div>'
      + '</body></html>'
  };
}

// ── 素材文件名（白名单式拼装；调用方仍会过一遍 assets 白名单，杜绝路径穿越）──
export function majorAssetName(cardId, reversed) {
  return 'jyt-major-' + String(cardId).padStart(2, '0') + '-' + (reversed ? 'r' : 'u') + '.jpg';
}
/** 小阿卡纳：花色 + 点数 + 正逆。正逆**显式传参**，别去读 minor.rev（那是数据里没有的临时标记）。 */
export function minorAssetName(minor, reversed) {
  return 'jyt-minor-' + minor.suit + '-' + minor.point + '-' + (reversed ? 'r' : 'u') + '.jpg';
}
/** 宫廷牌：花色 + 阶位 + 正逆（v3 新增）。 */
export function courtAssetName(court, reversed) {
  return 'jyt-court-' + court.suit + '-' + court.rank + '-' + (reversed ? 'r' : 'u') + '.jpg';
}
export function luckAssetName(luck) {
  return 'jyt-luck-' + String(luck.level) + '.jpg';
}
