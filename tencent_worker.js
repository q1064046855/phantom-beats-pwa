/* ============================================================
 * PHANTOM BEATS · 腾讯云函数 SCF (Node.js 18.15)  v3.84
 *   v3.84 新增云端曲库：/api/cloud/config|list|presign|delete|lock|lock_del
 *   （歌曲与锁定歌词存 COS 对象存储；密钥走环境变量 COS_SECRET_ID/COS_SECRET_KEY/
 *     COS_BUCKET/COS_REGION）
 * 触发方式：API 网关（API Gateway）事件集成
 *   POST /api/recognize  body=WAV (44.1k/48k 单声道16bit ~15s, base64)
 *   POST /api/search     body=JSON {q}
 *   OPTIONS 预检
 * 识别 ACRCloud（中文最强）→ AudD 兜底；歌词 LRCLIB + 网易云。
 * ★ v3.45 兜底保护：识别到歌但歌词全空 → unverified 不自动采用。
 * 密钥走 SCF 环境变量（控制台函数配置里填）：
 *   ACR_HOST(可选) / ACR_ACCESS_KEY / ACR_ACCESS_SECRET / AUDD_API_TOKEN
 * ============================================================ */

'use strict';

// Node18 全局已有 fetch / crypto.webcrypto / FormData / Blob
const webcrypto = globalThis.crypto || require('crypto').webcrypto;
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const DEFAULT_ACR_HOST = 'identify-cn-north-1.acrcloud.cn';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

function J(obj){
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
    body: JSON.stringify(obj),
  };
}

/* ---------------- v3.46 站点静态文件（构建时注入 base64） ---------------- */
const SITE_INDEX_B64 = '/*__SITE_INDEX_B64__*/';
const SITE_APP_B64 = '/*__SITE_APP_B64__*/';
const SITE_WORKLET_B64 = '/*__SITE_WORKLET_B64__*/';
const SITE_INDEX_HTML = Buffer.from(SITE_INDEX_B64, 'base64').toString('utf8');
const SITE_APP_JS = Buffer.from(SITE_APP_B64, 'base64').toString('utf8');
const SITE_WORKLET_JS = Buffer.from(SITE_WORKLET_B64, 'base64').toString('utf8');
function serveSite(kind){
  const type = kind === 'app' ? 'application/javascript'
    : kind === 'worklet' ? 'application/javascript' : 'text/html';
  const body = kind === 'app' ? SITE_APP_JS
    : kind === 'worklet' ? SITE_WORKLET_JS : SITE_INDEX_HTML;
  return {
    statusCode: 200,
    headers: {
      'Content-Type': type + '; charset=utf-8',
      'Cache-Control': kind === 'index' ? 'no-cache' : 'public, max-age=300',
    },
    body,
  };
}
function fail(msg, statusCode){
  return {
    statusCode: statusCode || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
    body: JSON.stringify({ ok: false, type: 'error', error: msg }),
  };
}

/* ---------------- ACRCloud HMAC-SHA1 ---------------- */
async function hmacSha1B64(secret, str){
  const key = await webcrypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(str));
  return Buffer.from(sig).toString('base64');
}

/* ---------------- multipart/form-data（Node18 全局 FormData/Blob） ---------------- */
async function postMultipart(url, fields, fileField){
  const fd = new FormData();
  for (const [k, v] of fields) fd.append(k, v);
  fd.append(fileField.name, new Blob([fileField.data], { type: fileField.contentType }),
             fileField.filename);
  const res = await fetch(url, { method: 'POST', body: fd });
  return await res.json();
}

