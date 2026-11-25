// 群里 QQ 小程序转发的 B站视频。
// 入库时只认出 BV 号和标题；真正下载发生在 read_video。
// 下到本地文件后，交给现有的视频读取（当前是 length-frame-reader 抽帧）。

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DATA_DIR } from '../../src/config.js';

const G = (globalThis.__bilibiliQqVideo = globalThis.__bilibiliQqVideo || { cfgOf: null });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BILI_APPIDS = new Set(['1109937557']);

function settings() {
  let c = {};
  try { c = (typeof G.cfgOf === 'function' ? G.cfgOf() : null) || {}; } catch { c = {}; }
  const num = (k, d, lo, hi) => {
    const n = Number(c[k]);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
  };
  return {
    cookie: cookieHeader(c.cookie),
    maxMinutes: num('maxMinutes', 15, 1, 120),
    maxMb: num('maxMb', 120, 8, 500)
  };
}

function cookieHeader(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.includes('=') ? s : `SESSDATA=${s}`;
}

function cacheDir() {
  const dir = path.join(os.tmpdir(), 'qq-agent-bilibili');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const NOTE_FILE = path.join(DATA_DIR, 'bilibili-qq-video', 'descriptions.json');
let pending = null;
let lastFetch = null;

function noteKeys({ bvid = '', aid = '', pageUrl = '' } = {}) {
  const keys = [];
  const bv = String(bvid || '').trim();
  const av = String(aid || '').trim();
  const url = String(pageUrl || '').trim();
  if (bv) keys.push(bv);
  if (av) keys.push(av.startsWith('av') ? av : `av${av}`);
  if (url) keys.push(`url_${crypto.createHash('sha1').update(url).digest('hex').slice(0, 16)}`);
  return [...new Set(keys)];
}

function loadNotes() {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(NOTE_FILE, 'utf8')); } catch { data = {}; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  let changed = false;
  for (const [key, item] of Object.entries(data)) {
    if (!item || typeof item.text !== 'string' || !item.text.trim()) {
      delete data[key];
      changed = true;
    }
  }
  if (changed) writeNotes(data);
  return data;
}

