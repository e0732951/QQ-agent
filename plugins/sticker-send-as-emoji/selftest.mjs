// 自测：验证表情先入库、再按表情发送，且不误伤发图/发文字。
// 跑法（在 resources/app 下）：node plugins/sticker-send-as-emoji/selftest.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
//
// 做法：不真连协议端 —— 造一个 OneBotClient 实例，把它的 call() 换成截获器，
// 直接检查最终发给协议端的分段内容。
import { OneBotClient } from '../../src/onebot.js';

let pass = 0, fail = 0;
const check = (n, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; console.log(`  PASS ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       期望 ${E}\n       实际 ${A}`); }
};

const plugin = await import('./index.js');

// 造实例 + 截获最终动作
function makeClient() {
  const c = new OneBotClient({
    wsUrl: 'ws://127.0.0.1:1/', httpUrl: 'http://127.0.0.1:1', accessToken: '', httpToken: '',
    onEvent: () => {}
  });
  c.captured = null;
  c.calls = [];
  c.call = async (action, params) => {
    c.calls.push({ action, params });
    c.captured = { action, params };
    return { message_id: 7 };
  };
  return c;
}
const imgSeg = (c) => (c.captured?.params?.message || []).find((s) => s?.type === 'image');

let config = { enabled: true, subType: 1, debug: false };
const logs = [];
function api() {
  return {
    config: () => config,
    log: (...a) => logs.push(a.join(' ')),
    warn: (...a) => logs.push('WARN ' + a.join(' '))
  };
}

console.log('\n[1] 未启用插件时：发表情不带 sub_type（=旧行为，大图）');
{
  const c = makeClient();
  await c.sendSticker('group', 123, 'http://x/y.jpg');
  check('图片段无 sub_type', imgSeg(c)?.data?.sub_type, undefined);
}

console.log('\n[2] 启用后：发表情带上 sub_type=1');
{
  plugin.setup(api());
  const c = makeClient();
  await c.sendSticker('group', 123, 'http://x/y.jpg');
  check('图片段 sub_type', imgSeg(c)?.data?.sub_type, 1);
  check('发送前先存入 QQ 表情', c.calls[0]?.action, 'add_custom_face');
  check('入库地址保持原样', c.calls[0]?.params?.file, 'http://x/y.jpg');
  check('图地址未被改动', imgSeg(c)?.data?.file, 'http://x/y.jpg');
  check('动作仍是群发消息', c.captured.action, 'send_group_msg');
  check('群号正确', c.captured.params.group_id, 123);
}

console.log('\n[2b] 本地 file:/// 转成路径入库，同一张只入库一次');
{
  const faceFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/sticker-send-as-emoji/faces.json');
  const existed = fs.existsSync(faceFile);
  const before = existed ? fs.readFileSync(faceFile, 'utf8') : '';
  const c = makeClient();
  c.call = async (action, params) => {
    c.calls.push({ action, params });
    c.captured = { action, params };
    if (action === 'add_custom_face') return { emoji_id: 'selftest-emoji' };
    return { message_id: 7 };
  };
  await c.sendSticker('group', 123, 'file:///D:/pack/a.jpg');
  check('file协议转成本地路径', c.calls[0]?.params?.file, 'D:\\pack\\a.jpg');
  check('发出去仍是原地址', imgSeg(c)?.data?.file, 'file:///D:/pack/a.jpg');
  await c.sendSticker('group', 123, 'file:///D:/pack/a.jpg');
  check('同一张只入库一次', c.calls.filter((x) => x.action === 'add_custom_face').length, 1);
  if (existed) fs.writeFileSync(faceFile, before);
  else fs.rmSync(faceFile, { force: true });
}

console.log('\n[3] 不影响发图（sendImage 必须仍是普通图片）');
{
  const c = makeClient();
  await c.sendImage('private', 456, 'http://x/pic.png');
  check('sendImage 的图片段无 sub_type', imgSeg(c)?.data?.sub_type, undefined);
  check('普通发图不入库', c.calls.some((x) => x.action === 'add_custom_face'), false);
  check('动作是私聊发消息', c.captured.action, 'send_private_msg');
}