/* ---------------- ACRCloud / AudD ---------------- */
async function acrIdentify(env, wav){
  const host = (env.ACR_HOST || DEFAULT_ACR_HOST).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const stringToSign =
    'POST\n/v1/identify\n' + env.ACR_ACCESS_KEY + '\naudio\n1\n' + timestamp;
  const signature = await hmacSha1B64(env.ACR_ACCESS_SECRET, stringToSign);
  return await postMultipart(
    'https://' + host + '/v1/identify',
    [['access_key', env.ACR_ACCESS_KEY],
     ['data_type', 'audio'],
     ['signature_version', '1'],
     ['signature', signature],
     ['timestamp', timestamp],
     ['sample_bytes', String(wav.byteLength)]],
    { name: 'sample', filename: 'audio.wav', contentType: 'audio/wav', data: wav });
}
async function auddRecognize(env, wav){
  return await postMultipart(
    'https://api.audd.io/',
    [['api_token', env.AUDD_API_TOKEN], ['return', 'time']],
    { name: 'file', filename: 'audio.wav', contentType: 'audio/wav', data: wav });
}

/* ---------------- 歌词：LRCLib ---------------- */
async function lrclibGet(url){
  const res = await fetch(url, { headers: { 'x-user-agent': 'PhantomBeats/1.0 (music visualizer)' } });
  if (!res.ok) throw new Error('LRCLib HTTP ' + res.status);
  return await res.json();
}
function lrclibSyncedCands(raw, maxN){
  maxN = maxN || 5;
  const out = [];
  for (const e of (raw || [])){
    if (!e.syncedLyrics || !e.syncedLyrics.includes('[')) continue;
    out.push({ source: 'lrclib', lrc: e.syncedLyrics,
      title: e.trackName || '', artist: e.artistName || '',
      duration: Math.round(e.duration || 0) });
    if (out.length >= maxN) break;
  }
  return out;
}
function lrclibPlainCands(raw, maxN){
  maxN = maxN || 3;
  const out = [];
  for (const e of (raw || [])){
    if (!e.plainLyrics) continue;
    out.push({ source: 'lrclib', lrc: e.plainLyrics,
      title: e.trackName || '', artist: e.artistName || '',
      duration: Math.round(e.duration || 0) });
    if (out.length >= maxN) break;
  }
  return out;
}

/* ---------------- 歌词：网易云 ---------------- */
const NETEASE_HEADERS = {
  Referer: 'https://music.163.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                 '(KHTML, like Gecko) Chrome/120.0 Safari/537.36',
};
async function neteaseSearch(query, searchType, limit){
  const url = 'https://music.163.com/api/search/get?s=' + encodeURIComponent(query) +
              '&type=' + searchType + '&limit=' + limit;
  const res = await fetch(url, { headers: NETEASE_HEADERS });
  const data = await res.json();
  return (data.result && data.result.songs) || [];
}
async function neteaseLyric(song){
  const url = 'https://music.163.com/api/song/lyric?os=pc&id=' + song.id + '&lv=1&kv=1&tv=-1';
  const res = await fetch(url, { headers: NETEASE_HEADERS });
  const data = await res.json();
  const lrc = data.lrc && data.lrc.lyric;
  if (!lrc || !lrc.includes('[')) return null;
  return { source: 'netease', lrc,
    title: song.name || '',
    artist: (song.artists || []).map(a => a.name).join(' / '),
    duration: Math.round((song.duration || 0) / 1000) };
}
async function songsToCands(songs){
  const results = await Promise.all((songs || []).map(s =>
    neteaseLyric(s).catch(() => null)));
  return results.filter(Boolean);
}
async function neteaseNameCands(title, artist, limit){
  const q = ((title || '') + ' ' + (artist || '')).trim();
  if (!q) return [];
  try { return await songsToCands(await neteaseSearch(q, 1, limit || 3)); }
  catch { return []; }
}
async function neteaseTextCands(phrase, limit){
  phrase = (phrase || '').trim();
  if (!phrase) return [];
  try { return await songsToCands(await neteaseSearch(phrase, 1006, limit || 5)); }
  catch { return []; }
}