function writeNotes(data) {
  fs.mkdirSync(path.dirname(NOTE_FILE), { recursive: true });
  const tmp = `${NOTE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(tmp, NOTE_FILE);
}

function findNote(keys) {
  const data = loadNotes();
  for (const key of keys) {
    if (key && data[key]?.text) return data[key];
  }
  return null;
}

function remember(keys, title, text) {
  const body = String(text || '').trim().slice(0, 800);
  const ids = [...new Set(keys.filter(Boolean))];
  if (!body || !ids.length) return null;
  const data = loadNotes();
  const item = { title: String(title || '').slice(0, 80), text: body, at: Date.now() };
  for (const key of ids) data[key] = item;
  writeNotes(data);
  return item;
}

function armPending(keys, title) {
  const ids = [...new Set(keys.filter(Boolean))];
  if (!ids.length) return;
  pending = { keys: ids, title: String(title || '').slice(0, 80), at: Date.now() };
}

function currentPending() {
  if (!pending) return null;
  if (Date.now() - pending.at > 10 * 60 * 1000) { pending = null; return null; }
  return pending;
}

function savePending(text, overwrite) {
  const item = currentPending();
  if (!item) return null;
  const body = String(text || '').trim();
  if (!body) return null;
  if (!overwrite && body.length < 20) return null;
  if (!overwrite && findNote(item.keys)) return findNote(item.keys);
  const saved = remember(item.keys, item.title, body);
  if (overwrite) pending = null;
  return saved;
}

function removeWatchedFile(filePath) {
  const dir = path.resolve(cacheDir());
  const target = path.resolve(String(filePath || ''));
  if (!target.startsWith(dir + path.sep)) return;
  const stem = path.parse(target).name;
  for (const name of fs.readdirSync(dir)) {
    if (name !== path.basename(target) && !name.startsWith(`${stem}.`)) continue;
    if (!/\.(mp4|flv|m4s|jpg|jpeg|png|webp)$/i.test(name)) continue;
    try { fs.unlinkSync(path.join(dir, name)); } catch { /* 已经没了 */ }
  }
}

function sweepLeftovers() {
  const dir = cacheDir();
  const old = Date.now() - 60 * 60 * 1000;
  for (const name of fs.readdirSync(dir)) {
    if (!/\.(mp4|flv|m4s|m4a|jpg|jpeg|png|webp)$/i.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < old) fs.unlinkSync(file);
    } catch { /* ignore */ }
  }
}

/** 从 QQ 的 json / xml 卡片里认出 B站视频。认不出就返回 null。 */
export function parseBilibiliCard(segment) {
  const raw = segment?.data?.data ?? segment?.data?.content ?? segment?.data ?? '';
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw || '');
  if (!text || text.length > 200000) return null;
  let obj = null;
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { obj = JSON.parse(trimmed); } catch { obj = null; }
  }
  const detail = obj?.meta?.detail_1 || obj?.meta?.detail || {};
  const news = obj?.meta?.news || {};
  const appid = String(detail.appid || detail.appId || '');
  const title = String(detail.title || news.title || obj?.prompt || '')
    .replace(/^\[QQ小程序\]/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const flat = text.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
  const urls = [...flat.matchAll(/https?:\/\/[^\s"'<>\\]+/g)].map((m) => m[0]);
  const bvid = (flat.match(/BV[0-9A-Za-z]{10}/) || [])[0] || '';
  const aid = (flat.match(/\bav(\d{3,})\b/i) || [])[1] || '';
  const pageUrl = urls.find((u) => /bilibili\.com|b23\.tv/i.test(u)) || '';
  const videoLink = bvid || aid || /bilibili\.com\/video|b23\.tv/i.test(pageUrl);
  const knownApp = BILI_APPIDS.has(appid) && Boolean(pageUrl || bvid || aid);
  if (!videoLink && !knownApp) return null;
  if (/live\.bilibili\.com/i.test(pageUrl) && !bvid && !aid) return null;
  return { ok: true, title, bvid, aid, pageUrl, appid };
}

function biliHeaders(cookie) {
  const headers = {
    'user-agent': UA,
    referer: 'https://www.bilibili.com/',
    origin: 'https://www.bilibili.com',
    accept: 'application/json, text/plain, */*'
  };
  if (cookie) headers.cookie = cookie;
  return headers;
}

let guestSession = null;

async function readJson(url, { method = 'GET', cookie = '' } = {}) {
  const res = await fetch(url, { method, headers: biliHeaders(cookie), redirect: 'follow' });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok || !body) throw new Error(`B站接口 HTTP ${res.status}`);
  return body;
}

/** 匿名 buvid + bili_ticket。没有这组 Cookie，播放接口会直接 412。 */
async function guestCookie() {
  const user = settings().cookie;
  if (guestSession && guestSession.user === user && Date.now() < guestSession.until) return guestSession.cookie;
  const spi = await readJson('https://api.bilibili.com/x/frontend/finger/spi');
  if (spi.code !== 0 || !spi.data?.b_3) throw new Error(spi.message || '拿不到 B站匿名标识');
  const ts = Math.floor(Date.now() / 1000);
  const hexsign = crypto.createHmac('sha256', 'XgwSnGZ1p').update(`ts${ts}`).digest('hex');
  const params = new URLSearchParams({ key_id: 'ec02', hexsign, 'context[ts]': String(ts), csrf: '' });
  const ticket = await readJson(
    `https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket?${params}`,
    { method: 'POST' }
  );
  if (ticket.code !== 0 || !ticket.data?.ticket) throw new Error(ticket.message || '拿不到 B站票据');
  const parts = [
    `buvid3=${spi.data.b_3}`,
    `buvid4=${spi.data.b_4 || ''}`,
    `b_nut=${ts}`,
    `bili_ticket=${ticket.data.ticket}`,
    `bili_ticket_expires=${Number(ticket.data.created_at) + Number(ticket.data.ttl || 0)}`
  ];
  if (user) parts.push(user);
  guestSession = { user, cookie: parts.join('; '), until: Date.now() + 12 * 3600 * 1000 };
  return guestSession.cookie;
}

async function getJson(url) {
  const body = await readJson(url, { cookie: await guestCookie() });
  if (body.code === -412) throw new Error('B站拒绝了这次请求');
  return body;
}

async function resolveIdentity({ bvid, aid, pageUrl }) {
  let id = String(bvid || '');
  let av = String(aid || '');
  if (!id && !av && pageUrl) {
    const res = await fetch(pageUrl, { headers: biliHeaders(await guestCookie()), redirect: 'follow' });
    const finalUrl = String(res.url || pageUrl);
    id = (finalUrl.match(/BV[0-9A-Za-z]{10}/) || [])[0] || '';
    av = av || ((finalUrl.match(/\/av(\d+)/) || [])[1] || '');
    if (!id && !av) {
      const html = await res.text();
      id = (html.match(/BV[0-9A-Za-z]{10}/) || [])[0] || '';
      av = (html.match(/\bav(\d{3,})\b/i) || [])[1] || av;
    }
  }
  const query = id ? `bvid=${encodeURIComponent(id)}` : av ? `aid=${encodeURIComponent(av)}` : '';
  if (!query) throw new Error('卡片里没有 B站视频号');
  const pages = await getJson(`https://api.bilibili.com/x/player/pagelist?${query}`);
  const page = pages.data?.[0];
  if (pages.code !== 0 || !page?.cid) throw new Error(pages.message || '打不开这个视频');
  return {
    bvid: id,
    aid: av,
    cid: page.cid,
    title: String(page.part || ''),
    duration: Number(page.duration) || 0
  };
}

