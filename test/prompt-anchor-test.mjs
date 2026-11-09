// 提示词锚点（前缀缓存深化）单元测试：
// 用 README 式的 ABCDEFGHIJ 例子逐轮驱动 buildUserPrompt，验证——
//   1. 首轮建立锚点（reset：滑窗全量成为锚点，追加预算从这之后起算）
//   2. 后续轮**字节前缀不变**（记忆+已读信息原样复用），新内容进【新已读信息】，
//      已读部分可超过 historyCount（锚点 + 追加 ≤ 锚点 + maxExtraRead）
//   3. 追加超过 maxExtraRead → 并入已读基座（前缀变长但连续），不跳最新滑窗
//   4. 新群友加入 → 并入成员集，不跳窗口
//   5. 锚点头滚出存档窗口（隔太久没触发）→ 重置
//   6. 关闭开关 → 永远标准结构，锚点状态不写入
// 纯离线：隔离数据目录 + MemoryStore/ChatStore 真实例。
//
// ⚠️ 2026-09-26 修：第一版实现拿"滑动截尾后的窗口头部"比对锚点 —— 滑动必然
// 滚出锚点头 → 永远 reset，实际效果 = 滑动固定窗口（用户实测报告）。修复后
// 锚定轮不受 historyCount 截尾：锚点条目从全量已读池补齐，追加预算封顶总量。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-anchor-'));
process.env.QQ_AGENT_DATA_DIR = __testDataDir;

const { ChatStore } = await import('../src/store.js');
const { MemoryStore } = await import('../src/memory.js');
const { buildUserPrompt, resolvePromptAnchor } = await import('../src/prompt.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/config.js');

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.persona.botName = '测试机';
cfg.persona.roleText = '你是测试群里的测试机。';
cfg.sticker.enabled = false;   // 关掉表情包，减少无关段落
cfg.store.contextTier = 4;
cfg.store.historyCount = 5;    // 滑窗 5 条
cfg.store.promptAnchor = { enabled: true, maxExtraRead: 2, maxAnchorRead: 40 };   // 追加预算 2；基座上限放宽，避免短脚本提前重开
setRuntimeConfig(cfg);

const store = new ChatStore(0);
const memory = new MemoryStore();
const CHAT = 'group:123';

// 成员记忆：甲乙两人各一条（丙不发消息但记忆里有 —— 不该进前缀）
memory.append(CHAT, 'memberImpression', '甲的印象', { userId: 'uA', target: '甲' });
memory.append(CHAT, 'memberImpression', '乙的印象', { userId: 'uB', target: '乙' });
memory.append(CHAT, 'memberImpression', '丙的印象', { userId: 'uC', target: '丙' });

let mid = 1000;
let ts = Date.now() - 100000;
function pushRead(senderId, senderName, text) {
  const e = store.appendIncoming(CHAT, { mid: ++mid, ts: ++ts, senderId, senderName, text });
  store.markEntryRead(CHAT, e.id);
  return e;
}
function pushUnread(senderId, senderName, text) {
  return store.appendIncoming(CHAT, { mid: ++mid, ts: ++ts, senderId, senderName, text });
}

// 一次"运行"：trigger = 未读触发批；返回用户提示与会话（含锚点状态）
function runOnce(triggerEntries, prevAnchor) {
  const session = {};
  const up = buildUserPrompt({
    chatKey: CHAT, kind: 'group', chatId: '123', chatName: '测试群',
    triggerEntries, store, memory, stickerEntries: [],
    selfNickname: '测试机', runSeq: 1, moreUnreadDuringRun: false, proactive: false,
    contextLimit: cfg.store.historyCount,
    promptAnchor: { prev: prevAnchor },
    session
  });
  return { up, session };
}
// 前缀 = 从【记忆】到【未读信息】之前的字节。锚定轮的【新已读信息】属于
// 追加部分（缓存前缀之后的字节），比较时剥掉 —— 前缀定义 = 记忆+已读信息。
// ⚠️ 用完整段头定位：引导说明正文里引用了"【已读信息】【未读信息】"字样，
// 浅 indexOf 会提前命中正文行，导致"未读在记忆之前"的假定位。
const prefixOf = (up) => {
  const s = up.indexOf('【记忆】\n');
  const e = up.indexOf('【未读信息】以下是');
  assert.ok(s >= 0 && e > s, '段落定位失败（缺记忆/未读信息段）');
  let seg = up.slice(s, e);
  const extra = seg.indexOf('【新已读信息】以下是');
  if (extra >= 0) seg = seg.slice(0, extra);
  return seg.replace(/\n+$/, '\n');   // 段间空行数不参与比较（reset 轮无追加段时结尾少一个空行）
};
const hasMsg = (up, x) => up.includes(`：${x}`);

// 聊天记录 A~F（甲乙交替，均已读）
'ABCDEF'.split('').forEach((t, i) => pushRead(i % 2 ? 'uB' : 'uA', i % 2 ? '乙' : '甲', t));