/* ---------------- 质量校验 / 聚合（移植 audio_server.py） ---------------- */
function lrcTimestamps(lrc){
  const out = [];
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  let m;
  while ((m = re.exec(lrc)) !== null){
    let frac = m[3] ? parseInt(m[3], 10) : 0;
    if (m[3] && m[3].length === 2) frac *= 10;
    out.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac / 1000);
  }
  return out;
}
function isPlayableSyncedLrc(lrc){
  const ts = lrcTimestamps(lrc || '');
  if (!ts.length) return false;
  return ts.some(t => t > 0);
}
function dedupCands(cands){
  const seen = new Set();
  const out = [];
  for (const c of cands){
    const key = c.source + '|' + (c.title || '').trim().toLowerCase() +
                '|' + (c.artist || '').trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
function pickRecommendedIdx(cands, durationS){
  if (!cands.length) return -1;
  const lr = [];
  cands.forEach((c, i) => { if (c.source === 'lrclib') lr.push(i); });
  if (lr.length){
    if (durationS > 0){
      let best = lr[0];
      for (const i of lr)
        if (Math.abs((cands[i].duration || 0) - durationS) <
            Math.abs((cands[best].duration || 0) - durationS)) best = i;
      if (Math.abs((cands[best].duration || 0) - durationS) <=
          Math.max(8, durationS * 0.05)) return best;
    }
    return lr[0];
  }
  return 0;
}
async function gatherCandidates(title, artist, durationS, lrclibRaw, extra){
  const lrclib = lrclibSyncedCands(lrclibRaw);
  const net = await neteaseNameCands(title, artist);
  const rawCands = [...lrclib, ...net, ...(extra || [])]
    .filter(c => isPlayableSyncedLrc(c.lrc));
  let cands = dedupCands(rawCands).slice(0, 8);
  if (!cands.length){
    cands = dedupCands(lrclibPlainCands(lrclibRaw)).slice(0, 3);
  }
  return [cands, pickRecommendedIdx(cands, durationS)];
}

/* ---------------- choice（candidates 含 lrc 全文） ---------------- */
function choiceResponse(title, artist, album, duration, anchor, cands, recIdx){
  cands.forEach((c, i) => {
    c.cid = String(i);
    c.recommended = (i === recIdx);
  });
  return {
    ok: true, type: 'choice',
    title, artist, album: album || '',
    duration: duration || 0,
    anchor,
    recommended_cid: recIdx >= 0 ? String(recIdx) : '0',
    candidates: cands,
  };
}

/* ---------------- recognize ---------------- */
async function handleRecognize(env, wav){
  let matched = null;

  if (env.ACR_ACCESS_KEY && env.ACR_ACCESS_SECRET){
    let acr = null;
    try { acr = await acrIdentify(env, wav); }
    catch (e) { acr = { _error: String(e) }; }
    if (acr && acr.status && acr.status.code === 0){
      const musics = (acr.metadata && acr.metadata.music) || [];
      if (musics.length){
        const m0 = musics[0];
        const artist = (m0.artists && m0.artists[0] && m0.artists[0].name) || '';
        const album = (m0.album && m0.album.name) || '';
        const durationMs = m0.duration_ms || 0;
        let songSecAtClick = null;
        if (typeof m0.play_offset_ms === 'number' && m0.play_offset_ms >= 0){
          songSecAtClick = m0.play_offset_ms / 1000;
        } else if (typeof m0.db_begin_time_offset_ms === 'number'){
          songSecAtClick = 15 - (m0.sample_begin_time_offset_ms || 0) / 1000
                           + m0.db_begin_time_offset_ms / 1000;
        } else {
          songSecAtClick = 0;
        }
        matched = {
          title: (m0.title || '').trim(), artist: (artist || '').trim(),
          album: (album || '').trim(), durationMs, songSecAtClick, by: 'acr',
        };
      }
    }
  }

  if (!matched && env.AUDD_API_TOKEN){
    let audd = null;
    try { audd = await auddRecognize(env, wav); }
    catch { audd = null; }
    if (audd && audd.status === 'success' && audd.result){
      const t = audd.result;
      let songSecAtClick = 0;
      const ti = t.time;
      if (ti && typeof ti.start === 'number'){
        songSecAtClick = ti.start + 15;
      }
      matched = {
        title: (t.title || '').trim(),
        artist: (t.artist || '').trim(),
        album: (t.album || '').trim(),
        durationMs: 0, songSecAtClick, by: 'audd',
      };
    }
  }

  if (!matched){
    return J({ ok: true, type: 'failed',
               msg: '未识别到歌曲；可手动输歌名或一句歌词' });
  }

  const lrclibUrl = 'https://lrclib.net/api/search?' + new URLSearchParams(
    matched.durationMs
      ? { track_name: matched.title, artist_name: matched.artist,
          duration: String(Math.round(matched.durationMs / 1000)) }
      : { track_name: matched.title, artist_name: matched.artist });
  let lrclibRaw = [];
  try { lrclibRaw = await lrclibGet(lrclibUrl); }
  catch {
    try {
      lrclibRaw = await lrclibGet(
        'https://lrclib.net/api/search?' + new URLSearchParams({ q: matched.title }));
    } catch { lrclibRaw = []; }
  }
  const extra = await neteaseTextCands(matched.title);
  const [cands, recIdx] = await gatherCandidates(
    matched.title, matched.artist, matched.durationMs / 1000, lrclibRaw, extra);

  if (!cands.length){
    return J({
      ok: true, type: 'unverified', by: matched.by,
      title: matched.title, artist: matched.artist,
      msg: (matched.by === 'audd' ? 'AudD' : '识别') +
           ' 低置信匹配到《' + matched.title +
           ' - ' + matched.artist + '》但所有歌词库均无收录，' +
           '为防误匹配未自动采用；如确认是这首歌请手动搜索歌名',
    });
  }
  return J(choiceResponse(
    matched.title, matched.artist, matched.album,
    matched.durationMs / 1000,
    { by: matched.by, songSecAtClick: matched.songSecAtClick },
    cands, recIdx));
}

/* ---------------- debug：诊断用（可在正式部署后保留，无密钥泄露） ---------------- */
async function handleDebug(env, wav, ev){
  const crypto2 = require('crypto');
  const hash = crypto2.createHash('sha256').update(Buffer.from(wav)).digest('hex');
  // 原始事件快照：字段名 + 各种大小写变体
  const keys = Object.keys(ev || {});
  const bodyAny = ev.body != null ? ev.body : ev.Body;
  const eventSnapshot = {
    keys,
    httpMethod: ev.httpMethod, HttpMethod: ev.HttpMethod,
    path: ev.path, Path: ev.Path, rawPath: ev.rawPath, RawPath: ev.RawPath,
    isBase64Encoded: ev.isBase64Encoded,
    IsBase64Encoded: ev.IsBase64Encoded,
    body_type: typeof bodyAny,
    body_isBuffer: Buffer.isBuffer(bodyAny),
    body_length: bodyAny && bodyAny.length,
    body_head: typeof bodyAny === 'string' ? bodyAny.slice(0, 200) : null,
    headers: ev.headers || ev.Headers || null,
  };
  const out = {
    ok: true, type: 'debug',
    byteLength: wav.byteLength,
    sha256: hash,
    event: eventSnapshot,
    env: {
      ACR_HOST: env.ACR_HOST || '',
      has_ACR_ACCESS_KEY: !!env.ACR_ACCESS_KEY,
      ACR_ACCESS_KEY_len: (env.ACR_ACCESS_KEY || '').length,
      has_ACR_ACCESS_SECRET: !!env.ACR_ACCESS_SECRET,
      ACR_ACCESS_SECRET_len: (env.ACR_ACCESS_SECRET || '').length,
      has_AUDD_API_TOKEN: !!env.AUDD_API_TOKEN,
      AUDD_API_TOKEN_len: (env.AUDD_API_TOKEN || '').length,
    },
    node: process.version,
  };
  // ACR 原始返回
  if (env.ACR_ACCESS_KEY && env.ACR_ACCESS_SECRET){
    try {
      const acr = await acrIdentify(env, wav);
      out.acr_raw = JSON.stringify(acr).slice(0, 1000);
    } catch (e){
      out.acr_error = String(e && e.message ? e.message : e).slice(0, 500);
    }
  }
  // AudD 原始返回
  if (env.AUDD_API_TOKEN){
    try {
      const audd = await auddRecognize(env, wav);
      out.audd_raw = JSON.stringify(audd).slice(0, 600);
    } catch (e){
      out.audd_error = String(e && e.message ? e.message : e).slice(0, 500);
    }
  }
  return J(out);
}

/* ---------------- search ---------------- */
async function handleSearch(q){
  q = (q || '').trim();
  if (!q) return J({ ok: true, type: 'failed', msg: '搜索内容为空' });
  const parts = q.split(/\s+/, 2);
  const tName = parts[0] || q;
  const aName = parts[1] || '';

  let lrclibRaw = [];
  try {
    lrclibRaw = await lrclibGet(
      'https://lrclib.net/api/search?' + new URLSearchParams({ q }));
  } catch { lrclibRaw = []; }
  const extra = await neteaseTextCands(q);
  const [cands, recIdx] = await gatherCandidates(tName, aName, 0, lrclibRaw, extra);

  if (!cands.length){
    return J({ ok: true, type: 'failed',
               msg: '没找到歌词（LRCLib + 网易云都没有），换个词试试' });
  }
  const top = lrclibRaw[0] || null;
  return J(choiceResponse(
    top ? (top.trackName || tName) : tName,
    top ? (top.artistName || aName) : aName,
    '', 0, null, cands, recIdx));
}

/* ============================================================
 * v3.84 云端曲库（腾讯云 COS 对象存储）
 * 对象布局：
 *   songs/<fileKey>          音频（桶公有读私有写 → 浏览器直链流媒体播放，支持 Range）
 *   locks/<fileKey>.json     歌词锁定数据（公有读 → 浏览器直接 GET；写入走预签名 PUT）
 * fileKey = "歌名|字节数"（与前端本地曲库键一致 → 同名同大小文件跨设备共享锁定歌词）
 * 环境变量：COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET(如 phantom-beats-100053418173)
 *           COS_REGION(默认 ap-guangzhou)
 * ============================================================ */
const nodeCrypto = require('crypto');
function cosCfg(){
  return {
    id: process.env.COS_SECRET_ID || '',
    key: process.env.COS_SECRET_KEY || '',
    bucket: process.env.COS_BUCKET || '',
    region: process.env.COS_REGION || 'ap-guangzhou',
  };
}
function cosReady(cfg){ return !!(cfg.id && cfg.key && cfg.bucket); }
function cosHost(cfg){ return cfg.bucket + '.cos.' + cfg.region + '.myqcloud.com'; }
/* RFC3986 百分号编码：encodeURIComponent 基础上补转 !'()*（十六进制大写，与 COS 规范一致） */
function cosEnc(s){
  return encodeURIComponent(String(s)).replace(
    /[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
/* COS XML API 签名 v5：uri=已编码路径（以 / 开头，大小写保留）；
 * params 的值须已经过 cosEnc；headers 只参与签名的 Host 即可 */
function cosAuth(cfg, method, uri, params, headers, expiresSec){
  const now = Math.floor(Date.now() / 1000);
  const keyTime = (now - 60) + ';' + (now + (expiresSec || 1800));
  const signKey = nodeCrypto.createHmac('sha1', cfg.key).update(keyTime).digest('hex');
  const kv = obj => Object.keys(obj || {}).sort()
    .map(k => k.toLowerCase() + '=' + String(obj[k]).toLowerCase()).join('&');
  const ks = obj => Object.keys(obj || {}).sort().map(k => k.toLowerCase()).join(';');
  const sha1hex = s => nodeCrypto.createHash('sha1').update(s).digest('hex');
  const httpString = method.toLowerCase() + '\n' + uri + '\n' + kv(params) + '\n' + kv(headers) + '\n';
  /* StringToSign（COS 实测规范）：sha1\n + KeyTime + \n + sha1(HttpString) */
  const stringToSign = 'sha1\n' + keyTime + '\n' + sha1hex(httpString);
  const sig = nodeCrypto.createHmac('sha1', signKey).update(stringToSign).digest('hex');
  return 'q-sign-algorithm=sha1&q-ak=' + cfg.id + '&q-sign-time=' + keyTime +
         '&q-key-time=' + keyTime + '&q-header-list=' + ks(headers) +
         '&q-url-param-list=' + ks(params) + '&q-signature=' + sig;
}
/* SCF 服务器端自用的 COS 请求（自动签名） */
async function cosFetch(cfg, method, uri, params, extraHeaders){
  const params2 = params || {};
  const auth = cosAuth(cfg, method, uri, params2, { host: cosHost(cfg) }, 600);
  const qs = Object.keys(params2).length
    ? '?' + Object.keys(params2).sort().map(k => k.toLowerCase() + '=' + params2[k]).join('&')
    : '';
  return await fetch('https://' + cosHost(cfg) + uri + qs,
    { method, headers: { Authorization: auth, ...(extraHeaders || {}) } });
}
/* 对象列表 XML → [{key,size,ts}]（key=原始 fileKey，仅做 XML 实体还原） */
function parseCosListXml(xml){
  const out = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m;
  while ((m = re.exec(xml)) !== null){
    const blk = m[1];
    const get = tag => {
      const mm = blk.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
      return mm ? mm[1] : '';
    };
    const key = get('Key').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    if (!key) continue;
    out.push({ key,
      size: parseInt(get('Size'), 10) || 0,
      ts: Date.parse(get('LastModified')) || 0 });
  }
  return out;
}

/* ---------- /api/cloud/config：前端获取 COS 直链域名等 ---------- */
function handleCloudConfig(){
  const cfg = cosCfg();
  if (!cosReady(cfg)) return J({ ok: false, error: '云端曲库未配置（SCF 环境变量缺 COS_*）' });
  return J({ ok: true, base: 'https://' + cosHost(cfg), region: cfg.region, bucket: cfg.bucket });
}
/* ---------- /api/cloud/list：云端曲库列表（新上传在前） ---------- */
async function handleCloudList(){
  const cfg = cosCfg();
  if (!cosReady(cfg)) return J({ ok: false, error: '云端曲库未配置' });
  try{
    const res = await cosFetch(cfg, 'GET', '/',
      { 'list-type': '2', 'max-keys': '1000', 'prefix': cosEnc('songs/') });
    const xml = await res.text();
    if (!res.ok) return J({ ok: false, error: 'COS 列表失败 HTTP ' + res.status });
    const items = parseCosListXml(xml)
      .map(it => {
        const p = it.key.lastIndexOf('|');
        return { ...it, name: p >= 0 ? it.key.slice(0, p) : it.key };
      })
      .sort((a, b) => b.ts - a.ts);
    return J({ ok: true, items });
  }catch(e){ return J({ ok: false, error: '云端列表失败: ' + (e.message || e) }); }
}
/* ---------- /api/cloud/presign?name=xx&size=123 ---------- */
/* 同名同大小已存在 → {dup:true}；否则返回预签名 PUT URL（浏览器直传 COS，2小时有效） */
async function handleCloudPresign(qs){
  const cfg = cosCfg();
  if (!cosReady(cfg)) return J({ ok: false, error: '云端曲库未配置' });
  const name = (qs.name || '').trim();
  const size = parseInt(qs.size, 10) || 0;
  if (!name || size <= 0) return J({ ok: false, error: '参数缺失 name/size' });
  const key = name + '|' + size;
  const uri = '/songs/' + cosEnc(key);
  try{
    const head = await cosFetch(cfg, 'HEAD', uri);
    if (head.status === 200) return J({ ok: true, dup: true, key });
    const auth = cosAuth(cfg, 'PUT', uri, {}, { host: cosHost(cfg) }, 7200);
    return J({ ok: true, dup: false, key, url: 'https://' + cosHost(cfg) + uri + '?' + auth });
  }catch(e){ return J({ ok: false, error: '预签名失败: ' + (e.message || e) }); }
}
/* ---------- /api/cloud/delete  body={keys:[fileKey,...]} ---------- */
/* 删除云端歌曲 + 对应锁定歌词（在线曲库页的 ✕ 用） */
async function handleCloudDelete(body){
  const cfg = cosCfg();
  if (!cosReady(cfg)) return J({ ok: false, error: '云端曲库未配置' });
  const keys = Array.isArray(body.keys) ? body.keys.filter(k => typeof k === 'string' && k) : [];
  if (!keys.length) return J({ ok: false, error: 'keys 为空' });
  const results = await Promise.all(keys.map(async k => {
    const targets = ['/songs/' + cosEnc(k), '/locks/' + cosEnc(k) + '.json'];
    let okN = 0;
    for (const uri of targets){
      try{
        const res = await cosFetch(cfg, 'DELETE', uri);
        if (res.ok) okN++;
      }catch(e){ /* 单个失败不连坐 */ }
    }
    return okN;
  }));
  return J({ ok: true, deleted: results.reduce((a, b) => a + b, 0) });
}
/* ---------- /api/cloud/lock?k=<fileKey>：返回锁定 JSON 的预签名 PUT URL ---------- */
async function handleCloudLock(qs){
  const cfg = cosCfg();
  if (!cosReady(cfg)) return J({ ok: false, error: '云端曲库未配置' });
  const k = (qs.k || '').trim();
  if (!k || k.indexOf('|') < 0) return J({ ok: false, error: 'k 参数缺失' });
  const uri = '/locks/' + cosEnc(k) + '.json';
  const auth = cosAuth(cfg, 'PUT', uri, {}, { host: cosHost(cfg) }, 600);
  return J({ ok: true, url: 'https://' + cosHost(cfg) + uri + '?' + auth });
}
/* ---------- /api/cloud/lock_del  body={keys:[fileKey,...]}：仅删锁定 JSON ---------- */
/* （本地批量删歌时调用，防止换设备后云端锁死而复生） */
async function handleCloudLockDel(body){
  const cfg = cosCfg();
  if (!cosReady(cfg)) return J({ ok: false, error: '云端曲库未配置' });
  const keys = Array.isArray(body.keys) ? body.keys.filter(k => typeof k === 'string' && k) : [];
  if (!keys.length) return J({ ok: false, error: 'keys 为空' });
  const results = await Promise.all(keys.map(async k => {
    try{
      const res = await cosFetch(cfg, 'DELETE', '/locks/' + cosEnc(k) + '.json');
      return res.ok ? 1 : 0;
    }catch(e){ return 0; }
  }));
  return J({ ok: true, deleted: results.reduce((a, b) => a + b, 0) });
}
/* API 网关 / 函数 URL 的 query 兼容读取（值可能是数组） */
function eventQuery(event){
  const q = event.queryString || event.queryStringParameters || {};
  const out = {};
  Object.keys(q).forEach(k => {
    const v = q[k];
    out[k] = Array.isArray(v) ? String(v[0]) : String(v);
  });
  return out;
}

/* ---------------- SCF 入口（API 网关事件集成） ---------------- */
exports.main_handler = async (event, context) => {
  // 兼容 API 网关触发器（event.httpMethod）与函数 URL（event.requestContext.http）
  const method = event.httpMethod
    || (event.requestContext && event.requestContext.http &&
        event.requestContext.http.method)
    || event.method || 'GET';
  let path = event.path
    || (event.requestContext && event.requestContext.http &&
        event.requestContext.http.path)
    || event.rawPath || '/';
  // API 网关上可能带函数名前缀；做后缀匹配（/api/recognize、/api/search）
  // v3.46 站点托管：GET / 与 /index.html → 页面；GET /app.js → 脚本
  if (method === 'GET'){
    if (path === '/' || path === '/index.html') return serveSite('index');
    if (path === '/app.js') return serveSite('app');
    if (path === '/mic-worklet.js') return serveSite('worklet');
    if (path === '/favicon.ico'){
      return { statusCode: 204, headers: { 'Cache-Control': 'public, max-age=86400' }, body: '' };
    }
  }
  const isRecognize = /(?:^|\/)api\/recognize\/?$/.test(path);
  const isSearch = /(?:^|\/)api\/search\/?$/.test(path);
  const isDebug = /(?:^|\/)api\/debug\/?$/.test(path);
  // v3.84 云端曲库
  const isCloudList    = /(?:^|\/)api\/cloud\/list\/?$/.test(path);
  const isCloudConfig  = /(?:^|\/)api\/cloud\/config\/?$/.test(path);
  const isCloudPresign = /(?:^|\/)api\/cloud\/presign\/?$/.test(path);
  const isCloudLock    = /(?:^|\/)api\/cloud\/lock\/?$/.test(path);
  const isCloudLockDel = /(?:^|\/)api\/cloud\/lock_del\/?$/.test(path);
  const isCloudDelete  = /(?:^|\/)api\/cloud\/delete\/?$/.test(path);

  if (method === 'OPTIONS'){
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  try {
    let rawBody = event.body || '';
    if (event.isBase64Encoded){
      rawBody = Buffer.from(rawBody, 'base64');
    }
    if (isRecognize && method === 'POST'){
      // v3.46 前端以 JSON {audio: base64} 发送（函数 URL 仅无损传文本）
      const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
      let audioB64 = '';
      try { audioB64 = JSON.parse(text).audio || ''; } catch { audioB64 = ''; }
      const buf = Buffer.from(audioB64, 'base64');
      if (!buf.length) return fail('空音频');
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      return await handleRecognize(process.env, ab);
    }
    if (isDebug && method === 'POST'){
      const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
      let audioB64 = '';
      try { audioB64 = JSON.parse(text).audio || ''; } catch { audioB64 = ''; }
      const buf = Buffer.from(audioB64, 'base64');
      if (!buf.length) return fail('空音频');
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      return await handleDebug(process.env, ab, event);
    }
    if (isSearch && method === 'POST'){
      const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
      let q = '';
      try { q = JSON.parse(text).q; } catch { q = ''; }
      return await handleSearch(q);
    }
    /* v3.84 云端曲库路由 */
    if (isCloudConfig && method === 'GET') return handleCloudConfig();
    if (isCloudList && method === 'GET') return await handleCloudList();
    if (isCloudPresign && method === 'GET') return await handleCloudPresign(eventQuery(event));
    if (isCloudLock && method === 'GET') return await handleCloudLock(eventQuery(event));
    if ((isCloudDelete || isCloudLockDel) && method === 'POST'){
      const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
      let body = {};
      try { body = JSON.parse(text); } catch { body = {}; }
      return isCloudDelete ? await handleCloudDelete(body)
                           : await handleCloudLockDel(body);
    }
    return fail('Not found: ' + path, 404);
  } catch (e){
    return fail('云函数内部错误: ' + (e && e.message ? e.message : String(e)), 500);
  }
};