function codecRank(stream) {
  const c = String(stream?.codecs || '');
  if (c.startsWith('avc')) return 0;
  if (c.startsWith('hev') || c.startsWith('hvc')) return 1;
  return 2;
}

function streamUrls(stream) {
  if (!stream || typeof stream !== 'object') return [];
  return [stream.baseUrl || stream.base_url || stream.url, ...(stream.backupUrl || stream.backup_url || [])]
    .filter((u) => typeof u === 'string' && u.startsWith('http'));
}

function rankCdn(url) {
  const host = cdnHost(url);
  if (host.endsWith('.bilivideo.com') || host.endsWith('.bilivideo.cn')) return 0;
  if (host.endsWith('.hdslb.com')) return 1;
  return 2;
}

function pickAudioUrls(play) {
  const audios = Array.isArray(play?.data?.dash?.audio) ? play.data.dash.audio : [];
  const ranked = audios
    .filter((a) => streamUrls(a).length)
    .sort((a, b) => (Number(a.bandwidth) || 0) - (Number(b.bandwidth) || 0));
  const chosen = ranked.find((a) => (Number(a.bandwidth) || 0) >= 64000) || ranked[0];
  if (!chosen) return [];
  const seen = new Set();
  return streamUrls(chosen)
    .filter((u) => allowedCdn(u) && !seen.has(u) && seen.add(u))
    .sort((a, b) => rankCdn(a) - rankCdn(b));
}

function pickUrls(play) {
  const videos = Array.isArray(play?.data?.dash?.video) ? play.data.dash.video : [];
  const ranked = videos
    .filter((v) => (Number(v.height) || 0) <= 1080 && streamUrls(v).length)
    .sort((a, b) => codecRank(a) - codecRank(b) || (Number(b.height) || 0) - (Number(a.height) || 0));
  const urls = [];
  for (const stream of ranked) urls.push(...streamUrls(stream));
  const durl = play?.data?.durl?.[0];
  if (durl) urls.push(...streamUrls(durl));
  const seen = new Set();
  return urls
    .filter((u) => allowedCdn(u) && !seen.has(u) && seen.add(u))
    .sort((a, b) => rankCdn(a) - rankCdn(b));
}

async function playUrl(info, { small = false } = {}) {
  const idQuery = info.bvid
    ? `bvid=${encodeURIComponent(info.bvid)}`
    : `avid=${encodeURIComponent(info.aid)}`;
  const base = `https://api.bilibili.com/x/player/playurl?${idQuery}&cid=${info.cid}`;
  // 超过时长上限时先要低清晰度，整段才能塞进体积上限，后面再裁成前一段。
  const tries = small
    ? [
      `${base}&qn=32&fnval=1&platform=html5`,
      `${base}&qn=64&fnval=1&platform=html5&high_quality=1`,
      `${base}&qn=80&fnval=16&fourk=0`
    ]
    : [
      `${base}&qn=80&fnval=16&fourk=0`,
      `${base}&qn=64&fnval=1&platform=html5&high_quality=1`
    ];
  let last = '取播放地址失败';
  let fallback = null;
  for (const url of tries) {
    const play = await getJson(url);
    if (play.code !== 0) {
      last = play.message || last;
      continue;
    }
    const videos = pickUrls(play);
    if (!videos.length) {
      last = '这个视频没有可下载的画面流';
      continue;
    }
    const pack = { videos, audios: pickAudioUrls(play) };
    const direct = videos.some((u) => rankCdn(u) === 0);
    // 有声轨、并且画面在证书对得上的 CDN 上时直接用。否则继续问下一种清晰度。
    if (direct && pack.audios.length) return pack;
    if (pack.audios.length && (!fallback || !fallback.audios.length)) fallback = pack;
    else if (direct && !fallback) fallback = pack;
    else if (!fallback) fallback = pack;
  }
  if (fallback) return fallback;
  throw new Error(last);
}

