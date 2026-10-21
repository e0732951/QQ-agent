// agent-growth 自测：不启动 QQ Agent 也能跑
// 用法：node self-test.mjs   （在本插件目录内执行）
// 说明：QQ_AGENT_DATA_DIR 指到临时目录，绝不碰真实数据。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpData = path.join(__dirname, 'self-test-data');
fs.rmSync(tmpData, { recursive: true, force: true });
fs.mkdirSync(tmpData, { recursive: true });
process.env.QQ_AGENT_DATA_DIR = tmpData;

const t = Date.now();
// 预置一个临时宿主配置：验证「爸爸QQ自动读取鲸鱼娘插件设置」
fs.writeFileSync(path.join(tmpData, 'config.json'), JSON.stringify({
  api: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'test-key', model: 'test-model' },
  skills: { 'whale-daughter-persona': { enabled: true, settings: { ownerUserIds: '12345' } } }
}, null, 2));

const mod = await import(`./index.js?t=${t}`);
const I = mod._internals;

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.error(`  ✘ ${name}`); }
}

console.log('1) 年龄计算');
const fakeProfile = { name: '小鲸鱼', gender: '女', birthday: t - 8 * 30 * 86400000 };
ok('8个"月"前出生 → 8 岁', I.calcAgeAt(fakeProfile, t) === 8);
ok('出生当天 → 0 岁', I.calcAgeAt({ birthday: t }, t) === 0);
const info = I.birthdayInfo({ ...fakeProfile, birthday: t - 15 * 86400000 }, t);
ok('半个月前出生 → 距下次生日约15天', Math.abs(info.daysLeft - 15) <= 1);
const sameDayLastYear = new Date(new Date(t).getFullYear() - 1, new Date(t).getMonth(), new Date(t).getDate()).getTime();
ok('生日当天 birthdayToday', I.birthdayInfo({ birthday: sameDayLastYear }, t).birthdayToday === true);

console.log('2) 模型输出 JSON 抽取');
ok('纯 JSON', I.extractJson('{"stageTitle":"a","newPrompt":"b","memorySummary":"c"}').newPrompt === 'b');
ok('代码块包裹', I.extractJson('```json\n{"newPrompt":"x"}\n```').newPrompt === 'x');
ok('前后杂文', I.extractJson('好的，这是结果：{"newPrompt":"y"} 请查收').newPrompt === 'y');
ok('尾逗号容错', I.extractJson('{"newPrompt":"z","memorySummary":"w",}').newPrompt === 'z');

console.log('3) 爸爸 QQ 自动读取（鲸鱼娘插件）');
const owners = I.owners();
ok('自动读到鲸鱼娘插件设置的爸爸QQ', owners.length === 1 && owners[0] === '12345');

console.log('4) promptSections（空数据时优雅返回）');
const sections = mod.promptSections({ chatKey: 'test' });
ok('未建档时返回空数组（或建档后返回片段）', Array.isArray(sections));

console.log('5) 档案页渲染');
const p = { name: '小鲸鱼', gender: '女', birthday: t - 8 * 30 * 86400000, createdAt: t };
fs.mkdirSync(path.join(tmpData, 'growth'), { recursive: true });
fs.writeFileSync(path.join(tmpData, 'growth', 'profile.json'), JSON.stringify(p));
const archive = I.renderArchive();
ok('档案页已生成', archive && fs.existsSync(archive));

// 清理
fs.rmSync(tmpData, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