console.log('\n[4] 不影响发文字');
{
  const c = makeClient();
  await c.sendText('group', 123, '你好');
  check('只有 text 段', (c.captured.params.message || []).map((s) => s.type), ['text']);
  check('文字内容正确', c.captured.params.message[0].data.text, '你好');
}

console.log('\n[5] 带引用/艾特时，reply 与 at 段不受影响');
{
  const c = makeClient();
  await c.sendSticker('group', 123, 'http://x/y.jpg', { replyToMessageId: -84045347, atUserId: '10001' });
  const types = (c.captured.params.message || []).map((s) => s.type);
  check('分段顺序', types, ['reply', 'at', 'image']);
  check('reply id 保留（负数消息 id）', c.captured.params.message[0].data.id, '-84045347');
  check('at 目标保留', c.captured.params.message[1].data.qq, '10001');
  check('图片段仍被标记', imgSeg(c)?.data?.sub_type, 1);
}

console.log('\n[6] 关闭开关后立刻恢复旧行为');
{
  config = { enabled: false, subType: 1, debug: false };
  const c = makeClient();
  await c.sendSticker('group', 123, 'http://x/y.jpg');
  check('关闭后无 sub_type', imgSeg(c)?.data?.sub_type, undefined);
  check('关闭后不入库', c.calls.some((x) => x.action === 'add_custom_face'), false);
  config = { enabled: true, subType: 1, debug: false };
}

console.log('\n[7] subType 可配置（便于协议端差异时调整）');
{
  config = { enabled: true, subType: 3, debug: false };
  const c = makeClient();
  await c.sendSticker('group', 123, 'http://x/y.jpg');
  check('使用配置值', imgSeg(c)?.data?.sub_type, 3);
  config = { enabled: true, subType: 1, debug: false };
}

console.log('\n[8] 已带 sub_type 的分段不被覆盖');
{
  const c = makeClient();
  // 模拟调用方自己指定过 sub_type（走 sendSegments 直发）
  c[Symbol.for('qq-agent.sticker-send-as-emoji.inSticker')] = true;
  await c.sendSegments('group', 123, [{ type: 'image', data: { file: 'x.jpg', sub_type: 9 } }]);
  c[Symbol.for('qq-agent.sticker-send-as-emoji.inSticker')] = false;
  check('保留调用方给的值', imgSeg(c)?.data?.sub_type, 9);
}

console.log('\n[9] 异常不阻断发送（分段结构畸形也照发）');
{
  const c = makeClient();
  c[Symbol.for('qq-agent.sticker-send-as-emoji.inSticker')] = true;
  let threw = null;
  try {
    await c.sendSegments('group', 123, [null, { type: 'image' }, { type: 'image', data: null }, { type: 'text', data: { text: 'x' } }]);
  } catch (e) { threw = e?.message ?? String(e); }
  c[Symbol.for('qq-agent.sticker-send-as-emoji.inSticker')] = false;
  check('没有抛错', threw, null);
  check('动作仍然发出', c.captured.action, 'send_group_msg');
}

console.log('\n[10] 幂等：重复 setup 不会把补丁套娃');
{
  plugin.setup(api());
  plugin.setup(api());
  const c = makeClient();
  await c.sendSticker('group', 123, 'http://x/y.jpg');
  check('sub_type 仍是 1（不是被叠成别的值）', imgSeg(c)?.data?.sub_type, 1);
  const st = plugin.providers['sticker-send-as-emoji.status']();
  check('状态报告补丁已装', st.patchInstalled, true);
}

console.log('\n[11] dispose 后彻底还原原型（不留副作用）');
{
  plugin.dispose();
  const c = makeClient();
  await c.sendSticker('group', 123, 'http://x/y.jpg');
  check('还原后发表情不带 sub_type', imgSeg(c)?.data?.sub_type, undefined);
  check('状态报告补丁已卸', plugin.providers['sticker-send-as-emoji.status']().patchInstalled, false);
  plugin.setup(api());   // 收尾复原，避免干扰真实运行
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