// ═══ 轮 1：甲发 G（触发）。已读窗口 BCDEF（5 条滑窗）═══
const G = pushUnread('uA', '甲', 'G');
const r1 = runOnce([G], null);
assert.equal(r1.session.promptAnchorMode, 'reset', '首轮应为 reset（建立锚点）');
assert.ok(r1.up.includes('【已读信息】'), '首轮应有已读信息段');
assert.ok(!r1.up.includes('【新已读信息】以下是'), '首轮不应有新已读信息段');
assert.ok(['B','C','D','E','F'].every((x) => hasMsg(r1.up, x)) && !hasMsg(r1.up, 'A'), '首轮滑窗 = BCDEF（historyCount=5）');
// 锚点 = 本轮滑窗全部 5 条（BCDEF）—— 下一轮锚定复用它们，追加预算从 F 之后起算
assert.equal(r1.session.promptAnchorState.readIds.length, 5, '锚点 = 全部滑窗条目');
assert.ok(r1.session.promptAnchorState.memberIds.includes('uA') && r1.session.promptAnchorState.memberIds.includes('uB'), '锚点成员集 = 甲乙');
const anchor1 = r1.session.promptAnchorState;
const prefix1 = prefixOf(r1.up);

// ═══ 轮 2：乙发 H（紧接触发，G 已沉淀为已读）═══
const H = pushUnread('uB', '乙', 'H');
const r2 = runOnce([H], anchor1);
assert.equal(r2.session.promptAnchorMode, 'anchored', '连续触发第二轮应锚定（核心场景）');
// 【已读信息】= 锚点 BCDEF 原样（5 条，不受 historyCount 截尾）。
// ⚠️ 完整段头定位（'【已读信息】以下是'）—— 引导说明正文里有裸的
// 【已读信息】字样，浅 indexOf 会切到正文行上。
const readSec2 = r2.up.slice(r2.up.indexOf('【已读信息】以下是'), r2.up.indexOf('【新已读信息】以下是'));
assert.ok(['B','C','D','E','F'].every((x) => hasMsg(readSec2, x)), '锚定轮已读信息 = 锚点 BCDEF');
assert.ok(!hasMsg(readSec2, 'G'), 'G 不在已读信息（它是追加条目）');
// 【新已读信息】= G（锚点之后新沉淀的 1 条，≤ 预算 2）
const extraSec2 = r2.up.slice(r2.up.indexOf('【新已读信息】以下是'), r2.up.indexOf('【未读信息】以下是'));
assert.ok(hasMsg(extraSec2, 'G'), 'G 应进新已读信息');
// 字节前缀（记忆+已读信息）与轮 1 完全一致 —— 缓存命中的核心断言
assert.equal(prefixOf(r2.up), prefix1, '锚定轮前缀必须与上轮逐字节一致');
// 模型实际看过的已读条数 = 6（5 锚点 + 1 追加）→ offset 补偿口径
assert.equal(r2.session.pastStateCount, 6, '锚定轮 pastStateCount = 锚点+追加');
const anchor2 = r2.session.promptAnchorState;

// ═══ 轮 3：甲发 I（继续连续触发；追加将达到预算上限）═══
const I = pushUnread('uA', '甲', 'I');
const r3 = runOnce([I], anchor2);
assert.equal(r3.session.promptAnchorMode, 'anchored', '追加 = 预算上限（2 条：G、H）仍应锚定');
assert.equal(prefixOf(r3.up), prefix1, '追加到预算上限时前缀仍逐字节一致');
const extraSec3 = r3.up.slice(r3.up.indexOf('【新已读信息】以下是'), r3.up.indexOf('【未读信息】以下是'));
assert.ok(hasMsg(extraSec3, 'G') && hasMsg(extraSec3, 'H'), '新已读 = G、H（两条追加）');
assert.equal(r3.session.pastStateCount, 7, '锚定轮 pastStateCount = 5 锚点 + 2 追加');
const anchor3 = r3.session.promptAnchorState;

// ═══ 轮 4：乙发 J（追加 G/H/I 共 3 条，超出预算 2 → 并入基座）═══
const J = pushUnread('uB', '乙', 'J');
const r4 = runOnce([J], anchor3);
assert.equal(r4.session.promptAnchorMode, 'anchored', '超出追加预算 → 并入基座，不跳窗口');
assert.ok(!r4.up.includes('【新已读信息】以下是'), '并入轮不再单挂新已读段');
const readSec4 = r4.up.slice(r4.up.indexOf('【已读信息】以下是'), r4.up.indexOf('【未读信息】以下是'));
assert.ok(['B','C','D','E','F','G','H','I'].every((x) => hasMsg(readSec4, x)), '并入后已读 = 旧基座 BCDEF + GHI');
assert.equal(r4.session.promptAnchorState.readIds.length, 8, '新基座 = 5 + 3');
assert.equal(r4.session.pastStateCount, 8, '并入轮 pastStateCount = 整段基座');
const prefix4 = prefixOf(r4.up);
assert.ok(prefix4.startsWith(prefix1.trimEnd()) || prefix4.includes(prefix1.slice(prefix1.indexOf('【已读信息】'))), '并入后的已读仍以旧基座开头');
const anchor4 = r4.session.promptAnchorState;