function cdnHost(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function allowedCdn(url) {
  const host = cdnHost(url);
  if (!host) return false;
  if (host.endsWith('.bilivideo.com') || host === 'bilivideo.com') return true;
  if (host.endsWith('.bilivideo.cn') || host === 'bilivideo.cn') return true;
  if (host.endsWith('.hdslb.com') || host === 'hdslb.com') return true;
  // B站会把部分清晰度放到 Akamai，主机名里带 upos / mirror。
  if (host.endsWith('.akamaized.net') && /upos|mirror|bili/.test(host)) return true;
  return false;
}

async function downloadTo(url, dest, maxBytes) {
  if (!allowedCdn(url)) throw new Error(`播放地址不在 B站 CDN（${cdnHost(url) || '无法解析'}）`);
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      referer: 'https://www.bilibili.com/',
      accept: '*/*',
      // 不带 Range 时，B站 CDN 直接回 567 的网页，而不是视频。
      range: 'bytes=0-'
    },
    redirect: 'follow'
  });
  if (!res.ok || !res.body) throw new Error(`视频下载 HTTP ${res.status}`);
  if (!allowedCdn(res.url || url)) throw new Error(`播放地址跳到了 B站以外（${cdnHost(res.url || url) || '无法解析'}）`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`视频大约 ${Math.ceil(declared / 1048576)}MB，超过上限`);
  const type = String(res.headers.get('content-type') || '');
  if (/text\/html|application\/json/i.test(type)) throw new Error('B站返回的不是视频文件');
  let got = 0;
  const out = fs.createWriteStream(dest);
  try {
    for await (const chunk of Readable.fromWeb(res.body)) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      got += buf.length;
      if (got > maxBytes) throw new Error(`视频超过 ${Math.ceil(maxBytes / 1048576)}MB，已停止下载`);
      if (!out.write(buf)) await new Promise((resolve) => out.once('drain', resolve));
    }
    await new Promise((resolve, reject) => {
      out.end(() => resolve());
      out.on('error', reject);
    });
  } catch (error) {
    out.destroy();
    try { fs.unlinkSync(dest); } catch { /* 半截文件删掉 */ }
    throw error;
  }
  if (got < 1024) {
    try { fs.unlinkSync(dest); } catch { /* ignore */ }
    throw new Error('下载到的内容不是视频');
  }
  return dest;
}

function ffmpegBin() {
  const known = 'D:\\modules\\ffmpeg-2026-06-10-git-b29bdd3715-essentials_build\\bin\\ffmpeg.exe';
  if (fs.existsSync(known)) return known;
  return 'ffmpeg';
}

function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpegBin(), args, { windowsHide: true, stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 超时停掉 */ }
      resolve(false);
    }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

/**
 * 画面流经常没有声音。把音轨单独下成 .audio.m4a，交给语音转文字。
 * 下失败不影响画面。视频文件本身仍由看完后的清理删掉，这份音频不在清理名单里。
 */
async function saveAudio(urls, videoPath, seconds, identity) {
  const audioPath = videoPath.replace(/\.mp4$/i, '') + '.audio.m4a';
  let saved = fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1024;
  if (!saved) {
    for (const one of urls || []) {
      try {
        await downloadTo(one, audioPath, settings().maxMb * 1048576);
        saved = true;
        break;
      } catch {
        try { if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath); } catch { /* 半截删掉 */ }
      }
    }
  }
  if (!saved) {
    const extracted = await runFfmpeg([
      '-y', '-i', videoPath, '-vn', '-c:a', 'aac', '-b:a', '64k', audioPath
    ], 120000);
    saved = extracted && fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1024;
    if (!saved) {
      try { if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath); } catch { /* 没有音轨 */ }
    }
  }
  if (!saved) return;
  if (seconds > 0) {
    const clipped = audioPath.replace(/\.m4a$/i, '') + '.clip.m4a';
    const ok = await runFfmpeg([
      '-y', '-i', audioPath, '-t', String(seconds), '-c', 'copy', clipped
    ], 120000);
    if (ok && fs.existsSync(clipped) && fs.statSync(clipped).size > 1024) {
      try { fs.unlinkSync(audioPath); } catch { /* 用裁好的 */ }
      fs.renameSync(clipped, audioPath);
    } else {
      try { fs.unlinkSync(clipped); } catch { /* 没有半截 */ }
    }
  }
  G.pendingAudio = {
    at: Date.now(),
    path: audioPath,
    bvid: String(identity?.bvid || ''),
    aid: String(identity?.aid || ''),
    pageUrl: String(identity?.pageUrl || '')
  };
}

