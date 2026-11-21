/**
 * 合并转发的评论篇幅跟着提炼结果走。
 * 先看字，也看图里实际在说什么，提炼完有多长，评论就写多长。
 */

const RULE = [
  '别人发来合并转发或聊天记录时，评论篇幅跟着你提炼出来的结果走，这条盖过平时「1～10 个字」。',
  '先读完转发里的字。里面有 [图片] 时，用这条转发消息自己的 #数字 调 get_message_images，把画面和上面的字也看进去。',
  '然后把文字和图片提炼成实际在说的事。名字、套话、[图片] 这两个字不算内容。装饰图、表情不要注水。',
  '评论的总字数跟着这段提炼：提炼有多长，评论就写多长，上下差一截可以。提炼只有一句就回一句；提炼写开了，评论也写开，拆成几条短消息，总字数不要明显短于或长过提炼。',
  '还是 [合并转发聊天记录] 这种占位符时，先 read_forward 看完再提炼。',
  '口吻仍是平时说话。不要逐条复读，不要写「综上所述」。'
].join('');

function enabled() {
  return globalThis.__forwardReply?.cfgOf?.()?.enabled !== false;
}

function replyHint(text, declaredCount = 0, imageCount = 0) {
  const body = String(text || '').replace(/^\[合并转发 共\d+条\]\s*/, '');
  const pictures = imageCount || (body.match(/\[图片\]/g) || []).length;
  const lines = body.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('…（还有') && s !== '[图片]');
  const count = declaredCount || lines.length || 1;
  const look = pictures
    ? `里面有 ${pictures} 张图。先用这条转发消息的 #数字 调 get_message_images，把画面和上面的字看完。`
    : '这条里面没有图，只提炼文字。';
  return `【评论篇幅】转发约 ${count} 条。${look} 把文字和图片提炼成实际在说的事，名字和 [图片] 占位不算。评论总字数跟着提炼结果：提炼多长，评论就写多长。一句提炼就一条短回复；提炼长了就拆成几条短消息，总字数不要明显短于或超过提炼。不要按原文流水账的字数写，不要复读全文。`;
}

function annotatePrompt(text) {
  if (!text) return text;
  let out = text.replace(/\[合并转发 共(\d+)条\]([\s\S]*?)(?=\n\[\d{2}-\d{2} \d{2}:\d{2}\]|\n【|$)/g, (block, count) => {
    if (block.includes('【评论篇幅】')) return block;
    return `${block}\n${replyHint(block, Number(count) || 0)}`;
  });
  if (!/\[合并转发 共\d+条\]/.test(out) && /\[合并转发聊天记录\]|\[转发消息/.test(out) && !out.includes('这条转发还没展开')) {
    out += '\n【评论篇幅】这条转发还没展开。先用 read_forward 看完，有图再看图，提炼之后评论写得和提炼一样长。';
  }
  return out;
}

function annotateTool(result) {
  if (!result || result.isError || typeof result.content !== 'string') return;
  let data;
  try { data = JSON.parse(result.content); } catch { return; }
  const text = String(data?.text || '');
  if (!text || text.includes('【评论篇幅】')) return;
  const count = Number(String(text).match(/^\[合并转发 共(\d+)条\]/)?.[1] || 0);
  const images = Number(data.images) || (text.match(/\[图片\]/g) || []).length;
  data.replyLength = replyHint(text, count, images);
  result.content = JSON.stringify(data, null, 1);
}

export function promptSections() {
  if (!enabled()) return [];
  return [{ title: '转发评论篇幅', content: RULE, priority: 80 }];
}

export function setup(api) {
  globalThis.__forwardReply = {
    cfgOf: typeof api.config === 'function' ? api.config : () => ({})
  };
}

export function available() {
  return enabled() ? { ok: true } : { ok: false, reason: '转发评论篇幅已关闭' };
}

export const hooks = {
  'before-llm-messages': async ({ messages }) => {
    if (!enabled() || !Array.isArray(messages)) return;
    for (const message of messages) {
      if (message?.role !== 'user' || typeof message.content !== 'string') continue;
      message.content = annotatePrompt(message.content);
    }
  },
  'after-tool': async ({ toolName, result }) => {
    if (!enabled()) return;
    if (!String(toolName || '').includes('read_forward')) return;
    annotateTool(result);
  }
};