// ═══ 轮 5：甲发 K（并入后的下一轮，J 单独挂在新已读，前缀保持）═══
const K = pushUnread('uA', '甲', 'K');
const r5 = runOnce([K], anchor4);
assert.equal(r5.session.promptAnchorMode, 'anchored', '并入后的下一轮继续锚定');
assert.equal(prefixOf(r5.up), prefix4, '基座未再增长时前缀逐字节一致');
assert.ok(r5.up.includes('【新已读信息】以下是') && hasMsg(r5.up.slice(r5.up.indexOf('【新已读信息】以下是')), 'J'), 'J 挂在新已读');

// ═══ 场景 F：新群友加入话题 → 并入成员集，不跳窗口 ═══
const L = pushUnread('uA', '甲', 'L');
const rL = runOnce([L], r5.session.promptAnchorState);
assert.equal(rL.session.promptAnchorMode, 'anchored', '甲继续发言应保持锚定');
const anchorL = rL.session.promptAnchorState;
const M = pushUnread('uC', '丙', 'M');   // 丙首次发言（记忆里有印象但不在锚点成员集）
const rM = runOnce([M], anchorL);
assert.equal(rM.session.promptAnchorMode, 'anchored', '新群友加入 → 并入，不跳窗口');
assert.ok(rM.session.promptAnchorState.memberIds.includes('uC'), '丙进入锚点成员集');
assert.ok(rM.up.includes('丙的印象'), '丙的印象进入记忆段');
const N = pushUnread('uC', '丙', 'N');
const rN = runOnce([N], rM.session.promptAnchorState);
assert.equal(rN.session.promptAnchorMode, 'anchored', '丙成为"老人"后继续锚定');

// ═══ 场景 G：锚点头滚出存档窗口（太久没触发）→ 重置 ═══
{
  // 纯函数级：锚点第一条不在全量已读池里 → reset
  const r = resolvePromptAnchor({
    readMessages: [{ id: 999, senderId: 'uA', text: 'x' }],
    allReadMessages: [{ id: 998, senderId: 'uA', text: 'y' }, { id: 999, senderId: 'uA', text: 'x' }],
    prevAnchor: { readIds: [1, 998], readCount: 2, memberIds: ['uA'] },
    maxExtraRead: 2, newUserIds: new Set(['uA'])
  });
  assert.equal(r.mode, 'reset', '锚点头不在已读池 → 重置');
  const grown = resolvePromptAnchor({
    readMessages: [{ id: 3, senderId: 'uA', text: 'c', ts: 3 }],
    allReadMessages: [
      { id: 1, senderId: 'uA', text: 'a', ts: 1 },
      { id: 2, senderId: 'uA', text: 'b', ts: 2 },
      { id: 3, senderId: 'uA', text: 'c', ts: 3 }
    ],
    prevAnchor: { readIds: [1], readCount: 1, memberIds: ['uA'] },
    maxExtraRead: 0, maxAnchorRead: 2, newUserIds: new Set()
  });
  assert.equal(grown.mode, 'reset', '基座超过 maxAnchorRead → 重开滑窗');
}

// ═══ 场景 H：关闭开关 → 永远标准结构、无锚点状态 ═══
{
  cfg.store.promptAnchor.enabled = false;
  setRuntimeConfig(cfg);
  const s = {};
  const up = buildUserPrompt({
    chatKey: CHAT, kind: 'group', chatId: '123', chatName: '测试群',
    triggerEntries: [N], store, memory, stickerEntries: [],
    selfNickname: '测试机', runSeq: 1, moreUnreadDuringRun: false, proactive: false,
    contextLimit: 5, promptAnchor: { prev: anchor1 }, session: s
  });
  assert.equal(s.promptAnchorMode, 'none', '关闭开关 → none');
  assert.equal(s.promptAnchorState, null, '关闭开关 → 不写锚点状态');
  assert.ok(!up.includes('【新已读信息】以下是') && !up.includes('【新加入成员】以下是'), '关闭开关 → 无新段');
  assert.ok(up.includes('【记忆】') && up.includes('【已读信息】'), '标准结构仍在');
  // 标准结构滑窗 = 最近 5 条已读（IJKLM）
  const readSec = up.slice(up.indexOf('【已读信息】以下是'), up.indexOf('【未读信息】以下是'));
  assert.ok(['I','J','K','L','M'].every((x) => hasMsg(readSec, x)), '关闭开关 → 滑窗口径');
}

try { fs.rmSync(__testDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
console.log('✓ 提示词锚点自测全部通过');