/** 只保留片头。裁失败就留下整段，调用方已经按体积上限下过了。 */
async function clipTo(src, seconds) {
  const out = src.replace(/\.mp4$/i, '') + '.clip.mp4';
  const ok = await runFfmpeg([
    '-y', '-i', src, '-t', String(seconds), '-c', 'copy', '-movflags', '+faststart', out
  ], 120000);
  if (!ok || !fs.existsSync(out) || fs.statSync(out).size < 1024) {
    try { fs.unlinkSync(out); } catch { /* 没有半截文件 */ }
    return false;
  }
  try { fs.unlinkSync(src); } catch { /* 原文件删不掉也用裁好的 */ }
  fs.renameSync(out, src);
  return true;
}

function hasSavedLines(keys) {
  const file = path.join(DATA_DIR, 'sovits-speech-to-text', 'video-lines.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  return keys.some((key) => String(data[key]?.text || '').trim());
}

/** 画面描述已经有了，但台词还没有时，只补下音轨。失败不影响把旧描述交回去。 */
async function ensureAudio(info, pageUrl) {
  const keys = noteKeys({ bvid: info.bvid, aid: info.aid, pageUrl });
  if (hasSavedLines(keys)) return;
  const limitMin = settings().maxMinutes;
  const over = info.duration > limitMin * 60;
  const key = (info.bvid || (info.aid ? `av${info.aid}` : '') || 'clip').replace(/[^\w.-]/g, '_');
  const pack = await playUrl(info, { small: over });
  await saveAudio(pack.audios, path.join(cacheDir(), `${key}.mp4`), over ? limitMin * 60 : 0, {
    bvid: info.bvid,
    aid: info.aid,
    pageUrl
  });
}

export async function fetchBilibiliFile({ bvid = '', aid = '', pageUrl = '' } = {}) {
  const given = noteKeys({ bvid, aid, pageUrl });
  const early = findNote(given);
  if (early) {
    try {
      const info = await resolveIdentity({ bvid, aid, pageUrl });
      await ensureAudio(info, pageUrl);
    } catch { /* 旧描述照样返回 */ }
    return { remembered: true, description: early.text, title: early.title };
  }
  const info = await resolveIdentity({ bvid, aid, pageUrl });
  const resolved = noteKeys({ bvid: info.bvid || bvid, aid: info.aid || aid, pageUrl });
  const again = findNote(resolved);
  if (again) {
    try { await ensureAudio(info, pageUrl); } catch { /* 旧描述照样返回 */ }
    return { remembered: true, description: again.text, title: again.title || info.title };
  }
  const limitMin = settings().maxMinutes;
  const over = info.duration > limitMin * 60;
  const key = (info.bvid || (info.aid ? `av${info.aid}` : '') || 'clip').replace(/[^\w.-]/g, '_');
  const dest = path.join(cacheDir(), `${key}.mp4`);
  if (!(fs.existsSync(dest) && fs.statSync(dest).size > 1024)) {
    const pack = await playUrl(info, { small: over });
    const fails = [];
    let saved = false;
    for (const one of pack.videos) {
      try {
        await downloadTo(one, dest, settings().maxMb * 1048576);
        saved = true;
        break;
      } catch (error) {
        const msg = error?.cause?.code === 'ERR_TLS_CERT_ALTNAME_INVALID'
          ? `CDN 证书对不上（${cdnHost(one)}）`
          : (error?.message || '下载失败');
        fails.push(`${cdnHost(one) || '未知'}: ${msg}`);
        try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch { /* 半截文件删掉 */ }
      }
    }
    if (!saved) throw new Error(fails.join('；') || '视频下载失败');
    if (over) await clipTo(dest, limitMin * 60);
    await saveAudio(pack.audios, dest, over ? limitMin * 60 : 0, {
      bvid: info.bvid || bvid,
      aid: info.aid || aid,
      pageUrl
    });
  }
  const title = over
    ? `${info.title || 'B站视频'}（片长 ${Math.ceil(info.duration / 60)} 分钟，只看了前 ${limitMin} 分钟）`
    : (info.title || '');
  lastFetch = { keys: [...new Set([...given, ...resolved])], title, filePath: dest };
  return dest;
}

const SAVE_TOOL = 'bilibili-qq-video__save_description';

function textFromArgs(raw) {
  let args = raw;
  if (typeof raw === 'string') {
    try { args = JSON.parse(raw); } catch { return String(raw || '').trim(); }
  }
  if (!args || typeof args !== 'object') return '';
  if (typeof args.messages === 'string') return args.messages.trim();
  if (Array.isArray(args.messages)) return args.messages.map((s) => String(s || '').trim()).filter(Boolean).join('\n');
  return '';
}

function discardWatched({ filePath, bvid, aid, pageUrl, title, frameCount } = {}) {
  removeWatchedFile(filePath || lastFetch?.filePath);
  const keys = [...new Set([
    ...noteKeys({ bvid, aid, pageUrl }),
    ...(lastFetch?.keys || [])
  ])];
  const name = String(title || lastFetch?.title || '').trim();
  if (Number(frameCount) > 0) armPending(keys, name);
  const hint = Number(frameCount) > 0
    ? `视频文件和抽帧图片已经删除。请立刻调用 ${SAVE_TOOL}，用两三句客观描述画面，不要把这段描述发到群里。以后再遇到同一条，只会返回这段描述，不再下载。`
    : '视频文件已经删除。这次没有抽出画面，不用写描述。';
  return { hint };
}

export function setup(api) {
  G.cfgOf = typeof api.config === 'function' ? api.config : () => ({});
  try { sweepLeftovers(); } catch { /* 临时目录还没有 */ }
  api.registerTool({
    id: 'save_description',
    name: '记下刚看的B站视频',
    category: 'query',
    icon: '🎬',
    description: '看完 B站视频后立刻调用。text 用两三句客观描述画面里发生了什么。这段话只留在本地，不要发到群里。视频和截图此时已经删除。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '两三句画面描述' }
      },
      required: ['text']
    },
    async execute(_ctx, args = {}) {
      const text = String(args.text || '').trim();
      if (!text) return { content: '描述是空的。', isError: true };
      const saved = savePending(text, true);
      if (!saved) return { content: '没有刚看完的 B站视频。', isError: true };
      return { content: JSON.stringify({ ok: true, title: saved.title }) };
    }
  });
}

