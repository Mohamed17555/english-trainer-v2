#!/usr/bin/env node
/* ============================================================
   captions-server.js — خادم صغير اختياري لجلب كابشن يوتيوب
   بدون أي مكتبات خارجية (يتطلب Node 18 أو أحدث).

   التشغيل:   node captions-server.js
   ثم افتح:   http://localhost:8787      (يقدّم الموقع نفسه، فلا توجد مشاكل CORS)
   وضع في الموقع (تمرين جديد ← جلب الكابشن تلقائيًا):   /captions

   الطلب:    GET /captions?v=VIDEO_ID&lang=en
   الرد:     { ok:true, lang:"en", kind:"manual"|"asr", title, cues:[{s,e,t}] }
   أو:       { ok:false, error:"no_captions"|"not_english"|"fetch_failed", message }

   طريقتان (تُجرَّبان بالترتيب):
     1) yt-dlp إن كان مثبتًا على الجهاز (الأكثر ثباتًا لأنه يُحدَّث مع تغييرات يوتيوب)
     2) واجهة InnerTube الداخلية لليوتيوب مباشرة

   تنبيه: هذه واجهات غير رسمية، يوتيوب يغيّرها ويحجب عناوين الاستضافات السحابية
   كثيرًا. الأفضل تشغيله على جهازك المنزلي. إن فشل فالصق النص يدويًا في الموقع.
   ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const PORT = +process.env.PORT || 8787;
const ROOT = __dirname;
const STATIC = { '/': 'english-trainer-pro.html', '/english-trainer-pro.html': 'english-trainer-pro.html', '/dictation.js': 'dictation.js', '/dictation.css': 'dictation.css' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/* ---------- أدوات ---------- */
const decode = s => String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '; }
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e.toLowerCase()] ?? m;
});
const tsec = t => { const p = t.replace(',', '.').split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };

/** يحوّل أي صيغة كابشن يرجعها يوتيوب (json3 / XML / VTT) إلى [{s,e,t}] */
function parseCaptions(body) {
  body = String(body).trim();
  if (body.startsWith('{')) {                                   // json3
    const j = JSON.parse(body);
    return (j.events || []).filter(ev => ev.segs).map(ev => ({
      s: ev.tStartMs / 1000, e: (ev.tStartMs + (ev.dDurationMs || 0)) / 1000,
      t: decode(ev.segs.map(x => x.utf8 || '').join('')).replace(/\s+/g, ' ').trim()
    })).filter(c => c.t);
  }
  if (body.startsWith('<')) {                                   // XML: <text start dur>
    const out = [], re = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
    let m;
    while ((m = re.exec(body))) {
      const st = /\bstart="([\d.]+)"/.exec(m[1]), du = /\bdur="([\d.]+)"/.exec(m[1]);
      const t = decode(decode(m[2].replace(/<[^>]+>/g, ''))).replace(/\s+/g, ' ').trim();   // يوتيوب يهرّب الكيانات مرتين
      if (st && t) out.push({ s: +st[1], e: du ? +st[1] + +du[1] : null, t });
    }
    return out;
  }
  const out = [];                                               // VTT / SRT
  body.replace(/\r/g, '').split(/\n\s*\n/).forEach(b => {
    const ls = b.split('\n'), k = ls.findIndex(l => l.includes('-->'));
    if (k < 0) return;
    const m = ls[k].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
    const t = decode(ls.slice(k + 1).join(' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (m && t) out.push({ s: tsec(m[1]), e: tsec(m[2]), t });
  });
  return out;
}
/** يختار أفضل مسار إنجليزي: يدوي أولًا ثم المولَّد آليًا */
function pickTrack(tracks) {
  const en = (tracks || []).filter(t => /^en(\b|-)/i.test(t.languageCode || ''));
  if (!en.length) return { none: (tracks || []).length ? 'not_english' : 'no_captions' };
  const manual = en.find(t => t.kind !== 'asr');
  return { track: manual || en[0], kind: manual ? 'manual' : 'asr' };
}

/* ---------- الطريقة 1: yt-dlp ---------- */
function ytdlp(id) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
    const clean = () => fs.rmSync(dir, { recursive: true, force: true });
    execFile('yt-dlp', ['--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', 'en.*,en', '--sub-format', 'vtt', '--print', 'title', '-o', path.join(dir, '%(id)s'), 'https://www.youtube.com/watch?v=' + id],
      { timeout: 60000 }, (err, stdout) => {
        if (err) { clean(); return reject(err); }
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.vtt'));
        if (!files.length) { clean(); return resolve({ none: 'no_captions', title: stdout.trim() }); }
        // الملف اليدوي اسمه id.en.vtt؛ المولَّد آليًا غالبًا id.en-orig.vtt أو يظهر في سجل yt-dlp
        const f = files.find(x => /\.en\.vtt$/.test(x)) || files[0];
        const cues = parseCaptions(fs.readFileSync(path.join(dir, f), 'utf8'));
        clean();
        resolve({ cues, kind: 'unknown', title: stdout.trim().split('\n')[0] });
      });
  });
}

/* ---------- الطريقة 2: InnerTube ---------- */
async function innertube(id) {
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip' },
    body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'en' } }, videoId: id })
  });
  if (!r.ok) throw new Error('player http ' + r.status);
  const j = await r.json();
  const title = j.videoDetails && j.videoDetails.title;
  const tracks = j.captions && j.captions.playerCaptionsTracklistRenderer && j.captions.playerCaptionsTracklistRenderer.captionTracks;
  const pick = pickTrack(tracks);
  if (pick.none) return { none: pick.none, title };
  const u = new URL(pick.track.baseUrl);
  u.searchParams.delete('tlang');                               // لا نقبل ترجمة آلية
  u.searchParams.set('fmt', 'json3');
  const c = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const body = await c.text();
  if (!c.ok || !body.trim()) throw new Error('caption http ' + c.status + (body.trim() ? '' : ' (empty)'));
  return { cues: parseCaptions(body), kind: pick.kind, title };
}

async function getCaptions(id) {
  const errors = [];
  for (const [name, fn] of [['yt-dlp', ytdlp], ['innertube', innertube]]) {
    try {
      const r = await fn(id);
      if (r.none) return { ok: false, error: r.none, title: r.title };
      if (r.cues && r.cues.length) return { ok: true, lang: 'en', kind: r.kind, title: r.title, cues: r.cues };
      errors.push(name + ': empty');
    } catch (e) { errors.push(name + ': ' + (e.code === 'ENOENT' ? 'غير مثبّت' : e.message)); }
  }
  return { ok: false, error: 'fetch_failed', message: errors.join(' | ') };
}

/* ---------- الخادم ---------- */
const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': '*' }); return res.end(); }
  if (u.pathname === '/health') return send(res, 200, { ok: true });
  if (u.pathname === '/captions') {
    const id = u.searchParams.get('v') || '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return send(res, 400, { ok: false, error: 'bad_id', message: 'معرّف الفيديو غير صالح' });
    const r = await getCaptions(id);
    return send(res, r.ok ? 200 : (r.error === 'fetch_failed' ? 502 : 404), r);
  }
  const f = STATIC[u.pathname];                                  // قائمة بيضاء فقط، لا تصفّح للمجلدات
  if (f && fs.existsSync(path.join(ROOT, f))) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] });
    return fs.createReadStream(path.join(ROOT, f)).pipe(res);
  }
  res.writeHead(404); res.end('Not found');
});

if (require.main === module) server.listen(PORT, () => console.log(`Captions server: http://localhost:${PORT}  (الموقع + /captions)`));
module.exports = { parseCaptions, pickTrack, server };