export function available() {
  return { ok: true };
}

export function promptSections() {
  return [{
    id: 'bilibili-qq-video',
    title: 'B站小程序视频',
    priority: 35,
    content: `群里用 QQ 小程序发来的 B站视频会记成 [B站视频] 加标题。要看画面就对那条消息调用 read_video，参数用消息前的 #数字。看的方式和普通视频相同，按当前视频模式（现在是抽帧）。看完后视频文件和截图会马上删除，你要立刻调用 ${SAVE_TOOL} 用两三句记下画面，不要把这段描述发到群里。以后再遇到同一条，read_video 只返回上次的描述，不会重新下载。直播和普通卡片不是这种视频。`
  }];
}

export const hooks = {
  'after-tool': (ctx) => {
    const name = String(ctx?.toolName || '');
    if (name === 'send_message' || name.endsWith('__send_message')) {
      savePending(textFromArgs(ctx?.argsRaw), false);
    }
  },
  'after-response': (ctx) => {
    const content = ctx?.response?.message?.content;
    const text = typeof content === 'string'
      ? content.trim()
      : (Array.isArray(content) ? content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n').trim() : '');
    if (text) savePending(text, false);
  }
};

export const providers = {
  'message.bilibili-card': (segment) => parseBilibiliCard(segment) || { skip: true },
  'video.fetch-bilibili': async (args = {}) => {
    try {
      const got = await fetchBilibiliFile(args);
      if (got && typeof got === 'object' && got.remembered) return got;
      return { filePath: got };
    } catch (error) {
      return { error: error?.message || 'B站视频下载失败' };
    }
  },
  'video.bilibili-discard': async (args = {}) => discardWatched(args)
};
