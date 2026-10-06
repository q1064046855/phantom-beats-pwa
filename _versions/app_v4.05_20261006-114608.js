/* ============================================================
   幻彩律动 · PHANTOM BEATS  v3.16
   - 单形态：镜像波形 · 三频律动
   - 低音/中音/高音 = 平滑镜像波带
   - 配色自动：音量越大越暖，纯度越高越冷
   - 背景：银河系穿行星空(向前飞，速度随 BPM)
   - 三频 (bass / mid / treble) 独立律动
   - 歌词：深空飞掠（3D 透视，从远处朝用户飞来、掠过下方出屏）
   - 任意音源：系统音频 (WASAPI 内录) / 本地文件 / 麦克风
   ============================================================ */

const FFT_BINS = 64;
const VERSION = 'v4.05';
/* v4.04：版本横幅——每次更新后提示一次（iOS PWA 缓存顽固，若界面异常务必彻底关闭重开） */
(function(){
  try{
    const last = localStorage.getItem('pb_appver');
    if (last && last !== VERSION){
      setTimeout(() => setStatus('⬤ 已更新 ' + VERSION + '：如功能异常请彻底关闭应用后重开'), 2000);
    }
    localStorage.setItem('pb_appver', VERSION);
  }catch(e){}
})();

/* v3.83 PWA：注册 Service Worker（添加到主屏幕 = 手机 App 体验）。
 * 仅 HTTPS / localhost 下浏览器允许注册；局域网 http://IP 访问自动跳过，功能不受影响。 */
if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' ||
     location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  addEventListener('load', () => {
    // v3.92：新版 SW skipWaiting+claim 接管后，页面自动重载一次（防旧 SW 缓存
    // 让用户一直跑旧 app.js）；sessionStorage 标志防止极端情况下重载循环
    let reloaded = false;
    try { reloaded = sessionStorage.getItem('pb_sw_reload') === '1'; } catch(e) {}
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      try { sessionStorage.setItem('pb_sw_reload', '1'); } catch(e) {}
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

/* ---------- v3.46 云端模式（GitHub Pages HTTPS） ----------
 * HTTP  → 走本机 Python 服务器（WS + WASAPI 内录）
 * HTTPS → 走 Cloudflare Worker（手机麦克风 + HTTP API）
 * API 地址可用 ?api=https://xxx 临时覆盖（测试用） */
const CLOUD_MODE = location.protocol === 'https:';
let API_BASE = '';
(function(){
  const u = new URLSearchParams(location.search).get('api');
  if (u){ API_BASE = u; try { localStorage.setItem('pb_api', u); } catch(e){} }
  else {
    try { API_BASE = localStorage.getItem('pb_api') || ''; } catch(e){}
  }
  if (!API_BASE) API_BASE = 'https://1500096649-gt1fwk9njl.ap-guangzhou.tencentscf.com';
})();

/* ---------- 配色 ---------- */
const COLOR_PALETTES = {
  // 自动模式：hue 由音量 level (0..1) 驱动；音色越纯(purity) 越偏冷
  rainbow: {
    base: () => {
      const lvl = Math.min(1, state.level / 1.6);
      // 静 → 冷蓝 220°，高潮 → 火红 0°
      let hue = lerp(220, 0, lvl);
      // 纯度越高(高音占比大) 越往冷色推；只在有一定音量时生效
      hue -= state.purity * 45 * Math.max(0, lvl - 0.15);
      return hue + t * 8;
    },
    span: () => {
      const lvl = Math.min(1, state.level / 1.6);
      // 静时全色谱 360°，高潮时收窄到 130°(聚焦暖色)
      return lerp(360, 130, lvl);
    },
  },
  neon:    { base: () => 270,    span: 80  },
  fire:    { base: () => 0,      span: 60  },
  aurora:  { base: () => 130,    span: 80  },
  gold:    { base: () => 320,    span: 60  },
};

function lerp(a, b, t){ return a + (b - a) * t; }

/* ---------- DOM ---------- */
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
// v3.81 手势按钮覆盖层：锁定/编辑/解锁按钮画在这里（z-index 高于设置/播放器面板，
// pointer-events:none 不挡点击），避免打开设置面板时按钮被盖住
const lockOverlay = document.getElementById('lockOverlay');
const octx = lockOverlay.getContext('2d');
const ui = document.getElementById('ui');
const hint = document.getElementById('hint');
const statusEl = document.getElementById('status');
let W = 0, H = 0, DPR = 1;

/* ---------- State ---------- */
const state = {
  colorPalette: 'rainbow',
  sens: 1.4,
  smooth: 0.42,
  glow: 1.4,
  lw: 1.6,
  source: 'system',
  vocalEnhance: true,     // v3.46f 识别前人声提纯（削低音鼓点+提人声频段）
  sysFrame: null,
  wsConnected: false,
  spec: new Float32Array(FFT_BINS),
  bass: 0, mid: 0, treble: 0, level: 0,
  gate: 0,               // 0..1 自适应噪声门限：无音乐时压回 0、波形归零；有音乐时恢复 1
  purity: 0,             // 0..1，高 = 音色纯净(高音占比大)
  bpm: 0,                // 估算节拍(BPM)，驱动星空飞行速度
  lastBeatTime: 0,       // 上次节拍时间戳(s)
  // 歌词同步
  lyrics: {
    lines: [],            // [{time: 0.0, text: '...'}, ...] 已排序
    title: '',
    artist: '',
    source: '',           // 'audd' | 'manual' | 'netease' | 'manual_netease' ...
    audioOffsetSec: 0,    // 服务器发歌词时报告的累计音频时长(秒)
    wallTimeAtLyricSec: 0,// 客户端收到歌词的 wall clock 时间(秒)
    userOffsetSec: 0,     // 用户手动前后调整 (秒)
  hidden: false,        // 歌词开关：true=不再显示（记录/历史全部保留）
},
  // 歌词自动跟随（DJ 混音场景：歌词放完后等30秒自动识别下一首——延后10秒让15s识别窗口避开上一首尾声，3次失败转纯DJ模式）
  autoLock: {
    enabled: true,
    grace: 30,           // 歌词放完后等待秒数（v3.39：20→30）
    nextAt: 0,           // 客户端推算的下次触发时间戳(performance.now())
  },
  wsAudioTime: 0,         // 最近一帧 WS frame 携带的 at
  wsWallTime: 0,          // 对应的客户端 wall clock
};
let t = 0, lastTs = performance.now();

/* ============================================================
   v3.52 IndexedDB 持久层
   stores: files（歌曲文件本体 File）/ meta（library 曲库清单、locks 歌词锁定）
   v4.00：+spec（离线频谱字节帧缓存）；meta 增加 liked_bak/recent_bak 镜像
   ============================================================ */
const IDB_NAME = 'phantom-beats', IDB_VER = 2;
let _idb = null;
function idbOpen(){
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB_NAME, IDB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('spec')) db.createObjectStore('spec');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function _idbReq(store, mode, fn){
  return new Promise((res, rej) => {
    const tr = _idb.transaction(store, mode);
    const rq = fn(tr.objectStore(store));
    tr.oncomplete = () => res(rq ? rq.result : undefined);
    tr.onerror = () => rej(tr.error);
    if (rq) rq.onsuccess = () => res(rq.result);
  });
}
function idbGet(store, key){ return _idbReq(store, 'readonly', s => s.get(key)); }
function idbPut(store, key, val){ return _idbReq(store, 'readwrite', s => s.put(val, key)); }
function idbDel(store, keys){
  return _idbReq(store, 'readwrite', s => { keys.forEach(k => s.delete(k)); return null; });
}

/* ---------- Helpers ---------- */
function hueBase(){ return COLOR_PALETTES[state.colorPalette].base() % 360; }
function hueSpan(){ return COLOR_PALETTES[state.colorPalette].span; }
function hsl(h,s,l){ return `hsl(${((h%360)+360)%360}, ${s}%, ${l}%)`; }
function hsla(h,s,l,a){ return `hsla(${((h%360)+360)%360}, ${s}%, ${l}%, ${a})`; }

function band(spec, lo, hi){
  let s = 0, c = 0;
  const h = Math.min(hi, spec.length);
  for (let i = lo; i < h; i++){ s += spec[i]; c++; }
  return c ? s/c : 0;
}

function rainbowStroke(x0, y0, x1, y1, off, aspan, alpha){
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  const h0 = hueBase() + off;
  g.addColorStop(0,   hsla(h0,               100, 60, 0));
  g.addColorStop(0.2, hsla(h0 + aspan*0.2,   100, 65, alpha));
  g.addColorStop(0.8, hsla(h0 + aspan*0.8,   100, 65, alpha));
  g.addColorStop(1,   hsla(h0 + aspan,       100, 60, 0));
  return g;
}

/* ============================================================
   LRC 同步歌词：解析 + 按音频累计时长推进
   ============================================================ */
function parseLRC(lrc){
  if (!lrc) return [];
  const out = [];
  for (const raw of lrc.split(/\r?\n/)){
    const line = raw.trim();
    if (!line) continue;
    // 支持一行多个时间标签：[00:01.00][00:05.00]text
    const stamps = [];
    let body = line;
    const stampRe = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
    let m;
    while ((m = stampRe.exec(line)) !== null){
      stamps.push(parseInt(m[1]) * 60 + parseFloat(m[2]));
      body = body.replace(m[0], '');
    }
    if (!stamps.length) continue;
    const text = body.trim();
    for (const t of stamps) out.push({ time: t, text });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

function currentSongSec(){
  // 从服务器发过的“累计音频时长”外推出现在 wall 时的歌曲位置
  // songSec = audioOffsetSec + (now - wallTimeAtLyricSec) + userOffsetSec
  if (!state.lyrics.lines.length) return 0;
  // v3.52：锁定歌词激活时，歌曲位置直接以播放器进度−锁定起点推算（最稳）
  // v3.72：手动覆盖优先——按覆盖开始时的锚点推算（锁定篇从头、搜索版本对齐当前位置）
  if (_plManual && state.source === 'player' && playerAudio){
    return playerAudio.currentTime - _plManual.anchorTime +
           _plManual.anchorLyricSec + state.lyrics.userOffsetSec;
  }
  if (_plLockActive && state.source === 'player' && playerAudio){
    return playerAudio.currentTime - _plLockActive.start + state.lyrics.userOffsetSec;
  }
  const wallNow = performance.now() / 1000;
  return state.lyrics.audioOffsetSec + (wallNow - state.lyrics.wallTimeAtLyricSec) + state.lyrics.userOffsetSec;
}

/* v3.75：当前是否真的有歌词在播放（用于左上角歌名胶囊/搜索框显隐）
   · 非播放器源（系统内录/云端/麦克风）：有歌名且有歌词行=播放中
   · 播放器 + 手动覆盖：播放中
   · 播放器 + 锁定数据：播放位置落在任一段内才算（段外=无歌词播放）
   · 播放器 + 无锁定数据：搜索/识别到的歌词照常播放 */
function _lyricsArePlaying(){
  const has = !!(state.lyrics.title && state.lyrics.lines.length);
  if (state.source !== 'player') return has;
  if (_plManual) return true;
  const data = _plCurLocks();
  if (data && data.segments.length){
    const p = playerAudio.currentTime;
    return data.segments.some(s => p >= s.start && p <= s.end);
  }
  return has;
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

/* ============================================================
   星空背景 = 静态宇宙星(铺满全屏、轻微闪烁、不前飞) + 银河系穿行(向前飞)
   ============================================================ */
const STAR_COUNT = 520;       // 穿行星
const STARS = [];
const BG_STAR_COUNT = 560;    // 静态宇宙背景星
const BG_STARS = [];

function initStars(){
  STARS.length = 0;
  BG_STARS.length = 0;
  // Mulberry32 种子随机 → 初始分布稳定
  let s = 1337;
  const rand = () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < STAR_COUNT; i++){
    const warm = rand() < 0.08;
    const z = 0.1 + rand() * 0.9;      // 深度：越大越远(越靠中心)
    STARS.push({
      x: (rand()*2 - 1) * 0.5,
      y: (rand()*2 - 1) * 0.5,
      z, pz: z,
      size: 0.4 + rand() * rand() * 2.6,   // 各种大小
      tw: 0.5 + rand() * 0.5,
      warm,
      hue: warm ? (10 + rand()*20) : (200 + rand()*40),
    });
  }
  // 静态背景星：归一化坐标(随窗口缩放)，铺满全屏含远处
  for (let i = 0; i < BG_STAR_COUNT; i++){
    const warm = rand() < 0.08;
    BG_STARS.push({
      nx: rand(), ny: rand(),
      size: 0.25 + rand() * rand() * 1.9,   // 多数细小，少数稍大
      depth: 0.6 + rand() * 0.6,            // 视差深度：越大(越近)随镜头偏移越多
      tw: 0.35 + rand() * 0.5,
      twSpeed: 0.4 + rand() * 1.8,
      phase: rand() * Math.PI * 2,
      warm,
      hue: warm ? (10 + rand()*20) : (205 + rand()*35),
    });
  }
}

// 银河系穿行：星星从中心(远处)向四周加速飞出、擦肩而过
// 飞行速度跟随 BPM（静音极慢往前飘，节奏越快越快）
function drawWarpSky(dt){
  const cx = W * 0.5, cy = H * 0.5;
  const focal = Math.max(W, H) * 0.9;
  const speed = Math.min(1.4, 0.18 + (state.bpm / 60) * 0.4);   // 深度/秒（缓慢前进↔加速前进）
  const dz = speed * Math.max(dt, 0.0001);

  ctx.lineCap = 'round';
  const warpN = _powerSave ? 320 : STARS.length;   // v3.95 省电：520→320
  for (let i = 0; i < warpN; i++){
    const s = STARS[i];
    s.pz = s.z;
    s.z -= dz;
    if (s.z <= 0.12){
      // 飞过观察者 → 在远处重生
      s.x = (Math.random()*2 - 1) * 0.5;
      s.y = (Math.random()*2 - 1) * 0.5;
      s.z = 1.0; s.pz = 1.0;
      s.warm = Math.random() < 0.08;
      s.size = 0.4 + Math.random() * Math.random() * 2.6;
      s.hue = s.warm ? (10 + Math.random()*20) : (200 + Math.random()*40);
      continue;
    }
    const k  = focal / s.z;
    const pk = focal / s.pz;
    const x  = cx + s.x * k,  y  = cy + s.y * k;
    const px = cx + s.x * pk, py = cy + s.y * pk;
    const near = 1 - s.z;                       // 0 远 .. 1 近
    const a = (0.12 + 0.88 * near) * s.tw;   // 远处也保持微弱可见，越近越亮
    ctx.strokeStyle = hsla(s.hue, s.warm ? 70 : 50, 90, a * 0.9);
    ctx.lineWidth = 0.4 + near * (s.size * 1.7);
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(x, y);
    ctx.stroke();
    // 近处大头星加亮核 → 擦肩而过感
    if (s.z < 0.4){
      ctx.fillStyle = hsla(s.hue, s.warm ? 60 : 45, 96, a);
      ctx.beginPath();
      ctx.arc(x, y, ctx.lineWidth * 0.55, 0, Math.PI*2);
      ctx.fill();
    }
  }
}

// 静态宇宙背景星：铺满全屏、固定位置、轻微闪烁，不前飞
// → 保证远处/中心始终有星，像真实星空
//
// ⚠️ 帧预算真凶（v3.24 修复，与歌词 v3.23 的字形缓存同一思路）：
//    旧实现每帧为 560 颗星逐个 beginPath+arc+fill，且每颗都要现场拼 hsla 字符串
//    （每帧 ~640 次 arc 填充 + ~1100 个颜色字符串 → GC 压力）。
//    实测单帧 5.0ms —— 占 60fps 帧预算（16.7ms）的 30%，是全页最贵的一笔
//    （对比：drawMirror 三条波形仅 0.028ms、drawWarpSky 1.4ms、update 0.002ms）。
//    新做法：按「色相桶(6°) × 有无光晕」把星盘只光栅化一次成小精灵（≤20 张），
//    每星的精灵引用与绘制半径缓存在星对象上（hue/size 初始化后不变），
//    之后每帧每星只做一次 globalAlpha + drawImage。
//    实测 5.0ms → 1.9ms（快 ~2.6 倍），且每帧 ~1100 个 hsla 字符串清零（GC 顿挫源）。
//    观感 1:1 保留：逐星 sin 闪烁、逐星 depth 视差、大小分布、大星光晕全不变。
const BG_SPR_R  = 8;               // 精灵内核心盘基准半径(px)，绘制时按星径缩放
const _bgSprites = new Map();      // key: 色相桶 + '|' + 有无光晕

function getBgStarSprite(hue, warm, halo){
  const bucket = Math.round(hue / 6) * 6;      // 6° 一桶，色差≤3° 不可辨
  const key = bucket + '|' + (halo ? 1 : 0);
  let spr = _bgSprites.get(key);
  if (spr) return spr;

  const R = BG_SPR_R, haloR = R * 3, pad = 2;
  const S = (halo ? haloR : R) + pad;          // 精灵半边长
  const cv = document.createElement('canvas');
  cv.width = cv.height = S * 2;
  const g = cv.getContext('2d');
  const c = S;                                 // 圆心

  // 光晕先画（α=0.14，绘制时再被 globalAlpha 等比缩放）→ 与旧版 halo 观感一致
  if (halo){
    g.fillStyle = hsla(bucket, warm ? 60 : 45, 80, 0.14);
    g.beginPath(); g.arc(c, c, haloR, 0, Math.PI * 2); g.fill();
  }
  // 核心盘（不透明，亮度同旧版 l=92）
  g.fillStyle = hsla(bucket, warm ? 70 : 35, 92, 1);
  g.beginPath(); g.arc(c, c, R, 0, Math.PI * 2); g.fill();

  spr = { cv, r: halo ? haloR : R };
  _bgSprites.set(key, spr);
  return spr;
}

function drawBgStars(now){
  ctx.globalCompositeOperation = 'source-over';
  // 极缓慢的镜头偏移(左/上/下小幅游走) → 像往前飞行时的相机晃动，幅度很小
  const panX = Math.sin(now * 0.2) * W * 0.012;
  const panY = Math.cos(now * 0.14) * H * 0.015;
  const bgN = _powerSave ? 340 : BG_STARS.length;   // v3.95 省电：560→340
  for (let i = 0; i < bgN; i++){
    const s = BG_STARS[i];
    // 星的 hue/warm/size 初始化后不变 → 精灵与绘制半径只算一次，缓存在星对象上
    // （避免每帧 560 次 Map 查找 + 拼 key 字符串）
    if (!s._spr){
      s._spr = getBgStarSprite(s.hue, s.warm, s.size > 1.1);
      s._d = (s.size / BG_SPR_R) * s._spr.r;
    }
    const x = s.nx * W + panX * s.depth;
    const y = s.ny * H + panY * s.depth;
    const a = s.tw * (0.45 + 0.55 * Math.sin(now * s.twSpeed + s.phase)) * 0.8;
    // 半径映射：核心盘画到 size px；带光晕的精灵按 3 倍半径铺开
    const d = s._d;
    ctx.globalAlpha = a > 1 ? 1 : (a < 0 ? 0 : a);
    ctx.drawImage(s._spr.cv, x - d, y - d, d * 2, d * 2);
  }
  ctx.globalAlpha = 1;   // 必须复位：否则波形/歌词继承半透明
}

/* ---------- Resize ---------- */
/* v3.90 强制横屏（html.rot90）：body 旋转 90° 后，画布宽度=视口高、高度=视口宽 */
function _isRot90(){ return document.documentElement.classList.contains('rot90'); }
/* v3.93 rot90 定位加固：transform 体内 fixed 元素的包含块行为各引擎不一致
   （iOS 实测「控制台」按钮只露一角）。rot90 时把关键控件改成 absolute
   （包含块=body 本地盒），并由 JS 按 innerHeight/innerWidth 显式定 body 尺寸；
   退出 rot90 时全部还原，不影响普通布局。 */
const _rotUiIds = ['showBtn', 'sideBtnRow', 'topSearchRow', 'nowPlaying'];
function _rotUiFix(){
  const on = _isRot90();
  document.body.style.width  = on ? W + 'px' : '';
  document.body.style.height = on ? H + 'px' : '';
  const mobile = matchMedia(
    '(max-width:820px),(pointer:coarse) and (orientation:landscape) and (max-height:520px)'
  ).matches;
  const apply = on && mobile;
  _rotUiIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.position = apply ? 'absolute' : '';
  });
}
function resize(){
  DPR = window.devicePixelRatio || 1;
  if (_isRot90()){ W = window.innerHeight; H = window.innerWidth; }
  else { W = window.innerWidth; H = window.innerHeight; }
  canvas.width  = W * DPR;
  canvas.height = H * DPR;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  // v3.81 覆盖层与主画布同尺寸同步
  lockOverlay.width  = W * DPR;
  lockOverlay.height = H * DPR;
  lockOverlay.style.width  = W + 'px';
  lockOverlay.style.height = H + 'px';
  octx.setTransform(DPR, 0, 0, DPR, 0, 0);
  _rotUiFix();   // v3.93：须在 W/H 更新后
  try { _sprites.clear(); } catch(_){}  // v3.46e（首次 resize 早于其定义）
  initStars();
}
window.addEventListener('resize', resize);
// v3.41 移动端：旋转屏后等系统布局稳定再重算
window.addEventListener('orientationchange', () => setTimeout(resize, 200));
resize();

/* v3.90 强制横屏坐标换算：
   body 被 translateX(100vw)+rotate(90°) 后，视口点(clientX,clientY) 对应
   body 内画布点 (clientY, innerWidth - clientX)。所有画布/编辑页手势
   先经 _rotXY 转到 body 坐标系，内部逻辑零改动。 */
function _rotXY(e){
  if (!_isRot90()) return e;
  return { clientX: e.clientY, clientY: window.innerWidth - e.clientX };
}
/* getBoundingClientRect 返回的是旋转后的视口 AABB；转回 body 空间矩形
   （宽高互换、原点映射），供编辑页用 rect 做的比例换算继续成立。 */
function _rotRect(r){
  if (!_isRot90()) return r;
  const left = r.top, top = window.innerWidth - r.right;
  return { left, top, width: r.height, height: r.width,
           right: left + r.height, bottom: top + r.width };
}

/* ============================================================
   形态渲染器：镜像波形 · 三频律动 (第一版还原 + 星空/自动配色)
   低音 / 中音 / 高音 均为平滑镜像波带
   ============================================================ */
function drawMirror(){
  const cy = H * 0.5;
  const gate = state.gate;   // 0..1 噪声门限
  // 低音 → 平滑镜像波带
  const arrBass = subMirrorSpec(state.spec, 0, state.spec.length*0.12);
  mirrorStrokeWave(arrBass, cy, H * 0.34 * gate, true, 0, 60, state.lw * 1.7, state.glow * (0.3 + 0.7 * gate));
  // 中音 → 平滑镜像
  const arrMid = subMirrorSpec(state.spec, state.spec.length*0.12, state.spec.length*0.45);
  mirrorStrokeWave(arrMid, cy, H * 0.22 * gate, true, 90, 90, state.lw * 1.3, state.glow * (0.3 + 0.7 * gate));
  // 高音 → 平滑镜像
  const arrHi  = subMirrorSpec(state.spec, state.spec.length*0.45, state.spec.length);
  mirrorStrokeWave(arrHi, cy, H * 0.14 * gate, true, 200, 130, state.lw, state.glow * (0.3 + 0.7 * gate));
}

function subMirrorSpec(s, a, b){
  a = Math.floor(a); b = Math.floor(b);
  const out = new Float32Array(Math.max(1, b - a));
  for (let i = 0; i < out.length; i++) out[i] = s[a + i] || 0;
  return out;
}

function mirrorStrokeWave(arr, cy, amp, mirror, hOff, hSpan, lw, glow){
  const n = arr.length; if (n < 2) return;
  const x0 = W*0.04, x1 = W*0.96;
  ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.shadowBlur = 16 * glow;
  const stroke = rainbowStroke(x0, cy, x1, cy, hOff + t*30, hSpan, 62);
  ctx.strokeStyle = stroke;
  ctx.shadowColor = hsl((hueBase() + hOff + hSpan/2) % 360, 100, 60);
  for (let pass = 0; pass < (mirror ? 2 : 1); pass++){
    const dir = pass === 0 ? -1 : 1;
    ctx.beginPath();
    for (let i = 0; i < n; i++){
      const x = x0 + (i/(n-1)) * (x1 - x0);
      const y = cy + dir * arr[i] * amp;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
}

/* ============================================================
   update + loop
   ============================================================ */
function update(){
  let spec;
  if (state.sysFrame){
    spec = state.sysFrame;
  } else {
    spec = new Float32Array(FFT_BINS);
  }
  // 平滑
  for (let i = 0; i < FFT_BINS; i++){
    state.spec[i] = state.spec[i]*state.smooth + spec[i]*(1 - state.smooth);
  }
  state.bass   = band(state.spec, 0, 8)  * state.sens;
  state.mid    = band(state.spec, 8, 24) * state.sens;
  state.treble = band(state.spec, 24,56) * state.sens;
  state.level  = (state.bass + state.mid + state.treble) / 3;
  // --- 自适应噪声门限：能量低于阈值则关闭波形（避免静音时三线抖动）---
  // 总能量 = bass+mid+treble（已乘 sens）。阈值用平滑后的能量做参考，
  // 再加一个固定下限兜底（即使灵敏度高也能识别静音）。带迟滞防抖。
  if (!state._eHist){ state._eHist = state.level; }
  state._eHist = state._eHist * 0.9 + state.level * 0.1;        // 0.5~1s 时间窗
  const energy = state.bass + state.mid + state.treble;          // 瞬时总能量
  const threshold = Math.max(0.18, state._eHist * 1.4 + 0.06);   // 静音<阈值 → 关门
  const targetGate = energy < threshold ? 0 : Math.min(1, (energy - threshold) / (threshold * 1.5));
  // 迟滞：开闸快（攻 0.20）、闭闸慢（释 0.06），免边界抖
  state.gate = state.gate + (targetGate - state.gate) * (targetGate > state.gate ? 0.20 : 0.06);
  // 音色纯度 = 高音占比 (treble 越突出 → 音色越纯净)
  const total = state.bass + state.mid + state.treble + 0.0001;
  state.purity = Math.min(1, (state.treble / total) * 2.0);

  // --- BPM / 节拍跟踪（驱动星空旋转速度）---
  const now = performance.now() / 1000;
  if (!state._bassHist){
    state._bassHist = new Float32Array(43);
    state._bassHistIdx = 0;
    state.lastBeatTime = 0;
    state.bpm = 0;
  }
  state._bassHist[state._bassHistIdx] = state.bass;
  state._bassHistIdx = (state._bassHistIdx + 1) % state._bassHist.length;
  let avg = 0; for (let i = 0; i < state._bassHist.length; i++) avg += state._bassHist[i];
  avg /= state._bassHist.length;
  const th = Math.max(0.12, avg * 1.35);
  if (state.bass > th && state.bass > 0.25 && now - state.lastBeatTime > 0.25){
    if (state.lastBeatTime > 0){
      const interval = now - state.lastBeatTime;
      const instBpm = 60 / interval;
      if (instBpm > 45 && instBpm < 200){
        state.bpm = state.bpm > 0 ? state.bpm * 0.6 + instBpm * 0.4 : instBpm;
      }
    }
    state.lastBeatTime = now;
  }
  // 长时间无节拍 → BPM 缓慢回落
  if (now - state.lastBeatTime > 2.0){
    state.bpm *= 0.96;
    if (state.bpm < 0.5) state.bpm = 0;
  }
}

const nowPlaying = document.getElementById('nowPlaying');
const npTitleEl = document.querySelector('#nowPlaying .np-title');
let _lastNpTitle = null;
/* v3.95 省电模式（降温/省电）：30fps + 星空/粒子减半。
   v3.96 起 analyser 不再隔帧（每帧都拉，保证节奏即时）；
   手机（pointer:coarse）默认开启；localStorage pb_powersave 记住选择。 */
let _powerSave = false;
try{
  if (localStorage.getItem('pb_powersave') === null){
    _powerSave = !!matchMedia('(pointer:coarse)').matches;
  } else {
    _powerSave = localStorage.getItem('pb_powersave') === '1';
  }
}catch(e){}
let _lastRenderTs = 0;
function loop(ts){
  /* v4.01：整体 try/catch——单帧绘制异常不得杀死主 rAF（否则画面冻结/白屏），
     异常帧跳过，下一帧照常调度 */
  try{
    if (_powerSave && ts - _lastRenderTs < 33) return;
    _lastRenderTs = ts;
    const dt = Math.min(0.05, (ts - lastTs)/1000);
    lastTs = ts;
    t += dt;

    // 左上角：当前播放歌名（仅变化时更新）
    // v3.75：没有歌词正在播放（播放器位于所有锁定段外且无手动覆盖等）→
    //        隐藏左上角歌名，并把歌词搜索框清空（用户之后仍可自行输入新搜索）
    const _np = _lyricsArePlaying() ? (state.lyrics.title || '') : '';
    if (_np !== _lastNpTitle){
      _lastNpTitle = _np;
      if (npTitleEl) npTitleEl.textContent = _np;
      if (nowPlaying) nowPlaying.classList.toggle('show', !!_np);
      if (!_np && typeof subsSearch !== 'undefined' && subsSearch) subsSearch.value = '';
    }

    // 识别按钮读条 / 左上角自动识别倒计时
    updateRecogUI();

    update();

    // 背景拖影(更暗，让星空/光带更突出)
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(0, 0, W, H);

    // 静态宇宙背景星(铺满全屏，含远处；不前飞)
    drawBgStars(t);

    // 银河系穿行星空（飞行速度跟随 BPM）
    ctx.globalCompositeOperation = 'lighter';
    drawWarpSky(dt);

    /* 歌词画在【波形之前】—— 用户要求"音浪波形线条永远在最前面"。
       Canvas 是后绘覆盖先绘，所以歌词必须排在 drawMirror() 之前。
       ⚠️ 必须显式重置混合模式与辉光：drawWarpSky/drawMirror 用了 'lighter'(加色)+shadowBlur，
          若不重置，歌词会继承加色混合 → 看起来像发光字，与"不要发光"的要求冲突。 */
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    if (!dragSeek.active){
      if (state.lyrics.lines.length && !state.lyrics.hidden) drawLyricsFly(ctx);
    }

    // 主形态（音浪波形，永远在最前层）
    drawMirror();

    // v3.44: 左键拖拽对齐模式——悬浮歌词浮层画在波形之上
    if (dragSeek.active) drawDragSeek(ctx);
  }catch(e){}
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* ============================================================
   歌词渲染: 当前行加粗高亮 + 上一行/下一行 带透明度
   ============================================================ */
// 歌词飞入状态（每个活跃歌词行独立状态）
const _flyLines = [];  // [{text, x,y,z,opacity,scale,time,born}]  z=0远处 z=1屏幕
const _FLY_DURATION = 2.8;   // 飞入全程秒数
const _FLY_HOLD     = 2.2;   // 居中停留秒数
const _FLY_FADEIN   = 0.35;  // 淡入秒数
const _FLY_FADEOUT  = 0.55;  // 淡出秒数
let   _lastLyricIdx = -1;    // 上帧歌词索引

// ============================================================
//  深空飞掠歌词 · Lyrics Flight Through Deep Space
//  ------------------------------------------------------------
//  视觉目标：用户开着飞船【向前飞】，歌词悬浮在下方路面上，
//  从中心点（灭点）迎面涌出 → 逐渐变大 → 从屏幕【下缘】掠过 → 消失。
//  —— 像飞船贴地掠过一排排悬浮的字幕。
//
//  ⚠️ 本项目最大的理解错误（v3.16~v3.20 全栽在这）：
//     火车"一节节从身边开过去"指的是【形式】（连续、贴地、擦身而过），
//     **不是**让字横着从侧面飞。我曾两次理解错：
//       v3.16  py 锁死在一条水平线上  → 字钉在屏幕中央不动，像静止字幕
//       v3.19  让字往右横着扫出画面  → 变成"从侧面飞过去"（方向错了）
//     正确的是【地面透视】：相机高于文字平面，字铺在下方"路面"上。
//
//  投影（相机在原点看向 -z，文字平面在相机下方 CAM_H 处）：
//     k  = FOCAL / z            缩放系数，z→0 时爆增
//     py = HORIZON + CAM_H * k  灭点(屏幕 40% 高度) → 越近越靠下 → 掠出下缘
//     fs = FONT_UNIT * k        越近越大
//     px = cx - tw/2            完全居中，不偏不摇
//
//  ★ py 与 fs 共用同一个 k → "变大"与"压下来"天然同步，结构上不可能脱节。
//  ★ 全程一条直线 z = Z_NEAR + ahead*Z_PER_SEC，无分段无指数 → 无速度突变。
//
//  ahead = ln.time - now（歌曲秒）
//    ahead > 0 → 未来：在灭点附近排队，边飞近边变大
//    ahead = 0 → 当前：屏幕 78% 高度，字最清晰
//    ahead < 0 → 已掠过：从下缘擦出去，加速离场
// ============================================================
// ============================================================
//  矢量字形缓存 · Lyric Sprite Cache
//  ------------------------------------------------------------
//  ★ 流畅度的根本解法。
//
//  【旧做法为什么不流畅】
//    每帧执行 ctx.font = 'bold ' + fs + 'px ...'; ctx.fillText(...)
//    Canvas 的 font-size 【只接受整数 px】—— 小数部分被直接丢弃。
//    实测：字号从 16px 涨到 93px 共 600 帧，但字号每 8.6 帧才变 1px，
//    其余 8 帧画面完全静止 → 视觉上就是「一卡一卡」的台阶。
//    （而且每帧还要 measureText，Canvas 最贵的操作之一，歌词一多就掉帧。）
//
//  【新做法】
//    1) 每条歌词只在【首次出现】时，用 GLYPH_PX（大字号）渲染到一张离屏画布，
//       连带深色描边一起画好 → 得到一张清晰的矢量字形。
//    2) 之后每帧只做 drawImage + ctx.scale，缩放比是【连续浮点】，
//       每帧都在变 → 零台阶，真正流畅。
//    3) 附带收益：measureText 只在缓存时调用一次；drawImage 比 fillText 快得多。
//
//  为什么放大不会糊：离屏画布按【最大可能字号】渲染，
//  实际显示时只会缩小或等比放大到接近原尺寸，浏览器用双线性过滤采样，边缘依旧锐利。
// ============================================================

const GLYPH_PX   = 160;                       // 字形基准字号（v3.25: 120→160，掠出末端 ≈150px 仍锐利）
const SPR_PAD    = Math.ceil(GLYPH_PX * 0.30); // 描边与辉光的安全边距
const SPR_MAX    = 64;                        // 最多缓存多少条（防内存膨胀）
const _sprites   = new Map();                 // key: text + '|' + variant

function getLyricSprite(text, bright){
  const key = text + '|' + (bright ? 1 : 0);
  const hit = _sprites.get(key);
  if (hit) return hit;

  // 缓存满了：清掉最旧的一半（Map 保持插入序）
  if (_sprites.size >= SPR_MAX){
    const drop = Math.floor(SPR_MAX / 2);
    let n = 0;
    for (const k of _sprites.keys()){
      _sprites.delete(k);
      if (++n >= drop) break;
    }
  }

  // 用主 ctx 的字体度量来量出基准尺寸
  const fontStr = 'bold ' + GLYPH_PX + 'px "Microsoft YaHei",sans-serif';
  const prevFont = ctx.font;
  ctx.font = fontStr;

  /* ⚠️ v3.40 修复"长句飞到面前后停住、只往下平移"：
     drawLyricsFly 的超宽保护 kx 会把 fsDraw 钉死在 maxW·GLYPH_PX/spr.w
     （与 k 无关的常数）——长句刚淡入（t≈0.09）就触发 kx，此后字号/宽度
     全程冻结，只剩 py 匀速下移，正是用户看到的"停住+平移往下"。
     根治：超宽单行在【光栅化时拆成多行】。拆行阈值取"当前句时刻
     (t=0.5, k=K_FAR+K_SPAN/2=2160) 恰好占满 maxW"的宽度——每行都窄于它，
     kx 在靠近段(t≤0.5)就永不会触发，字号随 t 正常连续增长。
     ⚠️ 与 drawLyricsFly 的 K_FAR=560 / K_SPAN=3200 / FONT_UNIT=0.040·H_SCALE
     / maxW=0.88W 耦合（11 = 0.88·GLYPH_PX·1080/(0.040·2160·1080)·(H/W)…化简
     得 11·GLYPH_PX·W/H−2·SPR_PAD），改那些参数必须重解这里。 */
  /* v3.46e 竖屏不拆行：宽高比下限按 16/9 计算——竖屏时常规句也保持单行横排，
     与横屏表现一致；仅超长句（横屏也放不下时）才拆行 */
  const aspect = Math.max(((W > 0 && H > 0) ? W / H : (16 / 9)), 16 / 9);
  const maxGlyphW = Math.max(400, 11 * GLYPH_PX * aspect - SPR_PAD * 2);

  // 贪心按像素宽断行：前 n-1 行每行 ≈ targetW，末行收尾
  const fullW = ctx.measureText(text).width;
  const rows = [text];
  if (fullW > maxGlyphW){
    const n = Math.ceil(fullW / maxGlyphW);
    const targetW = fullW / n;
    rows.length = 0;
    let cur = '', curW = 0;
    for (const ch of text){
      const cw = ctx.measureText(ch).width;
      if (cur && curW + cw > targetW && rows.length < n - 1){
        rows.push(cur);
        cur = (ch === ' ') ? '' : ch;      // 断行处吞掉空格，避免行首空格
        curW = (ch === ' ') ? 0 : cw;
      } else { cur += ch; curW += cw; }
    }
    if (cur) rows.push(cur);
  }

  let asc = 0, dsc = 0, w = 1;
  for (const r of rows){
    const m = ctx.measureText(r);
    asc = Math.max(asc, m.actualBoundingBoxAscent  || GLYPH_PX * 0.88);
    dsc = Math.max(dsc, m.actualBoundingBoxDescent || GLYPH_PX * 0.22);
    w = Math.max(w, Math.ceil(m.width));
  }
  const lineH = GLYPH_PX * 1.22;                       // 行距
  const h = Math.max(1, Math.ceil(asc + lineH * (rows.length - 1) + dsc));
  ctx.font = prevFont;

  const pad = SPR_PAD;
  const cv = document.createElement('canvas');
  cv.width  = w + pad * 2;
  cv.height = h + pad * 2;
  const g = cv.getContext('2d');

  const bx = pad, by = pad;                  // 字形左上角
  // 基线到字形区顶部的距离 = 最后一行基线（单行时与旧值 asc 完全一致，
  // 绘制公式 yDraw − spr.baseline·sc 不变：末行基线锚在 py，上方各行自然向上排）
  const baseline = asc + lineH * (rows.length - 1);

  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.lineJoin = 'round';
  g.miterLimit = 2;
  /* ⚠️ v3.26 修复（"字太小"第二真凶，v3.23 埋雷）：
     g.font 从未被设置 → 离屏上下文用【默认字体 10px sans-serif】画字，
     160px 尺寸的精灵里只有一条 ~90×10px 的墨迹细条（9 个 10px 汉字 ≈ 96px 宽，
     探针实测墨迹右缘 144=48+96 完全吻合）。屏幕上看到的"歌词"一直是
     这条细条缩放后的涂抹。必须在精灵上下文上设置同一个大字号字体。 */
  g.font = fontStr;

  // 深色描边（矢量线框观感 + 在亮波形上可读）——每行各画一次
  g.strokeStyle = bright ? 'rgba(2,5,14,0.86)' : 'rgba(2,5,14,0.62)';
  g.lineWidth = GLYPH_PX * 0.085;
  for (let li = 0; li < rows.length; li++){
    g.strokeText(rows[li], bx, by + asc + lineH * li);
  }

  // 亮色填充（无发光）
  g.fillStyle = bright ? 'rgba(255,255,255,1)' : 'rgba(206,226,252,1)';
  for (let li = 0; li < rows.length; li++){
    g.fillText(rows[li], bx, by + asc + lineH * li);
  }

  const spr = { cv, w: cv.width, h: cv.height, baseline, glyph: GLYPH_PX,
                lines: rows.length, lineH };
  _sprites.set(key, spr);
  return spr;
}

function drawLyricsFly(ctx){
  const arr = state.lyrics.lines;
  if (!arr.length) return;
  const now = currentSongSec();

  /* ---------- 地面透视：飞船从歌词【上方】贴地飞过 ----------
     视觉目标：用户开着飞船向前飞，歌词悬浮在下方路面上，
              从中心点（灭点）迎面涌出 → 变大 → 从屏幕下缘掠过 → 消失。

     ⚠️ v3.16~v3.20 一直理解错在【方向】：
        火车"一节节从身边开过去"指的是**形式**（连续、贴地、擦身而过），
        不是让字横着从侧面飞。
        之前把 py 锁死在一条水平线上（错）、后来又让字往右横着扫（也错）。
        正确的是【地面透视】：相机高于文字平面，字铺在下方"路面"上，
        越近 → 越大 + 越靠下 → 从屏幕下缘擦出去。

     投影（k 为缩放系数，fs 与 py 共用）：
       k  = K_FAR + t * K_SPAN
       py = HORIZON + CAM_H * k
       fs = FONT_UNIT * k
     ★ py 与缩放共用同一个 k → 变大与下坠天然同步，结构上不可能脱节。
     ★ 横向完全居中：用户是"从上面飞过"，不是"从侧面飞过"。

     ⚠️ 流畅度根因（v3.23 修复，见文件上方 getLyricSprite 注释）：
        Canvas 的 ctx.font 字号【只接受整数 px】。旧实现每帧重设字号，
        字号每 8.6 帧才变 1px，其余帧画面完全静止 → "一卡一卡"。
        现在文字只光栅化一次进离屏画布，之后每帧只改【连续浮点缩放矩阵】，
        每帧都在变 → 零台阶。 */
  const HORIZON    = H * 0.40;     // 灭点：歌词从屏幕 40% 高度涌出
  /* ⚠️ v3.25 关键修复：分辨率归一（"字太小根本看不到"的真凶）。
     旧版 CAM_H=0.24、FONT_UNIT=0.0286 是【绝对像素】，只在标定时 H=1080 成立：
     当前句 py = 0.40H + 0.24·2160 = 0.40H + 518px —— 窗口高 H<863px 时整句压在屏幕外！
     （Windows 125% 缩放下 1080p 屏的 CSS 视口高 ≈864px，正好踩线；
       150% 缩放或窗口再矮些 → 当前句永远不出现，只剩远处 16~38px 小字掠过。）
     现在一切绝对量乘 H_SCALE=H/1080 → 任意窗口高度下：
       当前句恒落 0.88H，终点恒飞到 1.236H（确出下缘），当前句字号恒 ≈8% 屏高。 */
  const H_SCALE    = H / 1080;          // 分辨率归一系数（几何/字号随屏高等比）
  const CAM_H      = 0.24 * H_SCALE;    // 相机高度（按 H=1080 标定，随屏高缩放）
  const FONT_UNIT  = 0.040 * H_SCALE;   // 字号 = FONT_UNIT·k（v3.25 +39%：当前句 62→86px@1080p）
  const MIN_FONT   = 6;            // 太小看不见（只是"不画"，与取整无关）
  const MAX_AHEAD  = 6.5;          // 未来最多看几秒

  /* 缩放进度线性插值：k = K_FAR + t*(K_NEAR - K_FAR)
     t: 0 = 最远(ahead=MAX_AHEAD) → 0.5 = 当前句(ahead=0) → 1 = 掠到尽头

     ⚠️ 为什么用线性 k 而不是 1/z 透视：
        z→0 时 1/z 会爆炸，字号在最后 0.3 秒从 ~200px 猛冲到 ~980px，
        视觉上就是"一卡一卡"（实测单帧跳变 128px）。
        线性插值单帧跳变 <1px，匀速放大，均匀流畅（实测 0.21px）。

     ⚠️ 参数是按 H=1080 标定的，但已归一（v3.25）：CAM_H/FONT_UNIT 都乘 H_SCALE，
        所以落点方程在【任意窗口高度】恒成立：
        py(t=0.5) = 0.40H + 0.24·(2160/1080)·H = 0.88H   → 当前句落屏高 88%
        py(t=1)   = 0.40H + 0.24·(3760/1080)·H ≈ 1.24H   → 终点确实飞出屏幕下缘
        若要改 K_FAR/K_SPAN，必须按上面两条重新解 CAM_H；字号想整体放大/缩小只动 0.040。 */
  const FLY_SEC    = MAX_AHEAD;    // 唱过后再花 MAX_AHEAD 秒掠出（保证 t=0.5 对应当前句）
  const K_FAR      = 560;          // 最远处的缩放（字号 ≈22px@1080p）
  const K_SPAN     = 3200;         // 缩放跨度（当前句 k=2160 → 字号 ≈86px@1080p）
  const FADE_RATE  = 6.0;          // 淡入速率：op = t*FADE_RATE，前 17% 路程淡入

  const cx = W * 0.5;

  // 二分找当前行（最后一条 time <= now 的行）
  let lo = 0, hi = arr.length - 1, curIdx = 0;
  while (lo <= hi){
    const m = (lo + hi) >> 1;
    if (arr[m].time <= now){ curIdx = m; lo = m + 1; }
    else hi = m - 1;
  }

  const startIdx = Math.max(0, curIdx - 3);   // 已唱过的也留 3 行在屏内
  const endIdx   = Math.min(arr.length - 1, curIdx + 20);

  // 由远及近绘制（画家算法：远先画，近的压在上面）

  for (let i = endIdx; i >= startIdx; i--){
    const ln = arr[i];
    const text = (ln.text || '').trim();
    if (!text) continue;

    const ahead = ln.time - now;
    if (ahead > MAX_AHEAD) continue;

    /* ---- 时间 → 缩放进度 → 缩放系数：全程线性，匀速放大 ----
       t: 0 = 最远(刚出现) → 0.5 = 当前句(ahead=0) → 1 = 完全掠出 */
    const t = (MAX_AHEAD - ahead) / (MAX_AHEAD + FLY_SEC);
    if (t < 0) continue;                 // 还在 MAX_AHEAD 之外（未来太远）
    const k = K_FAR + (t > 1 ? 1 : t) * K_SPAN;

    /* 地面透视纵坐标：相机高于文字平面 → 越近越靠下，最终从屏幕下缘掠过。
       与缩放共用同一个 k，所以"变大"与"压下来"天然同步。
       ⚠️ v3.40：py 改用【不封顶】的 k——多行块（v3.40 拆行）在 t=1 时块顶
       仍在屏内（块高 ≈0.65H ≫ 出屏余量 0.16H），若 py 随 t 封顶，块会冻在
       屏内变"幽灵"；让 py 在 t>1 后继续下移直到滑出（配合下方尾程淡出）。 */
    const py = HORIZON + CAM_H * (K_FAR + t * K_SPAN);

    const fsWant = FONT_UNIT * k;        // 目标字号（浮点）
    if (fsWant < MIN_FONT) continue;     // 远处小到看不见 → 不画

    /* ---- 透明度：最远处线性淡入，此后满亮直到掠出 ----
       v3.40 尾程淡出：多行块 t=1 时块顶仍在屏内，直接丢弃会"半块消失"；
       t∈[0.85,1.15] 线性淡出 + py 继续下移 → 平滑滑出。
       单行块 t=0.85 时块顶 = 1.022H 已在屏外（解析可证），视觉零变化。 */
    const op = t * FADE_RATE;
    const tail = t > 0.85 ? (1.15 - t) / 0.30 : 1;
    if (op <= 0.02 || tail <= 0.02) continue;
    let opa = op > 1 ? 1 : op;
    if (tail < 1) opa *= tail;

    // 近度 0(远) → 1(最近/更近)，用于配色与描边粗细
    const near = Math.max(0, Math.min(1, 1 - t));

    /* ---- ★ 矢量文字：每条歌词只光栅化一次，之后靠 transform 缩放 ----
       这才是流畅度的根本解法。
       旧实现每帧重设 ctx.font，而 Canvas 字号【只认整数 px】：
       字号每 8.6 帧才变 1px，其余 8 帧画面完全静止 → 视觉上就是"一卡一卡"的台阶。
       现在把文字按 GLYPH_PX 渲染进离屏画布一次（矢量轮廓），
       之后每帧只改缩放矩阵 —— 缩放比是连续浮点，【每帧都在变】，零台阶。
       附带收益：省掉每帧 N 次 measureText（Canvas 最贵的操作），帧率更稳。 */
    const spr = getLyricSprite(text, near > 0.72);
    if (!spr) continue;

    // 整块（含上方各行）已从下缘完全掠过 → 丢弃
    // v3.40: 多行精灵按块高判定（≈每多一行加 1.22 个字号），单行时退化为旧式 py−fsWant
    const nL = spr.lines || 1;
    if (py - fsWant * (1 + 1.22 * (nL - 1)) > H + 40) continue;

    const sc0 = fsWant / spr.glyph;      // 连续浮点缩放比
    let tw = spr.w * sc0;                // 实际显示宽度
    let kx = 1;                          // 超宽保护系数（连续，不产生台阶）
    const maxW = W * 0.88;
    if (tw > maxW){ kx = maxW / tw; tw = maxW; }

    const sc = sc0 * kx;
    const fsDraw = fsWant * kx;          // 用于底衬等几何计算
    const px = cx - tw * 0.5;            // 横向完全居中
    const xDraw = px, yDraw = py;

    /* ---- 可读性：近处加深色底衬，压住底下的波形高光 ----
       v3.40: 多行精灵底衬罩住整块（nL=1 时与旧公式逐像素一致） */
    if (near > 0.25){
      const scrimA = 0.30 * near;
      const scrimH = fsDraw * (1.75 + 1.22 * (nL - 1));
      const scrimW = Math.min(W * 0.96, tw + fsDraw * 1.5);
      const scx = px + tw * 0.5;
      const g = ctx.createLinearGradient(scx - scrimW/2, 0, scx + scrimW/2, 0);
      g.addColorStop(0,   'rgba(3,6,18,0)');
      g.addColorStop(0.5, 'rgba(3,6,18,' + scrimA.toFixed(3) + ')');
      g.addColorStop(1,   'rgba(3,6,18,0)');
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.fillRect(scx - scrimW/2, py - 1.22 * (nL - 1) * fsDraw - scrimH * 0.66, scrimW, scrimH);
      ctx.restore();
    }

    /* ---- 绘制：drawImage 缩放离屏矢量字 ----
       无发光（不设 shadowBlur），无整数台阶（缩放比是连续浮点）。 */
    ctx.save();
    ctx.globalAlpha = opa;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // 以文字基线为锚点缩放：先移到基线，再按 sc 缩放，最后画到 (xDraw, yDraw)
    const dw = spr.w * sc, dh = spr.h * sc;
    ctx.drawImage(spr.cv, xDraw, yDraw - spr.baseline * sc, dw, dh);
    ctx.restore();
  }
}

// 右侧歌词面板（歌词手动对齐用，显示全部歌词，可点行跳转）
function buildLyricsAllList(){
  const el = document.getElementById('lyricsAllList');
  if (!el) return;
  const arr = state.lyrics.lines;
  if (!arr.length){ el.innerHTML = '<div style="padding:12px 16px;opacity:.45;font-size:13px">暂无歌词，请先识别或搜索</div>'; return; }
  const now = currentSongSec();
  let curIdx = 0;
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi){ const m = (lo+hi)>>1; if(arr[m].time<=now){curIdx=m;lo=m+1;}else hi=m-1; }
  const html = arr.map((ln, i) => {
    const dist = Math.abs(i - curIdx);
    let cls = 'lyric-all-item';
    if (i === curIdx) cls += ' lyric-all-cur';
    else if (dist === 1) cls += ' lyric-all-near';
    return `<div class="${cls}" data-idx="${i}" data-time="${ln.time}"><span class="la-time">${fmtTime(ln.time)}</span><span class="la-text">${escapeHtml(ln.text || '·')}</span></div>`;
  }).join('');
  el.innerHTML = html;
  el.querySelectorAll('.lyric-all-item').forEach(el2 => {
    el2.addEventListener('click', () => {
      const t = parseFloat(el2.dataset.time);
      const wallNow = performance.now() / 1000;
      const songSec = state.lyrics.audioOffsetSec + (wallNow - state.lyrics.wallTimeAtLyricSec);
      state.lyrics.userOffsetSec = t - songSec;
      setStatus('📍 跳到 ' + fmtTime(t) + '（偏移 ' + state.lyrics.userOffsetSec.toFixed(1) + 's）');
    });
  });
  // 滚动到当前行
  setTimeout(() => {
    const cur = el.querySelector('.lyric-all-cur');
    if (cur) cur.scrollIntoView({block:'center', behavior:'smooth'});
  }, 50);
}

function fmtTime(sec){
  const m = Math.floor(sec / 60);
  const s = sec - m*60;
  return m.toString().padStart(2,'0') + ':' + s.toFixed(s < 10 ? 2 : 1).padStart(s < 10 ? 4 : 5, '0');
}

/* ============================================================
   音频：系统 (WS) / 文件 (Web Audio) / 麦克风
   ============================================================ */
let audioCtx = null;
let analyser = null;
let sourceNode = null;
let micStream = null;

/* v3.46 云端识别：15 秒 PCM 环形录音（ScriptProcessor 全平台兼容，含 iOS） */
let _micProc = null;
let _micNode = null;      // v3.46b AudioWorkletNode
let _micMute = null;
let _micCbCount = 0;      // 音频回调次数（诊断用）
let _micRingChunks = [];   // Int16Array 块
let _micRingSamples = 0;
let _micRingCap = 0;
let _micRingSR = 44100;

function _pushMicChunk(i16){
  _micRingChunks.push(i16);
  _micRingSamples += i16.length;
  while (_micRingChunks.length > 1 &&
         _micRingSamples - _micRingChunks[0].length >= _micRingCap){
    _micRingSamples -= _micRingChunks.shift().length;
  }
}

// ============================================================
// v3.46f 人声提纯（提交识别前处理，针对 DJ 重低音场景）
// 单声道麦克风无法做"中置声道提取"，改用：
// ① 高通 150Hz 削鼓点/Bass ② 高频搁架 3kHz +4dB 提人声咬字 ③ 峰值归一化
// ============================================================
function _biquadCoeffs(type, sr, f0, gainDB){
  const A = Math.pow(10, gainDB / 40);
  const w0 = 2 * Math.PI * f0 / sr;
  const cosw = Math.cos(w0), sinw = Math.sin(w0);
  let b0,b1,b2,a0,a1,a2;
  if (type === 'highpass'){
    const alpha = sinw / (2 * 0.707);
    b0 =  (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2;
    a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
  } else { // highshelf
    const alpha = sinw / 2 * Math.sqrt((A + 1/A) * (1/0.707 - 1) + 2);
    const sa = 2 * Math.sqrt(A) * alpha;
    b0 =    A * ((A + 1) + (A - 1) * cosw + sa);
    b1 = -2*A * ((A - 1) + (A + 1) * cosw);
    b2 =    A * ((A + 1) + (A - 1) * cosw - sa);
    a0 =       ((A + 1) - (A - 1) * cosw + sa);
    a1 =    2 * ((A - 1) - (A + 1) * cosw);
    a2 =       ((A + 1) - (A - 1) * cosw - sa);
  }
  return [b0/a0, b1/a0, b2/a0, a1/a0, a2/a0];
}
function _applyBiquad(x, c){
  const [b0,b1,b2,a1,a2] = c;
  let x1=0,x2=0,y1=0,y2=0;
  for (let i=0;i<x.length;i++){
    const xn = x[i];
    const yn = b0*xn + b1*x1 + b2*x2 - a1*y1 - a2*y2;
    x2=x1; x1=xn; y2=y1; y1=yn; x[i]=yn;
  }
}
function enhanceVocal(i16, sr){
  const f = new Float32Array(i16.length);
  for (let i=0;i<i16.length;i++) f[i] = i16[i] / 32768;
  _applyBiquad(f, _biquadCoeffs('highpass', sr, 150, 0));
  _applyBiquad(f, _biquadCoeffs('highshelf', sr, 3000, 4));
  // 峰值归一化到 -1dB；信号过小(≤0.02)不放大噪声
  let peak = 0;
  for (let i=0;i<f.length;i++){ const a = Math.abs(f[i]); if (a>peak) peak=a; }
  const g = peak > 0.02 ? Math.min(6, 0.891 / peak) : 1;
  const out = new Int16Array(i16.length);
  for (let i=0;i<f.length;i++){
    let s = f[i] * g;
    if (s > 1) s = 1; else if (s < -1) s = -1;
    out[i] = s < 0 ? s*32768 : s*32767;
  }
  return out;
}

function captureRingWav(seconds){
  const need = Math.min(_micRingSamples, Math.floor(seconds * _micRingSR));
  const out = new Int16Array(need);
  let off = need;
  for (let i = _micRingChunks.length - 1; i >= 0; i--){
    const c = _micRingChunks[i];
    const take = Math.min(off, c.length);
    out.set(c.subarray(c.length - take), off - take);
    off -= take;
    if (off <= 0) break;
  }
  const finalSamples = (CLOUD_MODE && state.vocalEnhance)
    ? enhanceVocal(out, _micRingSR) : out;
  return encodeWavI16(finalSamples, _micRingSR);
}

function encodeWavI16(samples, sr){
  const bytes = samples.byteLength;
  const buf = new ArrayBuffer(44 + bytes);
  const dv = new DataView(buf);
  const wStr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  wStr(0, 'RIFF'); dv.setUint32(4, 36 + bytes, true);
  wStr(8, 'WAVEfmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wStr(36, 'data'); dv.setUint32(40, bytes, true);
  new Uint8Array(buf, 44).set(new Uint8Array(samples.buffer, samples.byteOffset, bytes));
  return buf;
}

// v3.46 二进制 → Base64 文本（腾讯函数 URL 仅无损传文本，需前端编码）
function arrayBufferToBase64(buf){
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result.split(',')[1]);  // 去掉 data:...;base64, 前缀
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(new Blob([buf]));
  });
}

function ensureAudioCtx(){
  if (!audioCtx){
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    // v3.47 复刻 Python：fftSize=1024（对应 BLOCK=1024，513 频点）；
    // smoothing=0（Python 帧无时间平滑，平滑统一在 update() 用 state.smooth 做）；
    // dB 范围放宽到 -95~0，避免 -30dB 以上信号被钳平
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    analyser.minDecibels = -95;
    analyser.maxDecibels = 0;
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function startMicMode(){
  startMicModeAsync(false).catch(err => {
    setStatus('⚠️ 麦克风启动失败: ' + (err && err.name ? err.name : err));
  });
}

async function startMicModeAsync(quiet){
  // v3.41 能力检测：非安全上下文禁用 getUserMedia（云端为 HTTPS 不受影响）
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    const msg = window.isSecureContext
      ? '⚠️ 当前浏览器不支持麦克风采集'
      : '⚠️ HTTP 下浏览器禁用麦克风（需 HTTPS）';
    if (!quiet) setStatus(msg);
    throw new Error('getUserMedia unavailable');
  }
  ensureAudioCtx();
  if (audioCtx.state === 'suspended'){
    try { await audioCtx.resume(); } catch(e){}
  }
  const stream = await navigator.mediaDevices.getUserMedia(
    { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  micStream = stream;
  sourceNode = audioCtx.createMediaStreamSource(stream);
  sourceNode.connect(analyser);
  // 环形录音：采样率随 AudioContext（手机常为48k，ACR 支持）
  _micRingSR = audioCtx.sampleRate || 44100;
  _micRingCap = Math.floor(_micRingSR * 15.5);
  _micRingChunks = []; _micRingSamples = 0; _micCbCount = 0;
  // 静音汇入节点：录音处理器必须汇入 destination 才会被音频图驱动，gain=0 保证无声
  _micMute = audioCtx.createGain();
  _micMute.gain.value = 0;
  _micMute.connect(audioCtx.destination);

  // 方案1（首选）AudioWorklet：音频线程内运行，现代手机浏览器全支持
  let workletOk = false;
  try {
    if (audioCtx.audioWorklet && window.AudioWorkletNode){
      await audioCtx.audioWorklet.addModule('mic-worklet.js?v=346b');
      _micNode = new AudioWorkletNode(audioCtx, 'mic-recorder',
        { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      _micNode.port.onmessage = ev => {
        _micCbCount++;
        _pushMicChunk(new Int16Array(ev.data));
      };
      sourceNode.connect(_micNode);
      _micNode.connect(_micMute);
      workletOk = true;
    }
  } catch(e){ workletOk = false; try{ if (_micNode) _micNode.disconnect(); }catch(_){} _micNode = null; }

  // 方案2（兜底）ScriptProcessor
  if (!workletOk){
    try {
      _micProc = audioCtx.createScriptProcessor(4096, 1, 1);
      _micProc.onaudioprocess = ev => {
        _micCbCount++;
        const input = ev.inputBuffer.getChannelData(0);
        const i16 = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++){
          let s = input[i];
          if (s > 1) s = 1; else if (s < -1) s = -1;
          i16[i] = s < 0 ? s * 32768 : s * 32767;
        }
        _pushMicChunk(i16);
      };
      sourceNode.connect(_micProc);
      _micProc.connect(_micMute);
    } catch(e){ _micProc = null; }
  }
  return stream;
}

function stopAudio(){
  try { if (micStream) micStream.getTracks().forEach(t => t.stop()); } catch(e){}
  try { if (_micProc) _micProc.disconnect(); } catch(e){}
  try { if (_micNode) _micNode.disconnect(); } catch(e){}
  try { if (_micMute) _micMute.disconnect(); } catch(e){}
  // 断开 analyser 的全部下游（切音源前清理，各启动函数会自行重连）
  try { if (analyser) analyser.disconnect(); } catch(e){}
  micStream = null;
  _micProc = null; _micNode = null; _micMute = null;
  _micRingChunks = []; _micRingSamples = 0;
}

/* ============================================================
   v3.47 浏览器端分析器 —— 整块复刻 audio_server.py 的 Analyser.process
   （本地音乐 / 麦克风 / 手机端共用；系统音频仍走 Python WS）
   流水线（与 Python 一一对应）:
     FloatFrequencyData(dB) → 线性幅度 → 64带对数映射
     → runMax 自适应增益(0.995) → gamma 0.6 → 高频倾斜 1+1.3·i/64
   关键：开头用【绝对电平 + 迟滞】静音门，数字静音/底噪直接输出全零，
   不进入归一化 → 彻底消除"没放歌也在跳/底噪被放大"。
   ============================================================ */
const _bsFrame = { runMax: 1e-3, silent: true };
let _bsZero = null;
function browserAnalyseFrame(){
  const binCount = analyser.frequencyBinCount;
  const db = new Float32Array(binCount);
  analyser.getFloatFrequencyData(db);
  return _bsPline(db);
}
/* v4.00：流水线主体抽成纯函数（输入 dB 谱，内部状态 _bsFrame），
   实时（麦克风/系统音频）与离线预分析共用同一份代码 → 数据严格一致 */
function _bsPline(db){
  const binCount = db.length;
  // 0. 绝对电平静音门（迟滞 -65 / -52 dB）
  let maxDb = -Infinity;
  for (let j = 0; j < binCount; j++) if (db[j] > maxDb) maxDb = db[j];
  if (_bsFrame.silent){
    if (maxDb < -52) return _bsZero || (_bsZero = new Float32Array(FFT_BINS));
    _bsFrame.silent = false;
  } else if (maxDb < -65){
    _bsFrame.silent = true;
    return _bsZero || (_bsZero = new Float32Array(FFT_BINS));
  }

  // 1. dB → 线性幅度 10^(dB/20)
  const lin = new Float32Array(binCount);
  for (let j = 0; j < binCount; j++){
    if (db[j] > -95) lin[j] = Math.pow(10, db[j] / 20);
  }

  // 2. 64 带对数映射：band i = lin[ f0 : f1 ] 均值（与 Python 完全相同）
  const out = new Float32Array(FFT_BINS);
  let bandMax = 1e-4;
  for (let i = 0; i < FFT_BINS; i++){
    const f0 = Math.floor((i / FFT_BINS) ** 2 * binCount);
    const f1 = Math.max(f0 + 1, Math.floor(((i + 1) / FFT_BINS) ** 2 * binCount));
    let sum = 0, cnt = 0;
    for (let j = f0; j < f1 && j < binCount; j++){ sum += lin[j]; cnt++; }
    out[i] = cnt ? sum / cnt : 0;
    if (out[i] > bandMax) bandMax = out[i];
  }

  // 3. runMax 自适应增益（0.995 衰减，下限 1e-4，与 Python 一致）
  _bsFrame.runMax = Math.max(_bsFrame.runMax * 0.995, bandMax, 1e-4);
  // 4. gamma 0.6 → 高频倾斜 → 钳到 0..1
  const norm = new Float32Array(FFT_BINS);
  for (let i = 0; i < FFT_BINS; i++){
    let v = Math.min(1, (out[i] / _bsFrame.runMax) ** 0.6);
    v = Math.min(1, v * (1 + (i / FFT_BINS) * 1.3));
    norm[i] = v;
  }
  return norm;
}

/* ============================================================
   v4.04 实时降级链（最后兜底）：离线频谱彻底不可用/失败时
   （部分 WebKit 的 OfflineAudioContext.suspend 缺失/异常、
   加载不出时长、片段全解码失败等），将 playerAudio 一次性挂到
   MediaElementSource → AnalyserNode → destination（出声+分析同链，
   参数与桌面同款），播放中逐帧过同一份 _bsPline 流水线——
   律动精度与桌面一致，只是改为「边播边建表」；
   帧同时写入 IDB spec 店（partial 标记），下次播放查表秒出、
   缺段继续实补。附回前台 resume 守卫。
   这是 v4.00「发声不接 WebAudio」硬约束的唯一例外：仅离线分析
   已确认失败时启用（_rtAllow 门控），正常设备绝不触碰。 */
let _rt = null;          // {ctx, an, db}
let _rtAllow = false;    // 离线已失败 → 允许实时链
let _rtSpec = null;      // {key, n, frames:Uint8Array} 渐进表
function _plEnsureRealtime(){
  if (_rt) return true;
  try{
    const ctx = ensureAudioCtx();
    if (ctx.state === 'suspended') ctx.resume().catch(()=>{});
    const src = ctx.createMediaElementSource(playerAudio);   // 同一元素终生只能一次
    const an = ctx.createAnalyser();
    an.fftSize = 1024; an.smoothingTimeConstant = 0;
    an.minDecibels = -95; an.maxDecibels = 0;
    src.connect(an);
    an.connect(ctx.destination);
    _rt = { ctx, an, db: new Float32Array(an.frequencyBinCount) };
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && _rt && _rt.ctx && _rt.ctx.state === 'suspended'){
        _rt.ctx.resume().catch(()=>{});
      }
    });
    return true;
  }catch(e){
    console.error('[spec] 实时降级链建立失败', e);
    _rt = null;
    return false;
  }
}
function _rtCapture(f){
  if (!_rt) return f;
  _rt.an.getFloatFrequencyData(_rt.db);
  f = _bsPline(_rt.db);
  try{
    if (_plIdx >= 0 && _plItems[_plIdx]){
      const key = _plKey(_plItems[_plIdx]);
      const t = playerAudio.currentTime || 0;
      const i = Math.max(0, Math.round(t * SPEC_FPS));
      if (_rtSpec && _rtSpec.key !== key){ _rtFlush(); _rtSpec = null; }
      if (!_rtSpec){
        const dur = playerAudio.duration;
        const want = Math.min(
          Math.max(i + 8192, Math.ceil((isFinite(dur) && dur > 0 ? dur : 3600) * SPEC_FPS) + 64),
          Math.ceil(4 * 3600 * SPEC_FPS));       // 上限 4 小时保护
        _rtSpec = { key, n: want, frames: new Uint8Array(want * FFT_BINS) };
      }
      const off = i * FFT_BINS;
      if (off + FFT_BINS <= _rtSpec.frames.length){
        _rtSpec.frames.set(_specQuantize(f), off);
      }
    }
  }catch(e){}
  return f;
}
function _rtFlush(){
  if (!_idb || !_rtSpec || !_rtSpec.key) return;
  try{
    idbPut('spec', _rtSpec.key, { p: true, fps: SPEC_FPS, n: _rtSpec.n, frames: _rtSpec.frames.buffer }).catch(()=>{});
  }catch(e){}
}
window.addEventListener('pagehide', _rtFlush);

function pullFrame(){
  /* v4.00：播放器模式查离线频谱表（currentTime→帧插值）；麦克风/系统音频走实时。
     后台 hidden 时 rAF 自动停调。
     v4.01：整个回调 try/catch——任何意外都不得杀死 rAF 链（否则律动线永停）。
     v4.04：离线无表且已确认失败（_rtAllow）→ 实时降级链（同 _bsPline 同精度） */
  try{
    if (!document.hidden && state.source === 'player'){
      let f;
      if (playerAudio.paused){
        f = _specZero;   // 暂停 → 静默帧
      } else if (_specCur && _specCur.n){
        f = _specFrameAt(playerAudio.currentTime || 0);
      } else if (_rtAllow && _plEnsureRealtime()){
        f = _rtCapture(null);
      } else {
        f = _specZero;
      }
      state.sysFrame = f;
      let b = 0;
      for (let i = 0; i < 8; i++) b += f[i];
      document.getElementById('playerBtn').style.setProperty('--b', (b / 8).toFixed(3));
    } else if (analyser && !document.hidden && state.source === 'mic'){
      state.sysFrame = browserAnalyseFrame();
    }
  }catch(e){}
  requestAnimationFrame(pullFrame);
}
requestAnimationFrame(pullFrame);

/* ============================================================
   v3.50 音乐播放器
   音频链路：<audio id="playerAudio"> → MediaElementSource
            → analyser（v3.47 同款算法）→ destination（扬声器）
   面板居中半透明；左下角音符按钮播放时旋转+炫彩发光+随律动震动。
   语义（v3.88 起）：
     · 播放中 state.source='player' → WS 系统帧被忽略，波形严格匹配播放器；音源按钮亮「播放器」
     · 手动暂停 → 音源保持「播放器」（波形静止）；要听系统声音由用户显式点「系统音频」
     · 切「麦克风」→ 立即暂停播放器，直接从麦克风收音
     · 自动切歌/列表循环 → 始终保持 player
   ============================================================ */
const playerAudio = document.getElementById('playerAudio');
/* v3.84 云端 COS 音频必须带 CORS 凭据才能进 WebAudio（否则静音 taint）；
 * blob:/同源不受影响；COS 桶已配 CORS AllowOrigin * */
playerAudio.crossOrigin = 'anonymous';
/* ============================================================
   v4.00 频谱链路（废弃 v3.96~v3.99 的实时 WebAudio 链 + bgAudio 接力）：
   【声音】playerAudio 原生 <audio> 元素直出（不经任何 WebAudio 节点），
           iOS/macOS 系统级接管，切后台/锁屏天然可续播，彻底消除
           「AudioContext 挂起→回前台无声」。
   【频谱】离线预分析：首次播放某首歌时用 OfflineAudioContext +
           AnalyserNode（与实时链同一引擎、同一 fftSize/窗口/参数）
           分段渲染整首歌，每 16ms 采一帧 dB 谱，过与实时链完全相同的
           v3.47 流水线（静音门→对数 64 带→runMax→gamma→高频倾斜），
           量化成字节帧存 IndexedDB；之后播放按 currentTime 查表+
           线性插值——手机/电脑/任何设备看到的都是同一份数据，精度
           与电脑实时分析逐帧一致，且零 CPU 常驻开销。
   ============================================================ */
const plListEl = document.getElementById('plList');
let _plItems = [];          // {name, file, url}
let _plIdx = -1;
let _plSwitching = false;   // 切歌中：忽略本次 pause 事件
let _plManualPause = false; // 用户主动点了暂停
let _plAutoResume = false;  // v3.88 来电/微信语音打断后待自动恢复
let _plResumeTimer = null;  // v3.88 打断恢复看门狗（2s 重试）
function _plInterruptStopWatch(){
  if (_plResumeTimer){ clearInterval(_plResumeTimer); _plResumeTimer = null; }
}
function _plInterruptTry(){
  if (!_plAutoResume || _plIdx < 0){ _plInterruptStopWatch(); return; }
  if (!playerAudio.paused){ _plAutoResume = false; _plInterruptStopWatch(); return; }
  const pr = playerAudio.play();
  if (pr && pr.then) pr.then(() => {
    _plAutoResume = false; _plInterruptStopWatch();
    setStatus('▶ 通话结束，已自动恢复播放');
  }).catch(() => {});   // 仍被打断中：等下一次重试
}
let _plShuffle = false;     // false=顺序循环, true=随机播放
/* v3.52 歌词锁定：{fileKey:{segments:[{start,end,title,artist,source,lines}]}}（存 IndexedDB） */
let _plLocks = {};
let _plLockActive = null;   // 当前正在生效的锁定段（null=无）
// v3.72：手动播放覆盖——用户从选择框选了歌词（锁定篇从头播/搜索版本当前位置对齐）。
// 覆盖期间锁定监测被抑制；歌词播完后恢复：在锁定段内→自动接播，不在→框空等下一段。
// _plManual = {kind:'lock'|'search', anchorTime, anchorLyricSec, seg?, cid?}
let _plManual = null;
const MANUAL_TAIL_SEC = 5;  // 最后一行出现后再留 5 秒视为"播放完"
let _plAnchor = null;       // {wall,pos,audio} 播放器进度与系统音频时钟的锚点
/* v3.51 喜欢 / 最近播放 / 标签视图 */
let _plTab = 'all';         // 'all' | 'recent' | 'liked' | 'online'
const _plSelected = new Set();   // v3.79：勾选待删除的曲库键
/* v3.84 云端曲库（腾讯云 COS 对象存储；歌曲+锁定歌词全存云，电脑关机也能听）
 * v3.85 键约定：it.key=COS对象键（去songs/前缀，含扩展名）· it.fkey=歌词/曲库键（再去扩展名，
 *   与本地 _plKey「歌名|字节」一致）· it.name=显示名（去扩展名）。v3.85起新上传的键不再带扩展名。 */
let _plOnlineList = [];     // 云端曲库缓存 [{key,fkey,name,size,ts}]
const _dlProg = {};         // fkey -> 0..1 云端下载进度（下载中防重复点击）
/* v3.85 每首歌的「当前歌词」缓存 {fkey:{lrc,title,artist,source,ts}}（存 IndexedDB，
 * 上传时随歌一起传云端 locks/<fkey>.json 的 cur 字段，播放云端歌时自动恢复应用） */
let _plCurLrcs = {};
const _plLikedKeys = new Set();   // 喜欢键集合（持久化到 localStorage）
const _plRecentKeys = [];         // 最近播放键，最近在前、去重
try {
  (JSON.parse(localStorage.getItem('phantom_liked') || '[]') || []).forEach(k => _plLikedKeys.add(k));
} catch(e){}
/* v3.98：最近播放持久化到 localStorage，刷新/重开不丢失 */
try {
  (JSON.parse(localStorage.getItem('phantom_recent') || '[]') || []).forEach(k => {
    if (_plRecentKeys.length < 200) _plRecentKeys.push(k);
  });
} catch(e){}
function _plSaveRecent(){
  const arr = _plRecentKeys.slice(0, 200);
  try { localStorage.setItem('phantom_recent', JSON.stringify(arr)); } catch(e){}
  /* v4.00：双写 IDB 镜像——iOS 可能单独清 localStorage，恢复时兜底 */
  if (_idb) idbPut('meta', 'recent_bak', arr).catch(() => {});
}
function _plKey(it){ return it.name + '|' + (it.file ? it.file.size : (it.size || 0)); }
function _plSaveLiked(){
  const arr = [..._plLikedKeys];
  try { localStorage.setItem('phantom_liked', JSON.stringify(arr)); } catch(e){}
  if (_idb) idbPut('meta', 'liked_bak', arr).catch(() => {});
}
function _plIsLiked(it){ return _plLikedKeys.has(_plKey(it)); }
function _plPushRecent(it){
  const k = _plKey(it);
  const p = _plRecentKeys.indexOf(k);
  if (p >= 0) _plRecentKeys.splice(p, 1);
  _plRecentKeys.unshift(k);
  if (_plRecentKeys.length > 200) _plRecentKeys.length = 200;
  _plSaveRecent();   // v3.98：最近播放变化即持久化
}
/* 当前视图 -> [{it, idx}]（idx 为 _plItems 中的真实下标） */
function _plView(){
  if (_plTab === 'liked'){
    return _plItems.map((it, idx) => ({it, idx})).filter(v => _plIsLiked(v.it));
  }
  if (_plTab === 'recent'){
    const byKey = new Map(_plItems.map(it => [_plKey(it), it]));
    const out = [];
    _plRecentKeys.forEach(k => {
      const it = byKey.get(k);
      if (it) out.push({it, idx: _plItems.indexOf(it)});
    });
    return out;
  }
  return _plItems.map((it, idx) => ({it, idx}));
}

/* ============================================================
   v4.00 离线频谱分析管线
   首次播放某首歌：用 OfflineAudioContext + AnalyserNode（fftSize/dB 范围
   与实时链完全一致、smoothing=0）分段渲染整首歌，每 16ms（62.5fps）
   挂起采一帧 dB 谱，逐帧过与实时链完全相同的 v3.47 流水线
   （_bsPline：静音门→对数 64 带→runMax→gamma→高频倾斜），量化成
   字节帧存 IndexedDB——每首歌只分析一次。
   播放时按 playerAudio.currentTime 查表 + 线性插值 → state.sysFrame，
   任何设备看到的都是同一份数据，精度与电脑实时分析一致。
   ============================================================ */
const SPEC_SR = 48000;                    // 与桌面 AudioContext 采样率一致
const SPEC_HOP = 768;                     // 采样间隔（6 个渲染量子 = 16ms @48k）
const SPEC_FPS = SPEC_SR / SPEC_HOP;      // 62.5
const SPEC_SEG_SEC = 30;                  // 分片时长（控制内存峰值）
const SPEC_MAX_SEC = 600;                 // 非 MP3 格式：整曲解码超 10 分钟不做（解码内存风险）
                                          // MP3 分片解码不限时长（帧数据 4 小时仅约 57MB）
const SPEC_OFF = typeof OfflineAudioContext !== 'undefined';
let _specCur = null;        // {key, fps, n, frames:Uint8Array(n*FFT_BINS)} 当前歌频谱表
let _specJobKey = null;     // 正在分析的歌键（切歌即作废旧任务）
const _specNoSet = new Set();      // 分析失败/过长 → 本次会话不再重试
const _specLookBuf = new Float32Array(FFT_BINS);
const _specZero = new Float32Array(FFT_BINS);
let _decCtx = null;
function _decodeCtx(){
  /* 仅借 decodeAudioData 用：优先 OfflineAudioContext（不占实时音频通道）；
     个别 iOS 版本的 OfflineAudioContext 没有 decodeAudioData → 退回
     实时 AudioContext（无手势时自动 suspended，suspended 也能解码） */
  if (!_decCtx){
    if (SPEC_OFF){
      try{
        const o = new OfflineAudioContext(1, 128, 44100);
        if (o.decodeAudioData) _decCtx = o;
      }catch(e){}
    }
    if (!_decCtx){
      _decCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (_decCtx.state === 'running' && _decCtx.suspend) _decCtx.suspend().catch(()=>{});
    }
  }
  return _decCtx;
}
/* decodeAudioData 兼容封装：Promise 式 + 回调式（旧 Safari）双适配，只决一次 */
function _dad(buf){
  const c = _decodeCtx();
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = b => { if (!settled){ settled = true; resolve(b); } };
    const no = e => { if (!settled){ settled = true; reject(e); } };
    try{
      const p = c.decodeAudioData(buf, ok, no);
      if (p && p.then) p.then(ok).catch(no);
    }catch(e){ no(e); }
  });
}
/* decodeAudioData 带超时封装：某一片字节损坏时 Safari 的 decode 可能永不回调，
   必须能跳过该片继续（v4.02） */
function _dadT(buf, ms){
  return Promise.race([
    _dad(buf),
    new Promise((res, rej) => setTimeout(() => rej(new Error('decode timeout')), ms))
  ]);
}
/* 分析过程诊断日志（真机出问题时便于远程定位；上限 200 条防内存增长） */
const __specDbg = [];
function _specDbg(entry){
  if (__specDbg.length < 200) __specDbg.push(entry);
}
async function _specDecode(it){
  let blob = it.file;
  if (!blob && it.url){   // 云端直链：先查 SW 缓存，没有再拉回
    try{
      const hit = ('caches' in window) ? await caches.match(it.url) : null;
      if (hit) blob = await hit.blob();
    }catch(e){}
    if (!blob){
      const res = await fetch(it.url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      blob = await res.blob();
    }
  }
  if (!blob) throw new Error('无音频文件');
  const raw = await blob.arrayBuffer();
  return await _decodeCtx().decodeAudioData(raw);
}
function _specQuantize(norm){
  const u = new Uint8Array(FFT_BINS);
  for (let i = 0; i < FFT_BINS; i++){
    const v = norm[i];
    u[i] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0;
  }
  return u;
}
/* v4.01：廉价时长探测——临时 Audio 元素只读 metadata（浏览器解复用器只扫
   容器头/尾，不解码 PCM）。绝不能先整曲 decodeAudioData 再判时长：
   140MB 的 MP3 解码后约 1.3GB PCM，渲染进程直接 OOM 崩溃白屏。 */
function _audioMetaDur(it){
  return new Promise(resolve => {
    try{
      const a = new Audio();
      a.preload = 'metadata';
      let url = it.url, made = false;
      if (!url && it.file){ url = URL.createObjectURL(it.file); made = true; }
      if (!url){ resolve(0); return; }
      let done = false;
      const finish = v => {
        if (done) return; done = true;
        clearTimeout(tm);
        a.onloadedmetadata = null; a.onerror = null;
        try{ a.removeAttribute('src'); a.load(); }catch(e){}
        if (made) try{ URL.revokeObjectURL(url); }catch(e){}
        resolve(v);
      };
      const tm = setTimeout(() => finish(0), it.file ? 6000 : 20000);
      a.onloadedmetadata = () => {
        /* VBR 且无 Xing/VBRI 头时 duration 常为 Infinity/NaN —— 一律按未知处理，
           由调用方用「文件大小×8/首帧比特率」兜底估算（v4.02） */
        const d = a.duration;
        finish(isFinite(d) && d > 0 ? d : 0);
      };
      a.onerror = () => finish(0);
      a.src = url;
    }catch(e){ resolve(0); }
  });
}
/* MP3 判定 + 首帧头解析：读前 64KB，跳过 ID3v2，找首个有效 MPEG 帧。
   返回 {head:{off 帧字节偏移, br 比特率, sr 采样率, spf 帧采样数, flen 帧字节长}}；
   仅凭名字像 mp3 但嗅探不到帧头 → {}（不能安全分片） */
const _MP3_BR_V1 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
const _MP3_BR_V2 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];
/* v4.03 统一字节源：本地 File 切片 or 云端 URL HTTP Range 分片（COS 已实测支持 206）。
   返回 Uint8Array；服务器不支持 Range（回 200 整本）/越界/失败 → null
   （200 整本必须判失败：云端歌没有本地文件，逐片拉全本会流量爆炸+内存 OOM） */
async function _specBytes(it, a, b){
  try{
    if (it.file){
      const hi = Math.min(b, it.file.size);
      if (hi <= a) return null;
      return new Uint8Array(await it.file.slice(a, hi).arrayBuffer());
    }
    if (it.url){
      const res = await fetch(it.url, { headers: { Range: 'bytes=' + a + '-' + (b - 1) } });
      if (res.status === 206){
        return new Uint8Array(await res.arrayBuffer());
      }
      if (res.status === 416) return null;
      return null;
    }
  }catch(e){}
  return null;
}
/* MP3 判定 + 首帧头解析：不依赖文件名扩展名，直接嗅探真实字节（读前 64KB，
   跳过 ID3v2，找首个有效 MPEG 帧）——本地 File 与云端 URL 同一路径。
   返回 {head:{off,br,sr,spf,flen}}；嗅探不到 → null */
async function _mp3HeadInfo(it){
  if (!it.file && !it.url) return null;
  try{
    const u = await _specBytes(it, 0, 65536);
    if (!u || u.length < 4) return null;
    let p = 0;
    if (u.length > 10 && u[0] === 0x49 && u[1] === 0x44 && u[2] === 0x33){
      p = 10 + (((u[6] & 0x7f) << 21) | ((u[7] & 0x7f) << 14) |
                ((u[8] & 0x7f) << 7) | (u[9] & 0x7f));
    }
    for (; p + 4 <= u.length; p++){
      if (u[p] === 0xFF && (u[p + 1] & 0xE0) === 0xE0){
        const b1 = u[p + 1], b2 = u[p + 2];
        const ver = (b1 >> 3) & 3, layer = (b1 >> 1) & 3;
        const brIdx = (b2 >> 4) & 15, srIdx = (b2 >> 2) & 3;
        if (ver === 0 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
        const br = (ver === 3 ? _MP3_BR_V1 : _MP3_BR_V2)[brIdx] * 1000;
        const sr = ver === 3 ? [44100,48000,32000][srIdx]
                 : ver === 2 ? [22050,24000,16000][srIdx]
                 : [11025,12000,8000][srIdx];
        const spf = ver === 3 ? 1152 : 576;
        const flen = Math.floor((ver === 3 ? 144 : 72) * br / sr) + ((b2 >> 1) & 1);
        return { head: { off: p, br, sr, spf, flen } };
      }
    }
  }catch(e){}
  return null;
}
/* 在猜测点附近（前512B~后16KB）扫描下一个有效 MPEG 帧同步位置 */
async function _mp3Resync(it, guess, size){
  const lo = Math.max(0, guess - 512), hi = Math.min(size, guess + 16384);
  const u = await _specBytes(it, lo, hi);
  if (!u) return guess;
  for (let k = Math.max(0, guess - lo); k + 4 <= u.length; k++){
    if (u[k] === 0xFF && (u[k + 1] & 0xE0) === 0xE0){
      const b1 = u[k + 1], b2 = u[k + 2];
      const bi = (b2 >> 4) & 15, si = (b2 >> 2) & 3;
      if (((b1 >> 1) & 3) === 1 && bi !== 0 && bi !== 15 && si !== 3) return lo + k;
    }
  }
  return guess;
}
/* 一个已解码段 → 离线渲染采帧 → 量化帧数组（与实时链逐帧同源） */
async function _specSegFrames(ab){
  const srN = ab.sampleRate, len = ab.length;
  const c0 = ab.getChannelData(0);
  const c1 = ab.numberOfChannels > 1 ? ab.getChannelData(1) : null;
  const outLen = Math.max(SPEC_HOP * 2, Math.ceil(len * SPEC_SR / srN));
  const oc = new OfflineAudioContext(1, outLen, SPEC_SR);
  const an = oc.createAnalyser();
  an.fftSize = 1024; an.smoothingTimeConstant = 0;
  an.minDecibels = -95; an.maxDecibels = 0;
  const sb = oc.createBuffer(1, len, srN);
  const d = sb.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = c1 ? (c0[i] + c1[i]) * 0.5 : c0[i];
  const src = oc.createBufferSource();
  src.buffer = sb;
  src.connect(an); an.connect(oc.destination);
  src.start(0);
  const segDur = outLen / SPEC_SR;
  const fr = [];
  const dbArr = new Float32Array(512);   // fftSize 1024 → 512 bins
  for (let t = SPEC_HOP / SPEC_SR; t < segDur; t += SPEC_HOP / SPEC_SR){
    oc.suspend(t).then(() => {
      an.getFloatFrequencyData(dbArr);
      fr.push(_specQuantize(_bsPline(dbArr)));
      oc.resume();
    });
  }
  await oc.startRendering();
  return fr;
}
async function _specAnalyze(it, key){
  _specJobKey = key;
  let lastPct = -9, skipped = 0;
  /* 实时链的流水线状态先存起来，离线分析用全新状态（与实时从歌头起播一致） */
  const bsSave = { runMax: _bsFrame.runMax, silent: _bsFrame.silent };
  try{
    if (!SPEC_OFF || !OfflineAudioContext.prototype.suspend) throw new Error('unsupported');
    setStatus('◌ 首次播放：频谱分析启动（v4.03 引擎）…');

    /* 第一步：MP3 帧头嗅探（先于时长——VBR 无 Xing/VBRI 头时 Audio 元素时长
       常为 Infinity，需用「文件大小×8/首帧比特率」兜底估算）。
       v4.03：本地 File 与云端 URL（HTTP Range）统一走 _specBytes 嗅探 */
    const mp3 = await _mp3HeadInfo(it);
    const canChunk = !!(mp3 && mp3.head && (it.file || it.url));

    /* 第二步：时长三源兜底——Audio 元数据（有限才用）→ MP3 大小估算 → 放弃。
       v4.03：元数据与「文件大小×8/首帧比特率」估算差距 >3 倍时（截断文件/
       标签损坏），改信估算值——预分配以保守值为准，不影响分片边界 */
    let dur = await _audioMetaDur(it);
    if (canChunk && (it.file || it.size)){
      const sz = it.file ? it.file.size : it.size;
      const estDur = Math.max(1, (sz - mp3.head.off) * 8 / mp3.head.br);
      if (!(dur > 0) || dur > estDur * 3 || estDur > dur * 3) dur = estDur;
    }
    if (!(dur > 0)) throw new Error('no dur');
    /* 非 MP3 只能整曲解码：仍限 10 分钟（内存安全）；MP3 分片解码不限时长 */
    if (!canChunk && dur > SPEC_MAX_SEC) throw new Error('too long');
    _specDbg({ step: 'start', key, canChunk, dur: Math.round(dur),
               size: it.file ? it.file.size : (it.size || 0), remote: !it.file && !!it.url,
               head: mp3.head ? { br: mp3.head.br, sr: mp3.head.sr, flen: mp3.head.flen } : null });

    /* 增量频谱表：先建表、边分析边写入，播放到已分析段落立刻有律动；
       _specFrameAt 在未分析到的位置钳到最后一帧（短暂冻结而非归零）。
       预分配按估算时长封顶（6 小时上限 86MB 上限保护，估算值恒有限） */
    const capDur = Math.min(dur, 6 * 3600);
    let all = new Uint8Array((Math.ceil(capDur * SPEC_FPS) + 2) * FFT_BINS);
    let n = 0;
    _bsFrame.runMax = 1e-3; _bsFrame.silent = true;
    _specCur = { key, fps: SPEC_FPS, n: 0, frames: all };

    if (canChunk){
      const head = mp3.head;
      /* 字节总长：本地=File.size；云端=列表 size；都没有则按比特率反推 */
      let size = it.file ? it.file.size : (it.size || 0);
      if (!size) size = Math.round(dur * head.br / 8) + head.off;
      const framesPerSeg = Math.max(1, Math.round(SPEC_SEG_SEC * head.sr / head.spf));
      let pos = 0;
      while (pos < size){
        if (_specJobKey !== key) return;
        const guess = pos + head.flen * framesPerSeg;
        let end = await _mp3Resync(it, guess, size);
        if (end <= pos) end = Math.min(size, guess);
        if (end >= size) end = size;
        if (end - pos > 8 * 1024 * 1024){   // 异常超大切片保护（VBR 剧变/坏帧流）
          end = Math.min(size, pos + 8 * 1024 * 1024);
        }
        /* 每片独立 try/catch：单片取字节/解码/渲染失败只跳过该片，绝不终止整曲分析 */
        let ab = null, fr = null;
        try{
          const bytes = await _specBytes(it, pos, end);
          if (bytes && bytes.length > 3) ab = await _dadT(bytes.buffer, 20000);
        }catch(e){}
        if (ab && ab.length){
          try{ fr = await _specSegFrames(ab); }catch(e){ fr = null; }
          ab = null;
        }
        if (fr && fr.length){
          if ((n + fr.length) * FFT_BINS > all.length){    // 容量保护（极少触发）
            const grown = new Uint8Array(Math.ceil(all.length * 1.2));
            grown.set(all); all = grown; _specCur.frames = all;
          }
          for (const u of fr){ all.set(u, n * FFT_BINS); n++; }
          _specCur.n = n;
        }else{
          skipped++;
          _specDbg({ step: 'skip', pos, end });
        }
        const pct = Math.min(99, Math.round(end / size * 100));
        if (pct >= lastPct + 5){
          lastPct = pct;
          setStatus('◌ 首次播放：频谱分析中 ' + pct + '%（仅一次，以后秒出）');
        }
        pos = end;
        await new Promise(r => setTimeout(r, 0));   // 让 GC/主线程喘口气
      }
    }else{
      const ab = await _specDecode(it);   // 时长已确认 ≤600s，内存安全
      for (const u of await _specSegFrames(ab)){ all.set(u, n * FFT_BINS); n++; }
      _specCur.n = n;
    }
    if (_specJobKey !== key) return;
    if (!n) throw new Error('empty');

    const finalBuf = all.slice(0, n * FFT_BINS);   // 精确尺寸，释放预分配余量
    _specCur = { key, fps: SPEC_FPS, n, frames: finalBuf };
    if (_idb) idbPut('spec', key, { fps: SPEC_FPS, n, frames: finalBuf.buffer }).catch(()=>{});
    if (!it.file && it.url){ try{ localStorage.setItem('pb_spec_s_' + key, 'ok'); }catch(e){} }  // v4.05 流量闸
    _specDbg({ step: 'done', n, skipped });
    setStatus(skipped
      ? ('● 频谱分析完成，已缓存（' + skipped + ' 段受损跳过）')
      : '● 频谱分析完成，已缓存');
  }catch(e){
    if (_specJobKey === key) _specCur = null;
    _specNoSet.add(key);
    _specDbg({ step: 'fail', msg: (e && e.message) || '' });
    if (_specJobKey === key){
      /* v4.04：失败原因可见（含此前静默的 unsupported/no dur）+ 自动切实时降级链 */
      const msg = (e && e.message) || '';
      let code = 0, why = msg || '未知';
      if (msg === 'unsupported'){ code = 1; why = '本机不支持离线频谱引擎'; }
      else if (msg === 'no dur'){ code = 2; why = '无法读取歌曲时长'; }
      else if (msg === 'too long'){ code = 3; why = '非 MP3 且超过 10 分钟'; }
      else if (msg === 'empty'){ code = 4; why = '片段解码全部失败'; }
      else code = 5;
      /* v4.05 流量闸：云端歌分析失败 → 记 'rt' 永久实时律动，绝不再整曲下载重试 */
      if (!it.file && it.url){ try{ localStorage.setItem('pb_spec_s_' + key, 'rt'); }catch(e){} }
      _rtAllow = true;
      const ok = _plEnsureRealtime();
      setStatus(ok
        ? ('● 离线频谱不可用[' + code + ' ' + why + ']，已切换实时律动（不额外下载流量）')
        : ('● 离线频谱不可用[' + code + ' ' + why + ']'));
    }
  }finally{
    _bsFrame.runMax = bsSave.runMax; _bsFrame.silent = bsSave.silent;
    if (_specJobKey === key) _specJobKey = null;
  }
}
function _specLoad(it){
  const key = _plKey(it);
  if (_specCur && _specCur.key === key) return;
  _specCur = null;
  _specJobKey = null;   // 打断进行中的旧分析
  _rtAllow = false;     // v4.04：切歌重置实时门控（由本曲离线结果重新决定）
  if (_rtSpec && _rtSpec.key !== key) _rtSpec = null;
  /* v4.05 流量闸：云端歌曲（无本地 File）全曲分析烧外网下行流量
     （291MB 歌 = 约 0.15 元/次），只允许每个键「成功/失败各试一次」
     ——失败记 'rt' 后永久实时律动（零额外流量），绝不再重复全曲下载 */
  let rtMark = '';
  try{ rtMark = localStorage.getItem('pb_spec_s_' + key) || ''; }catch(e){}
  const isCloud = !it.file && !!it.url;
  if (isCloud && rtMark === 'rt'){ _rtAllow = true; _plEnsureRealtime(); return; }
  if (_specNoSet.has(key)){
    if (isCloud){ try{ localStorage.setItem('pb_spec_s_' + key, 'rt'); }catch(e){} }
    _rtAllow = true; _plEnsureRealtime();
    return;
  }
  const stillCur = () => _plIdx >= 0 && _plItems[_plIdx] && _plKey(_plItems[_plIdx]) === key;
  const go = () => { if (stillCur()) _specAnalyze(it, key); };
  if (_idb){
    idbGet('spec', key).then(rec => {
      if (!stillCur()) return;
      if (rec && rec.frames && rec.n){
        if (rec.p){          // 实时链既往产物（部分表）→ 继续边播边补
          _rtAllow = true;
          _rtSpec = { key, n: rec.n, frames: new Uint8Array(rec.frames) };
          _plEnsureRealtime();
        } else {
          try{ if (isCloud) localStorage.setItem('pb_spec_s_' + key, 'ok'); }catch(e){}
          _specCur = { key, fps: rec.fps || SPEC_FPS, n: rec.n, frames: new Uint8Array(rec.frames) };
        }
      } else go();
    }).catch(() => { if (stillCur()){ _rtAllow = true; _plEnsureRealtime(); } });
  } else {
    if (isCloud && !rtMark) setStatus('◌ 云端歌曲首次播放将生成频谱（仅一次，之后不再下载）');
    go();
  }
}
/* 查表：t（歌曲内秒）→ 64 带帧（0..1），相邻帧线性插值 */
function _specFrameAt(t){
  const c = _specCur;
  if (!c || !c.n) return _specZero;
  let pos = t * c.fps;
  if (pos < 0) pos = 0;
  let i = Math.floor(pos);
  if (i >= c.n - 1){
    const r = (c.n - 1) * FFT_BINS;
    for (let j = 0; j < FFT_BINS; j++) _specLookBuf[j] = c.frames[r + j] / 255;
    return _specLookBuf;
  }
  const frac = pos - i;
  const r0 = i * FFT_BINS, r1 = r0 + FFT_BINS, F = c.frames;
  for (let j = 0; j < FFT_BINS; j++){
    _specLookBuf[j] = (F[r0 + j] + (F[r1 + j] - F[r0 + j]) * frac) / 255;
  }
  return _specLookBuf;
}

function _plFmt(t){
  if (!isFinite(t)) return '0:00';
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

const PL_EMPTY_MSG = {
  all: '还没有歌曲<br>点击上方「＋ 添加本地歌曲」<br>选择存放音乐的文件夹即可',
  recent: '还没有播放记录<br>播放过的歌曲会出现在这里',
  liked: '还没有喜欢的歌曲<br>播放时点控制栏的 <span style="color:#ff7aa2">&#x2661;</span> 即可收藏',
};
function _plRender(){
  if (_plTab === 'online'){ _plRenderOnline(); return; }   // v3.82
  const view = _plView();
  if (!_plItems.length || !view.length){
    plListEl.innerHTML = '<div class="pl-empty">' +
      (!_plItems.length ? PL_EMPTY_MSG.all : PL_EMPTY_MSG[_plTab]) + '</div>';
    return;
  }
  plListEl.innerHTML = '';
  view.forEach(v => {
    const d = document.createElement('div');
    d.className = 'pl-item' + (v.idx === _plIdx ? ' active' : '');
    const ck = document.createElement('input');
    ck.type = 'checkbox';
    ck.className = 'pl-chk';
    ck.checked = _plSelected.has(_plKey(v.it));
    if (ck.checked) d.classList.add('picked');
    ck.onclick = ev => {
      ev.stopPropagation();   // 勾选不触发播放
      const k = _plKey(v.it);
      if (ck.checked) _plSelected.add(k); else _plSelected.delete(k);
      d.classList.toggle('picked', ck.checked);
      _plSyncDel();
    };
    // v3.80 保护区：勾选框整列（含框周围空白）点击只切换勾选，绝不触发播放
    const zone = document.createElement('span');
    zone.className = 'pl-chkzone';
    zone.appendChild(ck);
    zone.onclick = ev => {
      ev.stopPropagation();
      if (ev.target !== ck) ck.click();
    };
    const ic = document.createElement('span');
    ic.className = 'pl-ic';
    ic.innerHTML = v.idx === _plIdx ? '&#9835;&#xFE0E;' :
      (_plIsLiked(v.it) ? '<span style="color:#ff7aa2">&#x2665;</span>' : '');
    const nm = document.createElement('span');
    nm.className = 'pl-name';
    nm.textContent = v.it.name;
    d.append(zone, ic, nm);
    d.onclick = () => _plPlay(v.idx);
    plListEl.appendChild(d);
  });
}

/* ============ v3.84 云端曲库（腾讯云 COS；歌曲+锁定歌词全存云，任何设备、电脑关机也能听） ============ */
let _cloudCfgP = null;      // /api/cloud/config 结果缓存（COS 直链域名）
function _cloudCfg(){
  if (!_cloudCfgP){
    _cloudCfgP = fetch(API_BASE + '/api/cloud/config').then(r => r.json())
      .then(j => (j && j.ok) ? j : null)
      .catch(() => null);
  }
  return _cloudCfgP;
}
/* RFC3986 编码（补转 !'()*），与 SCF 端 cosEnc 完全一致 */
function _cloudEnc(s){
  return encodeURIComponent(String(s)).replace(
    /[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
const _plAudioExtRe = /\.(mp3|flac|m4a|wav|ogg|aac|wma|opus)$/i;
function _plOnlineFetch(){
  plListEl.innerHTML = '<div class="pl-empty">&#x2601;&#xFE0F; 正在加载云端曲库…</div>';
  fetch(API_BASE + '/api/cloud/list').then(r => r.json()).then(res => {
    if (!res || !res.ok) throw new Error(res && res.error || '云端未配置');
    _plOnlineList = (res.items || []).map(it => {
      const key = String(it.key || '').replace(/^songs\//, '');
      const name = String(it.name || '').replace(/^songs\//, '').replace(_plAudioExtRe, '');
      return { ...it, key, name,
        fkey: name + '|' + (it.size || 0) };   // 与本地 _plKey 完全一致（旧上传键带扩展名也归一）
    });
    if (_plTab === 'online') _plRenderOnline();
  }).catch(err => {
    if (_plTab !== 'online') return;
    const msg = String((err && err.message) || err || '网络异常');
    const friendly = /Not found|404/i.test(msg)
      ? '云函数还没有 v3.84 接口<br>（需到腾讯云 SCF 重新上传部署包）' : msg;
    plListEl.innerHTML = '<div class="pl-empty">&#x26A0;&#xFE0F; 无法连接云端曲库<br>' + friendly + '</div>';
  });
}
function _plRenderOnline(){
  if (!_plOnlineList.length){
    plListEl.innerHTML = '<div class="pl-empty">云端曲库还是空的<br>点击右上角「&#x2B06;&#xFE0F; 上传」把电脑里的歌传上去<br>手机任何地方都能听（电脑关机也可以）</div>';
    return;
  }
  const curKey = _plIdx >= 0 && _plItems[_plIdx] ? _plKey(_plItems[_plIdx]) : null;
  plListEl.innerHTML = '';
  _plOnlineList.forEach(it => {
    const d = document.createElement('div');
    d.className = 'pl-item' + (it.fkey === curKey ? ' active' : '');
    d.dataset.fk = it.fkey;
    const ic = document.createElement('span');
    ic.className = 'pl-ic online';
    ic.innerHTML = it.fkey === curKey ? '&#9835;&#xFE0E;' : '&#x2601;&#xFE0E;';
    const nm = document.createElement('span');
    nm.className = 'pl-name';
    nm.textContent = it.name;
    const sz = document.createElement('span');
    sz.className = 'pl-size';
    if (_dlProg[it.fkey] !== undefined){
      sz.innerHTML = '&#x2B07;&#xFE0F; ' + Math.round(_dlProg[it.fkey] * 100) + '%';
    } else {
      sz.textContent = (it.size / 1048576).toFixed(1) + 'M';
    }
    const x = document.createElement('button');
    x.className = 'pl-x';
    x.innerHTML = '&#x2715;';
    x.title = '从云端曲库删除（所有设备都不再可见）';
    x.onclick = ev => { ev.stopPropagation(); _plOnlineDelete(it); };
    d.append(ic, nm, sz, x);
    d.onclick = () => _plPlayOnline(it);
    plListEl.appendChild(d);
  });
}
/* v3.92 点云端的歌：① 本机已有文件缓存=秒播；② 否则【直接用云端 URL 流式播放】
 * （音频元素原生边下边播，COS 支持 Range），不再强制整本下载完才出声；
 * 后台静默缓存整本 → Cache API → IDB 文件，升级为本地条目（离线可播、下次秒开）。
 * 背景：iOS 上 Safari 与主屏 PWA 的存储相互隔离，删除后重新「添加到主屏幕」
 * 必然清空旧 PWA 数据——旧设计每次重装都要整本重下，v3.92 起点了立即播放。 */
async function _plPlayOnline(it){
  if (_dlProg[it.fkey] !== undefined) return;        // （兼容）下载进度态
  const idx = _plItems.findIndex(x => _plKey(x) === it.fkey);
  if (idx >= 0){ _plPlay(idx); return; }             // 已缓存文件或已建流条目：直接播
  const cfg = await _cloudCfg();
  if (!cfg || !cfg.base){ setStatus('⚠️ 无法获取云端地址'); return; }
  const url = cfg.base + '/songs/' + _cloudEnc(it.key);
  _plItems.push({ name: it.name, url, size: it.size, online: true });
  _plPlay(_plItems.length - 1);
  setStatus('☁ 云端播放中（后台自动缓存，下次秒开）');
  _plCloudCache(it, url, _plItems.length - 1);
}
/* 后台缓存：Cache API（浏览器原生流式写盘，不占网页 JS 内存）→ 小文件再升级
   IDB File（离线可播）。v3.93 大小阈值：大文件【绝不】整本 blob()+File()——
   fetch 响应 + clone + blob + File 瞬时可达 4~5 倍文件大小，iOS Safari 单标签
   内存上限仅数百 MB，162MB/291MB 的歌必触发渲染进程 jetsam（页面黑屏崩溃）。
   任何一步失败都静默：流媒体播放不受影响。不打断当前播放。 */
const _CLOUD_CACHE = 'cloud-songs-v1';
const _CLOUD_IDB_MAX = 40 * 1048576;   // ≤40MB 才入 IDB；超过=仅在线直连播放
const _cloudCaching = new Set();
async function _plCloudCache(it, url, idx){
  if (_cloudCaching.has(url)) return;
  _cloudCaching.add(url);
  try{
    let res = null;
    if ('caches' in window){
      const cch = await caches.open(_CLOUD_CACHE);
      res = await cch.match(url);
      if (!res){
        res = await fetch(url);
        // 原生流式写盘（由浏览器内核消费响应体，JS 不缓冲），失败静默
        if (res && res.ok){ try { await cch.put(url, res.clone()); } catch(_){} }
      }
    } else {
      res = await fetch(url);
    }
    if (!res || !res.ok) return;
    const size = Number(it.size) || 0;
    if (size > _CLOUD_IDB_MAX){
      // 大文件：保留 Cache API 原生缓存（供截取片段等），不做整本 JS/IDB 缓存
      setStatus('☁ 云端直连播放中（文件较大，不占手机存储；需联网播放）');
      return;
    }
    const fkey = it.fkey || (it.name + '|' + it.size);
    const blob = await res.clone().blob();
    const file = new File([blob], it.name || it.key || 'song', { type: blob.type || 'audio/mpeg' });
    blob.close && blob.close();
    await idbPut('files', fkey, file);              // 持久文件：刷新/重开/离线都能播
    const cur = _plItems[idx];
    if (cur && cur.online){
      cur.file = file;
      delete cur.online;
      cur.url = URL.createObjectURL(file);           // 不换当前 src：下次播放才走本地
    }
    await idbPut('meta', 'library', _plItems.filter(x => !x.online).map(x => ({
      key: _plKey(x), name: x.name, size: x.file.size,
    }))).catch(() => {});
    setStatus('● 已缓存到本机：' + it.name + '（离线也能播）');
  }catch(e){ /* 后台缓存失败：不影响流式播放，下次点击再试 */ }
  finally { _cloudCaching.delete(url); }
}
/* GET 下载带进度（XHR；fetch 无上传式进度） */
function _cloudGetFile(url, onProg){
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('GET', url);
    x.responseType = 'blob';
    x.onprogress = e => { if (e.lengthComputable && e.total && onProg) onProg(e.loaded / e.total); };
    x.onload = () => (x.status >= 200 && x.status < 300)
      ? res(x.response) : rej(new Error('HTTP ' + x.status));
    x.onerror = () => rej(new Error('网络错误'));
    x.send();
  });
}
function _plOnlineDelete(it){
  if (!window.confirm('确定从云端曲库删除「' + it.name + '」吗？\n所有设备都将不再看到这首歌曲')) return;
  setStatus('● 正在从云端曲库删除…');
  // v3.85：旧版上传的键带扩展名，fkey（去扩展名）与 key 不同时两个都发，服务端容错剥离
  const keys = it.fkey !== it.key ? [it.key, it.fkey] : [it.key];
  fetch(API_BASE + '/api/cloud/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys }),
  }).then(r => r.json()).then(j => {
    if (!j.ok){ setStatus('⚠️ 删除失败：' + (j.error || j)); return; }
    _plOnlineList = _plOnlineList.filter(x => x.key !== it.key);
    // 本地曲库引用与本地歌词资料同步移除（云端锁已由服务端一并删除）
    const k = it.fkey;
    delete _plLocks[k];
    delete _plCurLrcs[k];
    idbPut('meta', 'locks', _plLocks).catch(() => {});
    idbPut('meta', 'curlrcs', _plCurLrcs).catch(() => {});
    const idx = _plItems.findIndex(x => _plKey(x) === k);   // 本机缓存的那份也移除
    if (idx >= 0){
      _plItems.splice(idx, 1);
      if (idx === _plIdx){
        _plIdx = -1;
        playerAudio.pause();
        playerAudio.removeAttribute('src');
        playerAudio.load();
        _plLockActive = null;
        _plManual = null;
        _plUpdateHeart();
      } else if (idx < _plIdx) _plIdx--;
    }
    _plRenderOnline();
    setStatus('● 已从云端曲库删除：' + it.name);
  }).catch(err => setStatus('⚠️ 删除失败：' + err));
}
/* 上传本地文件到云端曲库（多选，逐个上传；SCF 签发预签名 PUT → 浏览器直传 COS） */
const onlineInput = document.getElementById('onlineInput');
document.getElementById('plUp').onclick = () => onlineInput.click();
function _cloudPutFile(url, file, onProg){
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.upload.onprogress = e => { if (e.lengthComputable && onProg) onProg(e.loaded / e.total); };
    x.onload = () => (x.status >= 200 && x.status < 300) ? res() : rej(new Error('HTTP ' + x.status));
    x.onerror = () => rej(new Error('网络错误'));
    x.send(file);
  });
}
onlineInput.addEventListener('change', async e => {
  const files = Array.from(e.target.files).filter(f => _plAudioExtRe.test(f.name));
  e.target.value = '';
  if (!files.length){ setStatus('⚠️ 没有找到音频文件'); return; }
  let okN = 0, dupN = 0, failN = 0, lyN = 0;
  for (let i = 0; i < files.length; i++){
    const f = files[i];
    const k = f.name.replace(_plAudioExtRe, '') + '|' + f.size;   // 与本地曲库键一致
    setStatus('● 上传到云端曲库（' + (i + 1) + '/' + files.length + '）：' + f.name);
    try{
      // v3.85：预签名用去扩展名歌名 → 云端键=本地键，锁定/歌词全设备直接互通
      const r = await fetch(API_BASE + '/api/cloud/presign?name=' +
        encodeURIComponent(f.name.replace(_plAudioExtRe, '')) + '&size=' + f.size)
        .then(r => r.json());
      if (!r || !r.ok){ failN++; continue; }
      if (r.dup){ dupN++; }
      else {
        await _cloudPutFile(r.url, f, p =>
          setStatus('● 上传到云端曲库（' + (i + 1) + '/' + files.length + '）：' +
            f.name + ' ' + Math.round(p * 100) + '%'));
        okN++;
      }
      // v3.85 歌词资料随歌上传（锁定篇 + 当前歌词）——重复上传也刷新，方便后补歌词
      const segs = (_plLocks[k] && _plLocks[k].segments) || [];
      const cur = _plCurLrcs[k] || null;
      if (segs.length || cur){
        const lr = await fetch(API_BASE + '/api/cloud/lock?k=' + encodeURIComponent(k))
          .then(x => x.json());
        if (lr && lr.ok && lr.url){
          await fetch(lr.url, { method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ segments: segs, cur }) });
          lyN++;
        }
      }
    }catch(err){ failN++; }
  }
  setStatus('● 云端曲库：新增 ' + okN + ' 首' +
    (dupN ? '（跳过 ' + dupN + ' 首重复）' : '') +
    (lyN ? '（歌词同步 ' + lyN + ' 首）' : '') +
    (failN ? '（失败 ' + failN + ' 首）' : ''));
  if (_plTab === 'online') _plOnlineFetch();
});

/* v3.79 删除按钮：有勾选才出现（右上角，关闭按钮左侧） */
function _plSyncDel(){
  const btn = document.getElementById('plDel');
  const n = _plSelected.size;
  btn.style.display = n ? 'inline-block' : 'none';
  btn.textContent = '\u{1F5D1}\uFE0F 删除' + (n ? ' ' + n : '');
}
/* v3.79 批量删除勾选歌曲：内存 + IDB(files/library/locks) + 喜欢/最近 */
async function _plDeleteSelected(){
  const keys = [..._plSelected];
  if (!keys.length) return;
  if (!window.confirm('确定删除选中的 ' + keys.length + ' 首歌曲吗？\n' +
      '将同时清除本机保存的歌曲记录（原始文件不会被删除）')) return;
  const keySet = new Set(keys);
  const playingKey = _plIdx >= 0 ? _plKey(_plItems[_plIdx]) : null;
  const playingDeleted = playingKey && keySet.has(playingKey);
  _plItems.filter(it => keySet.has(_plKey(it)))
    .forEach(it => URL.revokeObjectURL(it.url));
  _plItems = _plItems.filter(it => !keySet.has(_plKey(it)));
  // 喜欢 / 最近同步
  keys.forEach(k => _plLikedKeys.delete(k));
  _plSaveLiked();
  for (let i = _plRecentKeys.length - 1; i >= 0; i--)
    if (keySet.has(_plRecentKeys[i])) _plRecentKeys.splice(i, 1);
  _plSaveRecent();   // v3.98：删除歌曲后同步保存最近播放
  // 歌词锁定数据同步
  let lockChanged = false;
  keys.forEach(k => { if (k in _plLocks){ delete _plLocks[k]; lockChanged = true; } });
  let clrcChanged = false;
  keys.forEach(k => { if (k in _plCurLrcs){ delete _plCurLrcs[k]; clrcChanged = true; } });
  if (clrcChanged) idbPut('meta', 'curlrcs', _plCurLrcs).catch(() => {});
  if (lockChanged){
    idbPut('meta', 'locks', _plLocks).catch(() => {});
    _cloudLockDelete(keys);   // v3.84：云端锁定一并清除（防换设备后死而复生）
  }
  // 播放处理
  if (playingDeleted){
    if (!_plItems.length){
      _plIdx = -1;
      playerAudio.pause();
      playerAudio.removeAttribute('src');
      playerAudio.load();
      _plLockActive = null;
      _plManual = null;
      _plSelected.clear();
      _plRender();
      _plSyncDel();
      _plUpdateHeart();
    } else {
      const ni = Math.min(_plIdx, _plItems.length - 1);
      _plSelected.clear();
      _plPlay(ni);   // 内部会 _plRender
      _plSyncDel();
    }
  } else {
    // 下标因删除错位：按当前播放键重新定位
    if (playingKey) _plIdx = _plItems.findIndex(it => _plKey(it) === playingKey);
    _plSelected.clear();
    _plRender();
    _plSyncDel();
  }
  setStatus('● 已删除 ' + keys.length + ' 首歌曲');
  // IDB：删文件 + 重写曲库 meta
  try{
    await idbDel('files', keys);
    idbDel('spec', keys).catch(() => {});   // v4.00：频谱缓存随歌删除
    await idbPut('meta', 'library', _plItems.filter(it => !it.online).map(it => ({
      key: _plKey(it), name: it.name, size: it.file.size,
    })));
  }catch(err){
    setStatus('⚠️ 列表已删除，但本机记录清除失败：' + err);
  }
}

function _plPlay(i){
  if (!_plItems.length) return;
  if (_rtSpec) _rtFlush();   // v4.04：切歌前落盘上一首的实时渐进表
  _plIdx = (i + _plItems.length) % _plItems.length;
  _plSwitching = true;
  _plLockActive = null;     // v3.52：切歌后由锁定监测重新判定
  _plManual = null;         // v3.72：手动覆盖不跨歌保留
  /* v3.99：切歌必须清掉上一首的界面残留——歌词行/歌名/歌手/来源、候选版本、搜索框。
     否则新歌无缓存歌词时，旧歌歌词继续飞、左上角胶囊和搜索框仍显示旧歌名 */
  state.lyrics.lines = []; state.lyrics.title = ''; state.lyrics.artist = '';
  state.lyrics.source = ''; state.lyrics.userOffsetSec = 0;
  _flyLines.length = 0; _lastLyricIdx = -1;
  _match.cands = []; _match.selCid = null;
  const _ss = document.getElementById('subsSearch'); if (_ss) _ss.value = '';
  renderVersionSelect();
  buildLyricsAllList();
  const it = _plItems[_plIdx];
  playerAudio.src = it.url;
  /* v3.85：本机缺锁定篇或缺「当前歌词」时从云端补拉；本地已有缓存歌词立即应用 */
  const _lk = _plKey(it);
  if (!_plLocks[_lk] || !_plLocks[_lk].segments.length || !_plCurLrcs[_lk]) _cloudLockPull(_lk);
  _plMaybeApplyCurLrc(_lk);
  /* v4.00：加载离线频谱表（已有缓存立即生效；没有则后台异步分析，分析完成前
     查表回退全零帧——声音不受影响） */
  _specLoad(it);
  const pr = playerAudio.play();
  if (pr && pr.catch) pr.catch(() => {});
  _plPushRecent(it);
  _plUpdateHeart();
  _plRender();   // 最近播放视图下：新歌要置顶
}

/* 心形按钮：同步为当前歌曲的喜欢状态（v3.52 起只切 class，不再改内容/尺寸） */
function _plUpdateHeart(){
  const btn = document.getElementById('ppLike');
  const liked = _plIdx >= 0 && _plIsLiked(_plItems[_plIdx]);
  btn.classList.toggle('liked', liked);
  btn.title = liked ? '已喜欢（再点取消）' : '加入我喜欢的';
}
function _plToggleLike(){
  if (_plIdx < 0) return;
  const k = _plKey(_plItems[_plIdx]);
  if (_plLikedKeys.has(k)) _plLikedKeys.delete(k);
  else _plLikedKeys.add(k);
  _plSaveLiked();
  _plUpdateHeart();
  // 喜欢视图下取消喜欢：该行立即从列表消失
  if (_plTab === 'liked') _plRender();
}

function _plNext(){
  if (!_plItems.length) return;
  if (_plShuffle && _plItems.length > 1){
    let r;
    do { r = (Math.random() * _plItems.length) | 0; } while (r === _plIdx);
    _plPlay(r);
  } else {
    _plPlay(_plIdx + 1);
  }
}
function _plPrev(){
  if (!_plItems.length) return;
  // 已播放超过 3 秒：回到本曲开头；否则上一首（常见播放器习惯）
  if (playerAudio.currentTime > 3) playerAudio.currentTime = 0;
  else _plNext();   // 随机模式下"上一首"也随机跳一曲
}

function _plResume(){
  if (_plIdx < 0){ _plPlay(0); return; }
  _plSwitching = true;
  /* v4.00：声音不经 WebAudio，直接元素级 play 即可——没有 ctx 挂起问题 */
  const pr = playerAudio.play();
  if (pr && pr.catch) pr.catch(() => {});
}

/* v3.87 播放/暂停图标用内联 SVG（iOS 对 ⏸/▶ 字符缺字形，渲染成彩色小方块） */
const PP_SVG_PLAY = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">' +
  '<path d="M8.2 5.6v12.8c0 .9 1 1.5 1.8 1L20 13c.8-.5.8-1.6 0-2.1L10 4.6c-.8-.5-1.8.1-1.8 1z" fill="#fff"/></svg>';
const PP_SVG_PAUSE = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">' +
  '<rect x="6.6" y="5" width="4" height="14" rx="1.4" fill="#fff"/>' +
  '<rect x="13.4" y="5" width="4" height="14" rx="1.4" fill="#fff"/></svg>';

function _plPause(){
  _plManualPause = true;
  playerAudio.pause();
  /* v3.88：暂停后音源保持「播放器」（按钮亮播放器、波形静止）；
     不再自动回系统音频——要听系统声音由用户显式点「系统音频」 */
  document.getElementById('ppPlay').innerHTML = PP_SVG_PLAY;
  document.getElementById('playerBtn').classList.remove('playing');
  document.getElementById('playerBtn').style.setProperty('--b', '0');
  if ('mediaSession' in navigator) try{ navigator.mediaSession.playbackState = 'paused'; }catch(e){}
}

playerAudio.addEventListener('play', () => {
  _plSwitching = false;
  _plAutoResume = false; _plInterruptStopWatch();   // v3.88 正常播放清掉打断恢复标志
  // 若麦克风仍在工作：停掉麦克风（否则会和播放器声音叠加）
  if (micStream || _micNode || _micProc){
    stopAudio();
  }
  state.source = 'player';
  _setSourceUI('player');   // v3.88 音源高亮跟随播放器
  document.getElementById('ppPlay').innerHTML = PP_SVG_PAUSE;
  document.getElementById('playerBtn').classList.add('playing');
  if ('mediaSession' in navigator){
    try{ navigator.mediaSession.playbackState = 'playing'; }catch(e){}
    try{   // v3.88 锁屏/后台播放：媒体会话元数据（歌名上锁屏、耳机/控制中心可控）
      const cur = _plItems[_plIdx];
      navigator.mediaSession.metadata = new MediaMetadata({
        title: (cur && cur.name) || '本地歌曲', artist: '炫彩DJ', album: '本地曲库'
      });
    }catch(e){}
  }
  _plReanchor();          // v3.52：记录 播放器进度↔系统音频时钟 锚点
  _plSuppressSync(true);
});
playerAudio.addEventListener('pause', () => {
  if (_plSwitching) return;      // 换 src 切歌引起的 pause
  _plSuppressSync(true);         // v3.52：暂停 → 解除屏蔽窗口
  if (_plManualPause){ _plManualPause = false; return; }   // 用户手动暂停
  /* v3.88 来电/微信语音打断：系统强制 pause（非手动、非播完）→ 标记待恢复，
     挂断后（回前台/焦点回来/看门狗重试）自动恢复播放 */
  if (playerAudio.ended) return;
  if (playerAudio.currentTime <= 0.2) return;   // 尚未真正开播
  if (isFinite(playerAudio.duration) && playerAudio.duration - playerAudio.currentTime < 0.5) return;  // 即将播完
  _plAutoResume = true;
  if (!_plResumeTimer) _plResumeTimer = setInterval(_plInterruptTry, 2000);
  setStatus('📞 通话中已静音，挂断后自动恢复播放');
});
playerAudio.addEventListener('ended', () => { _plNext(); });
playerAudio.addEventListener('seeked', () => {
  _plReanchor();                 // v3.52：拖动进度后重锚
  _plSuppressSync(true);
});
playerAudio.addEventListener('loadedmetadata', () => {
  document.getElementById('ppDur').textContent = _plFmt(playerAudio.duration);
});
playerAudio.addEventListener('timeupdate', () => {
  document.getElementById('ppCur').textContent = _plFmt(playerAudio.currentTime);
  const seek = document.getElementById('ppSeek');
  if (document.activeElement !== seek && isFinite(playerAudio.duration) && playerAudio.duration > 0){
    seek.value = Math.round(playerAudio.currentTime / playerAudio.duration * 1000);
  }
});
document.getElementById('ppSeek').addEventListener('change', e => {
  if (isFinite(playerAudio.duration) && playerAudio.duration > 0){
    playerAudio.currentTime = e.target.value / 1000 * playerAudio.duration;
  }
});

/* 文件夹导入（v3.78：恢复「选中文件夹→自动添加里面所有音乐」；
   v3.52 起同时写入 IndexedDB，刷新/重开自动恢复，无需重新选目录） */
document.getElementById('folderInput').addEventListener('change', async e => {
  const AUDIO_RE = /\.(mp3|flac|m4a|wav|ogg|aac|wma|opus)$/i;
  const files = Array.from(e.target.files).filter(f =>
    AUDIO_RE.test(f.name) || AUDIO_RE.test(f.webkitRelativePath || ''));
  files.sort((a, b) =>
    (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, 'zh'));
  e.target.value = '';
  if (!files.length){ setStatus('⚠️ 该文件夹里没有找到音频文件'); return; }
  setStatus('● 正在保存曲库到本机（下次打开免再加载）…');
  // 记下旧键：整库替换，旧文件从 IDB 清掉（但保留这些歌曲的歌词锁定）
  const oldKeys = _plItems.map(it => _plKey(it));
  const newKeys = files.map(f => f.name.replace(/\.[^.]+$/, '') + '|' + f.size);
  _plItems.forEach(it => URL.revokeObjectURL(it.url));
  _plItems = files.map(f => ({
    name: f.name.replace(/\.[^.]+$/, ''), file: f, url: URL.createObjectURL(f),
  }));
  _plIdx = -1;
  _plRender();
  setStatus('● 已导入 ' + _plItems.length + ' 首歌曲');
  _plSelected.clear();
  _plSyncDel();
  _plPlay(0);
  // 异步持久化（不阻塞播放）
  try{
    const orphanKeys = oldKeys.filter(k => newKeys.indexOf(k) < 0);
    if (orphanKeys.length){ await idbDel('files', orphanKeys); idbDel('spec', orphanKeys).catch(() => {}); }
    for (const it of _plItems) if (!it.online) await idbPut('files', _plKey(it), it.file);
    await idbPut('meta', 'library', _plItems.filter(it => !it.online).map(it => ({
      key: _plKey(it), name: it.name, size: it.file.size,
    })));
    if (navigator.storage && navigator.storage.persist){
      try { await navigator.storage.persist(); }catch(e){}
    }
    setStatus('● 曲库已保存：' + _plItems.length + ' 首（刷新/重开自动恢复）');
  }catch(err){
    setStatus('⚠️ 曲库保存失败（仍可本次使用）：' + err);
  }
});

/* 面板开关（与设置面板互斥）& 播放控制 */
const playerPanelEl = document.getElementById('playerPanel');
const playerBtnEl = document.getElementById('playerBtn');
function setPlayerPanel(open){
  playerPanelEl.classList.toggle('show', open);
  playerBtnEl.classList.toggle('active', open);
  if (open){
    _plRender();
    setSettings(false);   // 互斥：关掉设置面板
  }
}
playerBtnEl.onclick = () =>
  setPlayerPanel(!playerPanelEl.classList.contains('show'));
document.getElementById('plClose').onclick = () => setPlayerPanel(false);
document.getElementById('plAdd').onclick = () =>
  document.getElementById('folderInput').click();
document.getElementById('ppPlay').onclick = () => {
  if (!_plItems.length){ document.getElementById('folderInput').click(); return; }
  if (playerAudio.paused){ _plManualPause = false; _plResume(); } else _plPause();
};
/* v3.88 来电挂断/回前台 → 立即尝试恢复播放（看门狗兜底每 2s 重试） */
document.addEventListener('visibilitychange', () => { if (!document.hidden) _plInterruptTry(); });
window.addEventListener('pageshow', () => _plInterruptTry());
window.addEventListener('focus', () => _plInterruptTry());
/* v3.88 Media Session：锁屏/控制中心/耳机线控 显示歌名并可控播放/暂停/上下曲，
   同时提升 iOS PWA 后台播放稳定性（standalone 切后台/锁屏不中断） */
if ('mediaSession' in navigator){
  try{ navigator.mediaSession.setActionHandler('play', () => { _plManualPause = false; _plResume(); }); }catch(e){}
  try{ navigator.mediaSession.setActionHandler('pause', () => _plPause()); }catch(e){}
  try{ navigator.mediaSession.setActionHandler('previoustrack', () => _plPrev()); }catch(e){}
  try{ navigator.mediaSession.setActionHandler('nexttrack', () => _plNext()); }catch(e){}
}
document.getElementById('ppNext').onclick = _plNext;
document.getElementById('ppPrev').onclick = _plPrev;
document.getElementById('ppLike').onclick = _plToggleLike;
document.getElementById('plDel').onclick = _plDeleteSelected;

/* 标签切换：所有歌曲 / 最近播放 / 我喜欢的（#plAdd 是导入动作，不走这里） */
document.querySelectorAll('.pl-tab[data-tab]').forEach(b => {
  b.onclick = () => {
    _plTab = b.dataset.tab;
    document.getElementById('plUp').style.display =   // v3.82 上传按钮仅在线曲库页显示
      (_plTab === 'online') ? 'inline-block' : 'none';
    if (_plTab === 'online') _plOnlineFetch();
    document.querySelectorAll('.pl-tab[data-tab]').forEach(x =>
      x.classList.toggle('active', x === b));
    _plRender();
  };
});

/* 播放模式：顺序循环 ↔ 随机（一个按钮两态，纯图标） */
document.getElementById('ppMode').onclick = () => {
  _plShuffle = !_plShuffle;
  const btn = document.getElementById('ppMode');
  btn.classList.toggle('on', _plShuffle);
  btn.innerHTML = _plShuffle ? '&#x1F500;&#xFE0E;' : '&#x1F501;&#xFE0E;';
  btn.title = _plShuffle ? '随机播放中（点一下切回顺序循环）' : '顺序循环中（点一下切换为随机播放）';
};

/* ============================================================
   v3.52 歌词锁定：锚点 / 锁定 / 自动加载 / 屏蔽识别 / 曲库恢复
   ============================================================ */
/* 记录"播放器进度 ↔ 服务器累计音频时钟"锚点（供屏蔽区间换算） */
function _plReanchor(){
  let audio = null;
  if (state.wsWallTime){
    audio = state.wsAudioTime + (performance.now() / 1000 - state.wsWallTime);
  }
  _plAnchor = { wall: performance.now() / 1000, pos: playerAudio.currentTime, audio };
}
/* 把当前锁定段映射成服务器音频时钟区间，通知服务器跳过自动识别 */
let _plSuppressSig = '';
function _plSuppressSync(force){
  let ranges = [];
  if (state.source === 'player' && !playerAudio.paused && _plLockActive && _plAnchor && _plAnchor.audio != null){
    const s = _plLockActive, b = _plAnchor;
    ranges = [[
      +(b.audio + (s.start - b.pos)).toFixed(2),
      +(b.audio + (s.end - b.pos)).toFixed(2),
    ]];
  }
  const sig = JSON.stringify(ranges);
  if (!force && sig === _plSuppressSig) return;
  _plSuppressSig = sig;
  if (ws && ws.readyState === 1){
    ws.send(JSON.stringify({ type: 'auto_lock_suppress', ranges, ttl: 20 }));
  }
}
/* 应用锁定歌词（重置飞行队列，走锁定计时） */
function _plApplyLocked(seg){
  state.lyrics.lines = seg.lines.map(l => ({ time: l.time, text: l.text }));
  state.lyrics.title = seg.title || '';
  state.lyrics.artist = seg.artist || '';
  state.lyrics.source = (seg.source || 'locked') + '_locked';
  state.lyrics.userOffsetSec = seg.alignOffsetSec || 0;   // v3.53 恢复该段保存的对齐
  state.lyrics.audioOffsetSec = 0;
  state.lyrics.wallTimeAtLyricSec = performance.now() / 1000;
  _flyLines.length = 0;
  _lastLyricIdx = -1;
  buildLyricsAllList();
  _plLockActive = seg;
  if (subsSearch && seg.title) subsSearch.value = seg.title;
  setStatus('🔒 已自动加载锁定歌词：' + (seg.title || '当前歌词'));
  _plSuppressSync(true);
}
/* v3.72：手动播放某篇已锁定歌词——立即切换、从该篇第一句开始播。
   锁定数据不变；歌词播完后由监测循环恢复自动锁定流程。 */
function _plPlayLock(seg){
  const data = _plCurLocks();
  if (!data || data.segments.indexOf(seg) < 0) return;
  _plManual = {
    kind: 'lock', seg,
    anchorTime: playerAudio.currentTime, anchorLyricSec: 0,
  };
  state.lyrics.lines = seg.lines.map(l => ({ time: l.time, text: l.text }));
  state.lyrics.title = seg.title || '';
  state.lyrics.artist = seg.artist || '';
  state.lyrics.source = (seg.source || 'locked') + '_manual';
  state.lyrics.userOffsetSec = 0;        // 从头：不沿用该段 alignOffset
  state.lyrics.audioOffsetSec = 0;
  state.lyrics.wallTimeAtLyricSec = performance.now() / 1000;
  _flyLines.length = 0;
  _lastLyricIdx = -1;
  buildLyricsAllList();
  setStatus('🎵 已切换播放：' + (seg.title || '该篇') +
    '（播完后自动接下一篇锁定歌词）');
}
/* v3.72：手动播放搜索版本——保持当前播放位置对齐（同 pickVersion 既有机制），
   但挂上手动覆盖，穿过锁定段边界也不会被强制切回 */
function _plPlaySearch(c){
  const posSec = currentSongSec();   // 先取旧坐标系下的歌内位置
  _plManual = {
    kind: 'search', cid: String(c.cid),
    anchorTime: playerAudio.currentTime, anchorLyricSec: posSec,
  };
  pickVersion(c.cid);   // 内部再调 currentSongSec 时已走手动分支（位置连续）
  setStatus('🎵 已切换播放：' + (c.title || '该版本') +
    '（播完后自动接下一篇锁定歌词）');
}
/* 结束手动覆盖（不直接设 _plManual，由调用方保证恢复判定同帧执行） */
function _plEndManual(){
  _plManual = null;
}
/* 用当前歌词构造一段锁定（起点=当前进度−歌词内位置 → 下次播到起点直接从第一句开始） */
function _plDuration(){
  return (isFinite(playerAudio.duration) && playerAudio.duration > 0)
    ? playerAudio.duration : 0;
}
function _plMakeSegmentFromCurrent(){
  if (!state.lyrics.lines.length) return null;
  const dur = _plDuration() || (playerAudio.currentTime + 600);
  const lastT = state.lyrics.lines.reduce((m, l) => Math.max(m, l.time), 0);
  // 当前歌词的歌曲位置 → 对应播放器起点
  let start = playerAudio.currentTime - currentSongSec();
  if (start < 0 || !isFinite(start)) start = 0;
  let end = start + Math.max(lastT, 30);
  if (end > dur) end = dur;
  return {
    start: +start.toFixed(2), end: +end.toFixed(2),
    title: state.lyrics.title, artist: state.lyrics.artist, source: state.lyrics.source,
    lines: state.lyrics.lines.map(l => ({ time: +l.time.toFixed(2), text: l.text })),
    alignOffsetSec: 0,
  };
}
/* 解除当前歌词的锁定：删除正在生效的段 + 覆盖当前进度的段 */
function _plUnlockCurrentLyrics(){
  if (_plIdx < 0){ setStatus('🔓 请先播放歌曲'); return false; }
  const data = _plLocks[_plKey(_plItems[_plIdx])];
  if (!data || !data.segments.length){
    setStatus('🔓 这首歌还没有锁定的歌词'); return false;
  }
  const p = playerAudio.currentTime;
  let removed = 0;
  if (_plLockActive){
    const i = data.segments.indexOf(_plLockActive);
    if (i >= 0){ data.segments.splice(i, 1); removed++; }
    _plLockActive = null;
  }
  for (let i = data.segments.length - 1; i >= 0; i--){
    const s = data.segments[i];
    if (p >= s.start && p <= s.end){ data.segments.splice(i, 1); removed++; }
  }
  if (!removed){
    setStatus('🔓 当前位置没有锁定的歌词（可在编辑页里删除其他段）'); return false;
  }
  _plLocksSave();
  _plSuppressSync(true);
  setStatus('🔓 已解除歌词锁定（删除 ' + removed + ' 段）');
  return true;
}
/* 🔒 按钮：锁定当前歌词并打开设置里的时间轴编辑器 */
document.getElementById('lockLyricsBtn').onclick = () => {
  if (_plIdx < 0 || !state.lyrics.lines.length) return;
  const fk = _plKey(_plItems[_plIdx]);
  if (!_plLocks[fk]) _plLocks[fk] = { segments: [] };
  const seg = _plMakeSegmentFromCurrent();
  if (!seg) return;
  _plLocks[fk].segments.push(seg);
  _plResolveOverlaps(_plLocks[fk]);   // v3.74：与既有段叠加则自动截断
  _plLocksSave();
  _plLockActive = seg;
  setStatus('🔒 已锁定歌词：' + (seg.title || '当前歌词') + '（可在设置里拖动调整起止）');
  setSettings(true);   // 打开时间轴编辑器
};
/* 播放监测（v3.72 状态机）：
   · 无手动覆盖：进锁定段→自动加载；离开段→解除（选择框随之空）
   · 手动覆盖中：锁定切换一律抑制；当前歌词播完（最后行+5s）→ 结束覆盖，
     此时在锁定段内→立即接播该段；不在段内→框空，等播放进入下一段自动开始 */
setInterval(() => {
  const lockBtn = document.getElementById('lockLyricsBtn');
  lockBtn.style.display = (state.source === 'player' && state.lyrics.lines.length) ? '' : 'none';
  // 选择框签名增量同步（暂停时也要反映锁定/手动状态变化）
  if (_vselSigLast !== _vselectSig()) renderVersionSelect();
  if (state.source !== 'player' || _plIdx < 0 || playerAudio.paused) return;
  _cloudLockPollTick(_plKey(_plItems[_plIdx]));   // v3.86：播放中检测其他设备的锁定/歌词更新
  const p = playerAudio.currentTime;
  const data = _plLocks[_plKey(_plItems[_plIdx])];
  const seg = data && data.segments.find(s => p >= s.start && p <= s.end);

  if (_plManual){
    // 搜索版本歌词尚未到达（显示源仍是旧锁定/手动歌词）时不做"播完"判定
    const waitingSearch = _plManual.kind === 'search' &&
      /_(locked|manual)$/.test(state.lyrics.source || '');
    // v3.75：主动搜索后歌词迟迟未到（网络异常/无响应）→20秒撤销挂起，恢复自动流程
    if (waitingSearch && _plManual.cid === '__lookup__' &&
        playerAudio.currentTime - _plManual.anchorTime > 20){
      _plEndManual();
      setStatus('⚠ 搜索超时，已恢复锁定歌词自动播放');
    }
    if (_plManual && !waitingSearch){
      const cs = currentSongSec();
      const maxT = state.lyrics.lines.reduce((m, l) => Math.max(m, l.time), 0);
      if (cs >= maxT + MANUAL_TAIL_SEC){
        _plEndManual();
        // 强制重判：active 置空后下面的分支保证重新接播真实段（或按段外处理），
        // 否则当真实段恰为 active 时会误判"无需切换"，屏幕残留手动歌词
        _plLockActive = null;
      }
    }
  }

  if (!_plManual){
    if (seg && _plLockActive !== seg){
      _plApplyLocked(seg);
    } else if (!seg && _plLockActive){
      _plLockActive = null;
      _plSuppressSync(true);
    }
  }
  _plSuppressSync(false);   // 周期重发，防止服务器 TTL 过期
}, 250);

/* 启动恢复：IndexedDB 曲库 + 锁定数据（刷新/重开免再选目录） */
async function _plRestoreLibrary(){
  try{
    _idb = await idbOpen();
    /* v4.00：启动即请求持久存储权限（避免 iOS 存储压力时清空曲库），
       且 liked/recent 有 IDB 镜像——localStorage 被单独清掉也能兜回 */
    if (navigator.storage && navigator.storage.persist){
      try { navigator.storage.persist().catch(() => {}); } catch(e){}
    }
    if (!_plLikedKeys.size){
      try{
        const bak = await idbGet('meta', 'liked_bak');
        if (bak && bak.length){
          bak.forEach(k => _plLikedKeys.add(k));
          try { localStorage.setItem('phantom_liked', JSON.stringify(bak)); } catch(e){}
        }
      }catch(e){}
    }
    if (!_plRecentKeys.length){
      try{
        const bak = await idbGet('meta', 'recent_bak');
        if (bak && bak.length){
          bak.slice(0, 200).forEach(k => _plRecentKeys.push(k));
          try { localStorage.setItem('phantom_recent', JSON.stringify(_plRecentKeys)); } catch(e){}
        }
      }catch(e){}
    }
    const clrc = await idbGet('meta', 'curlrcs');
    if (clrc) _plCurLrcs = clrc;   // v3.85：每首歌的「当前歌词」缓存
    const locks = await idbGet('meta', 'locks');
    if (locks){
      _plLocks = locks;
      // v3.74：恢复时统一归一化——历史数据中的叠加段自动截断
      let normChanged = false;
      Object.keys(locks).forEach(k => {
        if (locks[k] && _plResolveOverlaps(locks[k])) normChanged = true;
      });
      if (normChanged) idbPut('meta', 'locks', locks).catch(() => {});
    }
    const lib = await idbGet('meta', 'library');
    /* v3.98：同时扫描 files 键——后台缓存崩溃可能留下「文件已入 IDB、library
       清单未写入」的孤儿文件（表现为已下载列表空白、点歌却能播）。
       用 openCursor 兜底 getAllKeys（旧版 Safari 兼容性）。 */
    let fileKeys = [];
    try { fileKeys = await _idbReq('files', 'readonly', s => s.getAllKeys()); } catch(_){}
    if (!fileKeys.length && _idb){
      try {
        fileKeys = await new Promise((res, rej) => {
          const tr = _idb.transaction('files', 'readonly');
          const store = tr.objectStore('files');
          const keys = [];
          const rq = store.openCursor();
          rq.onsuccess = e => {
            const c = e.target.result;
            if (c) { keys.push(c.key); c.continue(); }
            else res(keys);
          };
          rq.onerror = () => rej(rq.error);
        });
      } catch(__){}
    }
    const items = [];
    const seen = new Set();
    if (lib && lib.length){
      for (const m of lib){
        const file = await idbGet('files', m.key);
        if (file){
          items.push({ name: m.name, file, url: URL.createObjectURL(file) });
          seen.add(m.key);
        }
      }
    }
    for (const k of fileKeys){
      if (seen.has(k)) continue;
      const file = await idbGet('files', k);
      if (!file) continue;
      let name = file.name;
      if (typeof k === 'string' && k.lastIndexOf('|') > 0){
        name = k.slice(0, k.lastIndexOf('|')) || file.name;
      }
      items.push({ name, file, url: URL.createObjectURL(file) });
      seen.add(k);
    }
    if (items.length){
      _plItems = items;
      _plRender();
      // 补写清单（修复崩溃中途态）
      idbPut('meta', 'library', items.map(x => ({
        key: _plKey(x), name: x.name, size: x.file.size,
      }))).catch(() => {});
      setStatus('● 已恢复上次曲库：' + items.length + ' 首（点左下角 ♪ 即可播放）');
    }
  }catch(e){ /* 恢复失败：空库启动 */ }
}
_plRestoreLibrary();

/* ============================================================
   v3.52 锁定数据工具（v3.70：横向小编辑器已整套移除，
   仅保留时间格式化 leFmt 与当前锁定数据读取 _plCurLocks）
   ============================================================ */
function leFmt(t){
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = Math.floor(t % 60);
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
           : m + ':' + String(s).padStart(2, '0');
}
function _plCurLocks(){
  if (_plIdx < 0 || !_plItems[_plIdx]) return null;   // v3.94 越界防护（条目删除/测试清理时序）
  return _plLocks[_plKey(_plItems[_plIdx])] || null;
}

/* ============ v3.84 锁定歌词云端同步（v3.86 升级为实时双向同步） ============
 * 云端 locks/<fileKey>.json = { segments:[锁定篇], cur:{lrc,title,artist,source,ts},
 *   updatedAt:最后保存时间 }
 * 本机保存锁定/识别出新词 → 防抖直传 COS（SCF 签发预签名 PUT）；
 * 播放启动时拉取补缺；v3.86：播放中每 25s 轮询云端，发现 updatedAt/cur.ts 比本地新
 * → 热更新到正在播放的设备（锁定段监测下个周期自动接播，歌词立即应用），
 * last-write-wins：任何设备（含手机识别后锁定）保存的最新版本全设备同步。
 * fileKey 与本地曲库键一致（歌名|字节）→ 电脑/手机同名同大小文件共享同一份资料。 */
function _plLocksSave(fk){
  const k = fk || (_plIdx >= 0 && _plItems[_plIdx] ? _plKey(_plItems[_plIdx]) : null);
  if (k && _plLocks[k]) _plLocks[k].updatedAt = Date.now();   // v3.86 时间戳（云同步判新旧）
  idbPut('meta', 'locks', _plLocks).catch(() => {});
  if (k) _cloudLockUpload(k);
}
const _cloudLockT = {};
function _cloudLockUpload(k){
  clearTimeout(_cloudLockT[k]);
  _cloudLockT[k] = setTimeout(async () => {
    try{
      const segs = (_plLocks[k] && _plLocks[k].segments) || [];
      const cur = _plCurLrcs[k] || null;
      if (!segs.length && !cur) return;   // 没有任何歌词资料就不上传
      const cfg = await _cloudCfg();
      if (!cfg || !cfg.base) return;
      const r = await fetch(API_BASE + '/api/cloud/lock?k=' + encodeURIComponent(k))
        .then(r => r.json());
      if (!r || !r.ok || !r.url) return;
      await fetch(r.url, { method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments: segs, cur,
          updatedAt: (_plLocks[k] && _plLocks[k].updatedAt) || Date.now() }) });
    }catch(e){ /* 云同步失败静默：本地已存，不影响使用 */ }
  }, 1500);
}
function _cloudLockPull(k){
  (async () => {
    try{
      const cfg = await _cloudCfg();
      if (!cfg || !cfg.base) return;
      const j = await fetch(cfg.base + '/locks/' + _cloudEnc(k) + '.json',
        { cache: 'no-store' }).then(r => r.ok ? r.json() : null);
      if (!j) return;
      let touched = false, curAdded = false, segReplaced = false;
      // v3.86 last-write-wins：updatedAt 新者胜（手机锁定 → 电脑/其他手机自动跟上）
      const cloudU = j.updatedAt || 0, localU = (_plLocks[k] && _plLocks[k].updatedAt) || 0;
      if (j.segments && j.segments.length && cloudU >= localU){
        const c = _plLocks[k];
        if (!c || !c.segments.length ||
            cloudU > localU || JSON.stringify(c.segments) !== JSON.stringify(j.segments)){
          _plLocks[k] = { segments: j.segments, updatedAt: cloudU || Date.now() };
          touched = true; segReplaced = !!(c && c.segments.length);
        }
      }
      if (j.cur && j.cur.lrc && (j.cur.ts || 0) >= ((_plCurLrcs[k] && _plCurLrcs[k].ts) || 0) &&
          !_plCurLrcs[k]){
        _plCurLrcs[k] = j.cur; touched = true; curAdded = true;
      }
      if (!touched){
        // 本地更新（本机刚锁定/识别过）→ 回传云端收敛
        if (((_plLocks[k] && _plLocks[k].updatedAt) || 0) > cloudU ||
            ((_plCurLrcs[k] && _plCurLrcs[k].ts) || 0) > ((j.cur && j.cur.ts) || 0))
          _cloudLockUpload(k);
        return;
      }
      idbPut('meta', 'locks', _plLocks).catch(() => {});
      idbPut('meta', 'curlrcs', _plCurLrcs).catch(() => {});
      if (_plIdx >= 0 && _plItems[_plIdx] && _plKey(_plItems[_plIdx]) === k){
        if (segReplaced || curAdded){
          _plLockActive = null;   // 置空 → 监测循环下个周期重新判定（播到段内即自动加载）
          _plMaybeApplyCurLrc(k); // 云端 cur 歌词到货 → 立即应用（段内则交给锁定篇）
        }
      }
      setStatus('☁️ 已从云端同步最新歌词资料');
    }catch(e){ /* 无云端资料/网络失败：静默 */ }
  })();
}
/* v3.86 播放中云端更新轮询（25s 节流）：其他设备保存的锁定/歌词热同步到本机 */
let _cloudPollAt = 0, _cloudPollKey = null;
function _cloudLockPollTick(k){
  const now = Date.now();
  if (_cloudPollKey === k && now - _cloudPollAt < 25000) return;
  _cloudPollKey = k; _cloudPollAt = now;
  (async () => {
    try{
      const cfg = await _cloudCfg();
      if (!cfg || !cfg.base) return;
      const j = await fetch(cfg.base + '/locks/' + _cloudEnc(k) + '.json',
        { cache: 'no-store' }).then(r => r.ok ? r.json() : null);
      if (!j) return;
      let hot = false;
      const cloudU = j.updatedAt || 0, localU = (_plLocks[k] && _plLocks[k].updatedAt) || 0;
      if (j.segments && j.segments.length && cloudU > localU){
        _plLocks[k] = { segments: j.segments, updatedAt: cloudU };
        idbPut('meta', 'locks', _plLocks).catch(() => {});
        hot = true;
      }
      if (j.cur && j.cur.lrc && (j.cur.ts || 0) > ((_plCurLrcs[k] && _plCurLrcs[k].ts) || 0)){
        _plCurLrcs[k] = j.cur;
        idbPut('meta', 'curlrcs', _plCurLrcs).catch(() => {});
        hot = true;
      }
      if (hot && _plIdx >= 0 && _plItems[_plIdx] && _plKey(_plItems[_plIdx]) === k){
        if (!_plManual) _plLockActive = null;   // 监测循环重判 → 段内自动接播
        _plMaybeApplyCurLrc(k);
        setStatus('☁️ 已接收其他设备的锁定歌词，同步播放');
      }
    }catch(e){ /* 静默 */ }
  })();
}
/* v3.85：本机缓存了这首的「当前歌词」且当前位置不在锁定段内 → 立即应用
 * （走 applyServerMessage 的 lyrics 通道，复用对齐/自动跟随整套机制） */
function _plMaybeApplyCurLrc(k){
  const c = _plCurLrcs[k];
  if (!c || !c.lrc) return;
  if (_plManual) return;                       // 手动覆盖中不打断
  const data = _plLocks[k];
  if (data && data.segments.length){
    const p = playerAudio.currentTime;
    if (data.segments.some(s => p >= s.start && p <= s.end)) return;   // 段内：交给锁定篇
  }
  applyServerMessage({ data: JSON.stringify({
    type: 'lyrics', source: c.source || 'cloud',
    title: c.title || '', artist: c.artist || '',
    lrc: c.lrc, audio_offset_sec: playerAudio.currentTime || 0,
  })});
}
function _cloudLockDelete(keys){
  if (!keys.length) return;
  fetch(API_BASE + '/api/cloud/lock_del', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys }),
  }).catch(() => {});
}
/* v3.74：锁定段不可叠加。查询 seg 在当前歌曲中的时间轴邻居（按 start 排序） */
function _plNeighbors(seg){
  const data = _plCurLocks();
  if (!data) return { prev: null, next: null };
  const others = data.segments.filter(s => s !== seg)
    .sort((a, b) => a.start - b.start);
  let prev = null, next = null;
  for (const s of others){
    if (s.end <= seg.start) prev = s;
    else if (s.start >= seg.end && !next) next = s;
  }
  return { prev, next };
}
/* v3.74：自动截断所有叠加段——按 start 排序后逐对检查，若 a.end > b.start，
   在重叠区中点切开（双方各保留≥2秒；空间不足则边界向可容纳的一侧 clamp），
   返回是否发生了截断（调用方负责持久化） */
function _plResolveOverlaps(data){
  if (!data || !data.segments.length) return false;
  data.segments.sort((a, b) => a.start - b.start);
  let changed = false;
  for (let pass = 0; pass < data.segments.length; pass++){
    let passChanged = false;
    for (let i = 0; i < data.segments.length - 1; i++){
      const a = data.segments[i], b = data.segments[i + 1];
      if (a.end > b.start + 0.001){
        let mid = (a.end + b.start) / 2;
        mid = Math.max(a.start + 2, Math.min(b.end - 2, mid));
        a.end = +mid.toFixed(2);
        b.start = +mid.toFixed(2);
        changed = passChanged = true;
      }
    }
    if (!passChanged) break;
  }
  return changed;
}
/* v3.70：「📋 歌词详细编辑」按钮已移至设置面板「歌词版本」下方——
   点击打开全屏竖向锁定编辑页（改词/拖词/移整篇）；编辑页已打开时再点则关闭 */
document.getElementById('leDetail').onclick = () => {
  if (lvEl.classList.contains('show')) lvClose();
  else lvOpen();
};

/* ============================================================
   v3.53 全屏竖向锁定编辑页（画布右拖手势 → ✎ 编辑范围；
   竖着的刻度标尺，自由选择锁定区域，保存后段内不自动识别）
   ============================================================ */
const lvEl = document.getElementById('lockVEdit');
const lvTrack = document.getElementById('lvTrack');
const lvRuler = document.getElementById('lvRuler');
const lvPlayhead = document.getElementById('lvPlayhead');
const lvSb = document.getElementById('lvScrollbar');
const lvSbThumb = document.getElementById('lvSbThumb');
let lvWin = 0, lvSpan = 600, lvFollow = true;
let lvSegSel = null;   // v3.64：当前选中的锁定段（📋歌词按钮优先打开它）
const lvBlocks = new Map();    // seg 对象 -> 块 DOM

function lvOpen(){
  if (_plIdx < 0){ setStatus('⚠️ 请先在播放器里播放歌曲'); return; }
  const fk = _plKey(_plItems[_plIdx]);
  if (!_plLocks[fk]) _plLocks[fk] = { segments: [] };
  const data = _plLocks[fk];
  lvSegSel = null;   // 先清空，自动新建时会选中新段
  // 一段都没有 → 用当前歌词新建（等价于锁定 + 进入编辑）
  if (!data.segments.length){
    const ns = _plMakeSegmentFromCurrent();
    if (ns){
      data.segments.push(ns);
      _plLockActive = ns;
      lvSegSel = ns;   // v3.67：新建即选中（进入就地编辑态）
    }
  }
  // v3.74：打开编辑页前自动截断所有叠加段（保证每篇都能单独点选/删除）
  if (_plResolveOverlaps(data)){
    _plLocksSave();
    setStatus('✂️ 检测到歌词篇叠加，已自动截断（可拖动各篇拉杆微调）');
  }
  lvEl.classList.add('show');
  const p = playerAudio.currentTime;
  const dur = _plDuration() || Math.max(p + 300, 600);
  const focus = _plLockActive || data.segments[0];
  const segLen = focus ? (focus.end - focus.start) : 120;
  // v3.57：打开即大尺度（一眼看全首歌），无需手动放大
  // v3.63：永久记住用户缩放尺度——lvSpan 存 localStorage，下次打开直接恢复上次大小
  const savedSpan = parseFloat(localStorage.getItem('lv_span') || '');
  if (savedSpan >= 10) lvSpan = Math.max(10, Math.min(Math.max(dur, 120), savedSpan));
  else lvSpan = Math.max(120, Math.min(dur, segLen * 1.3));
  lvWin = Math.max(0, (focus ? focus.start : p) - lvSpan * 0.06);
  lvFollow = true;
  document.getElementById('lvFollow').classList.add('on');
}
function lvClose(){
  lvEl.classList.remove('show');
  localStorage.setItem('lv_span', lvSpan);   // v3.63：关闭时记住缩放尺度
}
function lvFrame(){
  requestAnimationFrame(lvFrame);
  if (!lvEl.classList.contains('show')) return;
  const p = _plIdx >= 0 ? playerAudio.currentTime : 0;
  const dur = _plDuration() || Math.max(p + 300, 600);
  if (lvFollow) lvWin = p - lvSpan * 0.35;
  if (lvWin < 0) lvWin = 0;
  if (lvWin + lvSpan > dur) lvWin = Math.max(0, dur - lvSpan);
  const h = _rotRect(lvTrack.getBoundingClientRect()).height || 1;
  const yOf = sec => (sec - lvWin) / lvSpan * h;
  // 竖向刻度：按当前缩放选 ≥56px 间距的步长
  const STEPS = [5,10,15,30,60,120,300,600,900,1800,3600,7200];
  const step = STEPS.find(s => s / lvSpan * h >= 56) || 7200;
  let html = '';
  for (let s = Math.ceil(lvWin / step) * step; s < lvWin + lvSpan; s += step){
    const y = yOf(s);
    html += '<div class="lv-tick major" style="top:' + y + 'px"></div>'
         +  '<div class="lv-tick-lbl" style="top:' + y + 'px">' + leFmt(s) + '</div>';
  }
  lvRuler.innerHTML = html;
  lvPlayhead.style.top = yOf(p) + 'px';
  // v3.63：右侧网页式滚动条——滑块高度=窗口占整首歌比例，位置=当前窗口位置
  {
    const sh = lvSb.clientHeight || 1;
    const thH = Math.max(24, Math.min(sh, lvSpan / dur * sh));
    const maxWin = Math.max(0.001, dur - lvSpan);
    lvSbThumb.style.height = thH + 'px';
    lvSbThumb.style.top = (Math.min(Math.max(lvWin, 0), maxWin) / maxWin * (sh - thH)) + 'px';
  }
  const _lvSongEl = document.getElementById('lvSong');   // v3.69：该元素已移除，保留兼容
  if (_lvSongEl) _lvSongEl.textContent =
    (_plIdx >= 0 ? _plItems[_plIdx].name : '') +
    '　·　' + ((_plCurLocks() || { segments: [] }).segments.length) + ' 段锁定';
  const segs = (_plCurLocks() || { segments: [] }).segments;
  segs.forEach(seg => {
    let el = lvBlocks.get(seg);
    if (!el){ el = lvBuildBlock(seg); lvBlocks.set(seg, el); lvTrack.appendChild(el); }
    el.classList.toggle('sel', seg === lvSegSel);   // v3.67：同步选中高亮
    el.style.top = yOf(seg.start) + 'px';
    el.style.height = Math.max(16, yOf(seg.end) - yOf(seg.start)) + 'px';
    const t = el.querySelector('.lv-times');
    if (t) t.textContent = leFmt(seg.start) + ' → ' + leFmt(seg.end);
  });
  [...lvBlocks.entries()].forEach(([seg, el]) => {
    if (segs.indexOf(seg) < 0){ el.remove(); lvBlocks.delete(seg); }
  });
}
function lvBuildBlock(seg){
  const el = document.createElement('div');
  el.className = 'lv-seg';
  const name = document.createElement('span');
  name.className = 'lv-seg-name';
  name.textContent = seg.title || '锁定歌词';
  const eT = document.createElement('div'); eT.className = 'lv-edge t';
  const eB = document.createElement('div'); eB.className = 'lv-edge b';
  const tm = document.createElement('span'); tm.className = 'lv-times';
  const del = document.createElement('button'); del.className = 'lv-del'; del.textContent = '✕';
  el.append(eT, name, tm, eB, del);
  lvFillLines(el, seg, seg === lvSegSel);   // v3.67：选中块=可编辑行；否则只读
  lvWireDrag(el, eT, eB, seg);
  del.onpointerdown = e => e.stopPropagation();
  del.onclick = e => {
    e.stopPropagation();
    const data = _plCurLocks();
    if (!data) return;
    const i = data.segments.indexOf(seg);
    if (i >= 0) data.segments.splice(i, 1);
    if (_plLockActive === seg) _plLockActive = null;
    if (_plManual && _plManual.kind === 'lock' && _plManual.seg === seg){
      _plEndManual();   // v3.72：被删的段正处于手动播放→结束覆盖（同帧恢复自动判定）
    }
    if (lvSegSel === seg) lvSegSel = null;   // v3.67：删掉选中段后取消选中
    _plLocksSave();
    _plSuppressSync(true);
  };
  return el;
}
/* v3.55：把 seg.lines 每句歌词按时间位置展开铺进块内（top 用百分比，块拉伸时自动跟随）
   v3.56 修坐标系：lines[].time 是歌词时间轴（歌内相对秒），块内位置 = (time−alignOffsetSec)/(end−start)
   —— 锁定生效时 currentSongSec = 播放器进度 − seg.start + alignOffsetSec，行显示时刻
   currentTime = time − alignOffset + start，故块内进度 = time − alignOffset。旧公式误用
   (time − seg.start)，对串烧歌（seg.start 远大于歌词时间）行全被段外过滤清掉。
   v3.58：行为所有句都建行元素（不再段外过滤），定位交给 lvLayoutLines —— 拖边缘时实时重排，
   歌词行钉死在时间轴刻度上（间距不变），块边缘只起裁剪作用。
   v3.67：editable=true（选中块）时，每一行就地变成可编辑胶囊：input 改文字、整行上下拖改时间
   （ghost 跟手）、回车插行、行内 ✕ 删句——详细编辑功能从独立面板搬入块内。 */
function lvFillLines(el, seg, editable){
  const old = el.querySelector('.lv-lines');
  if (old) old.remove();
  const box = document.createElement('div');
  box.className = 'lv-lines';
  const rows = [];
  (seg.lines || []).forEach(line => {
    if (line.time == null) return;
    const row = document.createElement('div');
    if (editable){
      row.className = 'lv-line ed';
      const t = document.createElement('span'); t.className = 'lv-line-t'; t.textContent = leFmt(line.time);
      const inp = document.createElement('input');
      inp.className = 'lv-line-inp';
      inp.value = line.text || '';
      inp.placeholder = '输入歌词…';
      inp.addEventListener('input', () => { line.text = inp.value; lvSaveSoon(seg); });
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter'){
          e.preventDefault();
          const order = seg.lines.slice().sort((a,b)=>(a.time||0)-(b.time||0));
          const idx = order.indexOf(line);
          const next = order[idx + 1];
          const nt = next ? (line.time + next.time) / 2 : (line.time + 1);
          const nl = { time: +nt.toFixed(2), text: '' };
          seg.lines.push(nl);
          seg.lines.sort((a,b)=>(a.time||0)-(b.time||0));
          lvPersist(seg);
          lvFillLines(el, seg, true);
          const nr = el._lvRows.find(r => r.line === nl);
          if (nr) setTimeout(() => nr.inp.focus(), 30);
        }
      });
      const ld = document.createElement('button');
      ld.className = 'lv-line-del'; ld.textContent = '✕'; ld.title = '删除这句';
      ld.onpointerdown = e => { e.stopPropagation(); e.preventDefault(); };
      ld.onclick = e => {
        e.stopPropagation();
        const i = seg.lines.indexOf(line);
        if (i >= 0) seg.lines.splice(i, 1);
        lvPersist(seg);
        lvFillLines(el, seg, true);
      };
      row.append(t, inp, ld);
      lvWireLineGestures(el, seg, box, line, row, inp, t);
      box.appendChild(row);
      rows.push({ line, row, inp });
    } else {
      row.className = 'lv-line';
      const t = document.createElement('span'); t.className = 'lv-line-t'; t.textContent = leFmt(line.time);
      const x = document.createElement('span'); x.className = 'lv-line-x'; x.textContent = line.text || '· · ·';
      row.append(t, x);
      box.appendChild(row);
      rows.push({ line, row });
    }
  });
  el._lvRows = rows;
  el._lvBox = box;
  el.appendChild(box);
  lvLayoutLines(el, seg);
}
/* v3.67：行内拖拽手势（仅选中块的行）——
   按下：阻止冒泡（不触发整块移动）；移动 >6px 激活：整行 ghost translateY 跟手，
   按轨道实际像素尺度换算秒（拖到哪落到哪），相邻行 clamp ±0.05s；
   拖动期间 .lv-lines 临时 overflow:visible 允许ghost 超出块边缘；
   松手：拖过→sort+持久化+重铺；没拖→聚焦输入框编辑文字。 */
function lvWireLineGestures(el, seg, box, line, row, inp, t){
  let pd = null;
  row.addEventListener('pointerdown', e => {
    if (e.button != null && e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    pd = { y0:_rotXY(e).clientY, active:false, tOrig:line.time || 0 };
    try { row.setPointerCapture(e.pointerId); } catch(err){}
  });
  row.addEventListener('pointermove', e => {
    if (!pd) return;
    const dy = _rotXY(e).clientY - pd.y0;
    if (!pd.active && Math.abs(dy) < 6) return;
    if (!pd.active){
      pd.active = true;
      row.classList.add('dragging'); box.classList.add('ovf');
      try { inp.blur(); } catch(err){}
      const order = seg.lines.slice().sort((a,b)=>(a.time||0)-(b.time||0));
      const i = order.indexOf(line);
      pd.prev = i > 0 ? (order[i-1].time || 0) : 0;
      pd.next = i < order.length - 1 ? (order[i+1].time || 0) : Infinity;
    }
    const hh = _rotRect(lvTrack.getBoundingClientRect()).height || 1;
    let nt = pd.tOrig + dy / hh * lvSpan;
    nt = Math.max(pd.prev + 0.05, Math.min(pd.next - 0.05, nt));
    line.time = Math.max(0, +nt.toFixed(2));
    row.style.transform = 'translateY(calc(-50% + ' + dy + 'px))';
    t.textContent = leFmt(line.time);
  });
  row.addEventListener('pointerup', e => {
    const was = pd && pd.active;
    pd = null;
    try { row.releasePointerCapture(e.pointerId); } catch(err){}
    if (was){
      row.classList.remove('dragging'); box.classList.remove('ovf');
      seg.lines.sort((a,b)=>(a.time||0)-(b.time||0));
      lvPersist(seg);
      lvFillLines(el, seg, true);
    } else {
      inp.focus();   // 点击=编辑这句
    }
  });
  row.addEventListener('pointercancel', () => {
    pd = null; row.classList.remove('dragging'); box.classList.remove('ovf');
  });
}
/* v3.67：选中段 = 切换 .sel 高亮 + 所有块按选中/未选中重铺行（编辑态/只读态） */
function lvSetSel(seg){
  lvSegSel = seg;
  [...lvBlocks.entries()].forEach(([s, e2]) => {
    e2.classList.toggle('sel', s === seg);
    lvFillLines(e2, s, s === seg);
  });
}
/* v3.67：锁定段编辑持久化（无独立面板关闭动作，改动即存）
   · 输入文字走 lvSaveSoon 防抖；结构变化（拖词/插行/删句）立即 lvPersist
   · 该段正在播放时同步 state.lyrics.lines 文字（按时间匹配），主画布立即显示改后文字 */
let _lvSaveT = null;
function lvSaveSoon(seg){
  clearTimeout(_lvSaveT);
  _lvSaveT = setTimeout(() => lvPersist(seg), 500);
}
function lvPersist(seg){
  _plLocksSave();
  // 该段正在屏幕上（自动生效 或 手动覆盖播放）→ 同步文字改动
  const showingSeg = (_plLockActive === seg) ||
    (_plManual && _plManual.kind === 'lock' && _plManual.seg === seg);
  if (seg && showingSeg && state.lyrics.lines){
    seg.lines.forEach(ln => {
      let best = null, bd = 0.05;
      state.lyrics.lines.forEach(sl => {
        const dd = Math.abs((sl.time || 0) - (ln.time || 0));
        if (dd < bd){ bd = dd; best = sl; }
      });
      if (best) best.text = ln.text;
    });
  }
  _plSuppressSync(true);
}
/* v3.58：按当前 seg.start/end/alignOffsetSec 实时定位行（拖边缘时逐帧调用）
   行的时间轴位置 = seg.start + (time − alignOffsetSec)，与块高解耦 —— 间距永远不变 */
function lvLayoutLines(el, seg){
  const rows = el._lvRows;
  if (!rows) return;
  const len = Math.max(1, seg.end - seg.start);
  const off = seg.alignOffsetSec || 0;
  rows.forEach(({ line, row }) => {
    const p = (line.time - off) / len * 100;
    if (p < -2 || p > 102){ row.style.display = 'none'; return; }
    row.style.display = '';
    row.style.top = Math.max(0, Math.min(100, p)) + '%';
  });
}
/* v3.64：单句长按弹窗编辑已取消——歌词文字编辑统一在「📋 歌词」面板里直编（见 lvLinesOpen） */
/* 块=整体上下移动，上下边缘=改起止；空白处拖动=滚动时间轴
   v3.58：歌词行钉死在歌曲时间轴上（间距永不变），拖边缘 = 纯裁剪显示范围——
   · 拖动中逐帧 lvLayoutLines 实时重排（不再等松手，杜绝橡皮筋压缩）
   · 拖上边缘补偿 alignOffsetSec += Δstart（行在时间轴上的位置严格不动，上边缘只裁掉开头的行）
   · 拖下边缘无需补偿（行位置本来就和 end 无关）
   · 整体搬移（move）不改 off：len 不变，行随块整体平移，间距天然不变
   · 该段正在生效时同步 state.lyrics.userOffsetSec（currentSongSec 锁定分支读它，漏同步会跳词） */
function lvWireDrag(el, eT, eB, seg){
  const beginDrag = (mode, e) => {
    e.preventDefault(); e.stopPropagation();
    const rect = _rotRect(lvTrack.getBoundingClientRect());   // v3.90 body 空间矩形
    const target = e.currentTarget;
    const d = { y0: _rotXY(e).clientY, start0: seg.start, end0: seg.end,
      off0: seg.alignOffsetSec || 0, moved: false,
      dur: _plDuration() || Infinity };
    // v3.74：拖拽不可侵入相邻篇——记录起止时间轴邻居边界
    const nb = _plNeighbors(seg);
    d.minStart = nb.prev ? nb.prev.end : 0;
    d.maxEnd = nb.next ? nb.next.start : d.dur;
    // v3.67：move 模式只会在「块已选中」时进入（行胶囊/边缘/✕ 均自行拦截）
    if (mode === 'move') el.classList.add('grabbing');
    const move = ev => {
      const dySec = (_rotXY(ev).clientY - d.y0) / rect.height * lvSpan;
      if (Math.abs(dySec) > 0.5) d.moved = true;   // v3.64：区分点击与拖动
      if (mode === 'move'){
        const len = d.end0 - d.start0;
        const raw = d.start0 + dySec;
        const lo = d.minStart, hi = Math.max(d.maxEnd - len, lo);
        const gluedT = d.start0 <= lo + 0.01;   // 拖拽开始时块顶已贴住上一篇
        const gluedB = d.start0 >= hi - 0.01;   // 块底已贴住下一篇
        if (raw < lo - 0.001){
          // v3.76：整块上推顶住上一篇 → 不再定死：块顶贴住边界、块尺寸不变，
          // 歌词继续跟手上移，最上面的句子滑出顶边被自动截断
          seg.start = lo; seg.end = lo + len;
          seg.alignOffsetSec = d.off0 + (lo - raw);
          if (!d._truncT){ d._truncT = true; setStatus('✂️ 顶部歌词已截断，往回拖可恢复'); }
        } else if (raw > hi + 0.001){
          // 对称：下推顶住下一篇 → 块底贴住，歌词继续下移，底部句子被截
          seg.start = hi; seg.end = hi + len;
          seg.alignOffsetSec = d.off0 - (raw - hi);
          if (!d._truncB){ d._truncB = true; setStatus('✂️ 底部歌词已截断，往回拖可恢复'); }
        } else if (gluedT && d.off0 > 0){
          // 恢复期：往回拖时截断量逐减到0，顶部句子重新回到块内
          seg.start = raw; seg.end = raw + len;
          seg.alignOffsetSec = Math.max(0, d.off0 + (d.start0 - raw));
        } else if (gluedB && d.off0 < 0){
          seg.start = raw; seg.end = raw + len;
          seg.alignOffsetSec = Math.min(0, d.off0 + (d.start0 - raw));
        } else {
          const ns = Math.max(lo, Math.min(raw, hi));
          seg.start = ns; seg.end = ns + len;
          seg.alignOffsetSec = d.off0;
          d._truncT = false; d._truncB = false;
        }
      } else if (mode === 't'){
        const ns = Math.max(d.minStart,
          Math.min(d.start0 + dySec, seg.end - 2));
        seg.alignOffsetSec = d.off0 + (ns - d.start0);   // v3.58：钉住歌词行
        seg.start = ns;
      } else {
        seg.end = Math.min(d.maxEnd,
          Math.max(d.end0 + dySec, seg.start + 2));
      }
      if (_plLockActive === seg) state.lyrics.userOffsetSec = seg.alignOffsetSec || 0;
      lvLayoutLines(el, seg);   // v3.58：拖动中实时重排，行间距不随块高压压缩放
    };
    const up = () => {
      try { target.releasePointerCapture(e.pointerId); }catch(err){}
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      el.classList.remove('grabbing');
      if (mode === 'move' && !d.moved){   // v3.67：点击已选中块的空白=取消选中
        lvSetSel(null);
        return;
      }
      seg.start = +seg.start.toFixed(2); seg.end = +seg.end.toFixed(2);
      // v3.76：move 模式也可能因顶住截断改了 alignOffset，统一取整
      seg.alignOffsetSec = +(seg.alignOffsetSec || 0).toFixed(2);
      if (_plLockActive === seg) state.lyrics.userOffsetSec = seg.alignOffsetSec || 0;
      _plLocksSave();
      lvLayoutLines(el, seg);   // 取整后再定位一次
      _plSuppressSync(true);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.setPointerCapture(e.pointerId);
  };
  eT.onpointerdown = e => beginDrag('t', e);
  eB.onpointerdown = e => beginDrag('b', e);
  // v3.67：块内空白/标题处按下——
  // · 已选中：拖=整篇沿时间轴移动（beginDrag move）
  // · 未选中：移动>6px=滑动歌词预览（平移 lvWin），按下不移动=点击选中该篇
  // 行胶囊（lvWireLineGestures）/ del / 上下边缘都自带 stopPropagation，不会进到这里
  el.onpointerdown = e => {
    if (seg === lvSegSel){ beginDrag('move', e); return; }
    e.preventDefault();
    const g = { y0:_rotXY(e).clientY, win0:lvWin, pan:false };
    const h0 = _rotRect(lvTrack.getBoundingClientRect()).height || 1;
    const mv = ev => {
      const dy = _rotXY(ev).clientY - g.y0;
      if (!g.pan && Math.abs(dy) < 6) return;
      if (!g.pan){
        g.pan = true;
        lvFollow = false;
        document.getElementById('lvFollow').classList.remove('on');
      }
      lvWin = Math.max(0, g.win0 - dy / h0 * lvSpan);
    };
    const up2 = () => {
      try { el.releasePointerCapture(e.pointerId); } catch(err){}
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up2);
      if (!g.pan) lvSetSel(seg);
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up2);
    el.setPointerCapture(e.pointerId);
  };
}
lvTrack.addEventListener('pointerdown', e => {
  if (e.target !== lvTrack && e.target !== lvRuler) return;
  lvFollow = false;
  document.getElementById('lvFollow').classList.remove('on');
  const y0 = _rotXY(e).clientY, win0 = lvWin;
  let clickMoved = false;
  const move = ev => {
    if (Math.abs(_rotXY(ev).clientY - y0) > 6) clickMoved = true;
    lvWin = Math.max(0, win0 - (_rotXY(ev).clientY - y0) / _rotRect(lvTrack.getBoundingClientRect()).height * lvSpan);
  };
  const up = () => {
    try { lvTrack.releasePointerCapture(e.pointerId); }catch(err){}
    lvTrack.removeEventListener('pointermove', move);
    lvTrack.removeEventListener('pointerup', up);
    if (!clickMoved && lvSegSel) lvSetSel(null);   // v3.67：点空白=取消选中
  };
  lvTrack.addEventListener('pointermove', move);
  lvTrack.addEventListener('pointerup', up);
  lvTrack.setPointerCapture(e.pointerId);
});
/* v3.59：编辑页右侧留空区域，上下拖动 = 滚动时间轴（与拖轨道空白同逻辑，
   按轨道高度换算秒数；方便边听歌边浏览歌曲位置） */
document.getElementById('lvScrollZone').addEventListener('pointerdown', e => {
  lvFollow = false;
  document.getElementById('lvFollow').classList.remove('on');
  const zone = e.currentTarget;
  const y0 = _rotXY(e).clientY, win0 = lvWin;
  const move = ev => {
    lvWin = Math.max(0, win0 - (_rotXY(ev).clientY - y0) / _rotRect(lvTrack.getBoundingClientRect()).height * lvSpan);
  };
  const up = () => {
    try { zone.releasePointerCapture(e.pointerId); }catch(err){}
    zone.removeEventListener('pointermove', move);
    zone.removeEventListener('pointerup', up);
  };
  zone.addEventListener('pointermove', move);
  zone.addEventListener('pointerup', up);
  zone.setPointerCapture(e.pointerId);
});
/* v3.63：编辑页最右边网页式滚动条——拖滑块=滚时间轴，点轨道空白=跳到对应位置 */
lvSbThumb.addEventListener('pointerdown', e => {
  e.stopPropagation();
  e.preventDefault();
  lvFollow = false;
  document.getElementById('lvFollow').classList.remove('on');
  const sh = lvSb.clientHeight || 1;
  const dur = _plDuration() || 600;
  const maxWin = Math.max(0.001, dur - lvSpan);
  const thH = _rotRect(lvSbThumb.getBoundingClientRect()).height;
  const y0 = _rotXY(e).clientY, win0 = lvWin;
  const move = ev => {
    lvWin = Math.max(0, Math.min(maxWin, win0 + (_rotXY(ev).clientY - y0) / Math.max(1, sh - thH) * maxWin));
  };
  const up = () => {
    try { lvSbThumb.releasePointerCapture(e.pointerId); }catch(err){}
    lvSbThumb.removeEventListener('pointermove', move);
    lvSbThumb.removeEventListener('pointerup', up);
  };
  lvSbThumb.addEventListener('pointermove', move);
  lvSbThumb.addEventListener('pointerup', up);
  lvSbThumb.setPointerCapture(e.pointerId);
});
lvSb.addEventListener('pointerdown', e => {
  if (e.target !== lvSb) return;
  lvFollow = false;
  document.getElementById('lvFollow').classList.remove('on');
  const r = _rotRect(lvSb.getBoundingClientRect());
  const dur = _plDuration() || 600;
  const maxWin = Math.max(0, dur - lvSpan);
  lvWin = Math.max(0, Math.min(maxWin, (_rotXY(e).clientY - r.top) / (r.height || 1) * dur - lvSpan / 2));
});
document.getElementById('lvZoomIn').onclick = () => { lvSpan = Math.max(10, lvSpan / 1.5); localStorage.setItem('lv_span', lvSpan); };
document.getElementById('lvZoomOut').onclick = () => { lvSpan = Math.min(86400, lvSpan * 1.5); localStorage.setItem('lv_span', lvSpan); };
document.getElementById('lvFollow').onclick = function(){
  lvFollow = !lvFollow;
  this.classList.toggle('on', lvFollow);
};
document.getElementById('lvDone').onclick = lvClose;   // v3.69：右上角 ✕ 关闭
requestAnimationFrame(lvFrame);

/* ---------- WS：系统音频 (QQ 音乐等) + 歌词推送 ---------- */
let ws = null;
function connectWS(){
  if (ws) try{ ws.close(); }catch(e){}
  try{
    // v3.41 移动端：WS 主机跟随当前页面（手机访问 http://电脑IP:8000 时自动连同机 8001）；
    // file:// 直开时 hostname 为空 → 退回 localhost
    const wsHost = location.hostname || 'localhost';
    ws = new WebSocket('ws://' + wsHost + ':8001');
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { state.wsConnected = true; setStatus('● 系统音频已连接 (WASAPI loopback)'); };
    ws.onclose = () => { state.wsConnected = false; setTimeout(connectWS, 1500); };
    ws.onerror = () => { /* reconnect via close */ };
    ws.onmessage = e => applyServerMessage(e);
  }catch(e){
    setTimeout(connectWS, 2000);
  }
}

// v3.46: WS（本机模式）与 HTTP（云端模式）共用的消息入口
function applyServerMessage(e){
  if (typeof e.data !== 'string') return;
  try{
        const j = JSON.parse(e.data);
        // 帧数据 (含 'at' = 累计音频时长)
        if (j.type === 'frame' || j.type === 'level'){
          const arr = j.spectrum || j.spec || j.frame;
          // 播放器播放中：严格跟随播放器声音，忽略系统音频帧（防止覆盖）
          if (state.source !== 'player' && arr && arr.length){
            const spec = new Float32Array(FFT_BINS);
            for (let i = 0; i < FFT_BINS && i < arr.length; i++) spec[i] = arr[i];
            state.sysFrame = spec;
          }
          if (typeof j.at === 'number'){
            state.wsAudioTime = j.at;
            state.wsWallTime  = performance.now() / 1000;
          }
        }
        // 歌词推送
        else if (j.type === 'lyrics'){
          // v3.72：手动覆盖播放中，自动跟随推来的歌词不得冲掉用户的选择
          // （搜索版本的响应 source 不含 _auto，正常放行）
          if (_plManual && /_auto/.test(j.source || '')) return;
          setRecogIdle();
          const _newLines = parseLRC(j.lrc || '');
          const _plainText = _newLines.length ? '' :
            (j.lrc || '').replace(/\[\d{2}:\d{2}(?:\.\d+)?\]/g, '').trim();
          // v3.46k 新歌无歌词时保护当前歌词：只提示，不清空用户已选好的歌词
          if (!_newLines.length && !_plainText && state.lyrics.lines.length > 0){
            if (window._lyricsEmptyTip) window._lyricsEmptyTip.remove();
            const tip = document.createElement('div');
            tip.style.cssText = [
              'position:fixed','right:12px',
              'bottom:calc(12px + env(safe-area-inset-bottom,0px))',
              'background:rgba(0,0,0,0.72)','border:1px solid rgba(255,120,120,0.35)',
              'border-radius:8px','padding:7px 12px','max-width:min(72vw,340px)',
              'font-size:12px','color:#fbb','line-height:1.5','z-index:9999',
              'pointer-events:none'
            ].join(';');
            tip.textContent = '❌ 《' + (j.title || '该歌') +
              '》两家歌词库均无收录，当前歌词保持不变';
            document.body.appendChild(tip);
            window._lyricsEmptyTip = tip;
            setTimeout(() => { if (window._lyricsEmptyTip) { window._lyricsEmptyTip.remove(); window._lyricsEmptyTip = null; } }, 8000);
            setStatus('❌ ' + (j.title || '该歌') + ' 歌词库无收录，当前歌词未变');
            // v3.75：主动搜索挂起的「手动播放」待歌词未到达→撤销，恢复自动锁定流程
            if (_plManual && _plManual.cid === '__lookup__') _plEndManual();
            return;
          }
          // v3.52：服务器推来新词（用户手动识别/换版本）→ 解除锁定激活态，按新词计时
          if (typeof _plLockActive !== 'undefined') _plLockActive = null;
          state.lyrics.lines = _newLines;
          state.lyrics.title = j.title || '';
          state.lyrics.artist = j.artist || '';
          state.lyrics.source = j.source || '';
          /* v3.85：播放器歌曲识别/换版本到词 → 存入该歌的「当前歌词」缓存并同步云端
             （上传时随歌带走；其他设备播放云端版自动恢复，无需再识别） */
          if (state.source === 'player' && _plIdx >= 0 && _plItems[_plIdx] &&
              !_plItems[_plIdx].online && j.lrc){
            const ck = _plKey(_plItems[_plIdx]);
            _plCurLrcs[ck] = { lrc: j.lrc, title: j.title || '',
              artist: j.artist || '', source: j.source || '', ts: Date.now() };
            idbPut('meta', 'curlrcs', _plCurLrcs).catch(() => {});
            _cloudLockUpload(ck);
          }
          // 识别/换版本成功 → 只把【歌名】放进搜索框（不带歌手），方便直接改词再搜
          if (subsSearch && j.title){
            subsSearch.value = j.title;
          }
          state.lyrics.audioOffsetSec   = typeof j.audio_offset_sec === 'number' ? j.audio_offset_sec : state.wsAudioTime;
          state.lyrics.wallTimeAtLyricSec = performance.now() / 1000;
          state.lyrics.userOffsetSec = 0;
          _flyLines.length = 0;
          _lastLyricIdx = -1;
          buildLyricsAllList();
          // 歌词来源标签（自动跟随时显示简短）
          const isAuto = (j.source || '').includes('_auto');
          const srcTag = isAuto ? '🔄 自动' :
            j.source === 'netease' || j.source === 'manual_netease' ? '☁ 网易云' :
            j.source === 'audd' || j.source === 'manual_lrclib' ? '🎵 识别' : '🔍 手动';
          const lines = state.lyrics.lines;
          if (lines.length > 0){
            // v3.46 云端：每次歌词应用即重新武装客户端自动跟随
            if (CLOUD_MODE) armCloudAuto(lines);
            // 只把"识别歌曲/自动跟随"(非 manual_) 的结果记入识别历史；手动搜索不记
            if (!/manual_/.test(j.source || '')) recordHistory(j.title || '', j.artist || '');
            setStatus(`${srcTag}: ${j.title} - ${j.artist} (${lines.length} 行同步歌词)`);
            buildLyricsAllList();
            // 清除上方大字提示（如果有）
            if (window._lyricsEmptyTip) { window._lyricsEmptyTip.remove(); window._lyricsEmptyTip = null; }
          } else {
            // 歌词库都没有 → 尝试纯文本歌词（无时间码）
            const plain = (j.lrc || '').replace(/\[\d{2}:\d{2}(?:\.\d+)?\]/g, '').trim();
            if (plain){
              // 有纯文本 → 按一行显示，audioOffsetSec=0 从头滚
              state.lyrics.lines = plain.split('\n').filter(l => l.trim()).map(l => ({time: 0, text: l.trim()}));
              state.lyrics.audioOffsetSec = 0;
              setStatus(`${srcTag}: ${j.title} - ${j.artist} (纯文本歌词，无时间码，可用「歌词手动对齐」)`);
            } else {
              // v3.46h 右下角小字提示（不再弹中央大卡片遮挡画面）
              if (window._lyricsEmptyTip) window._lyricsEmptyTip.remove();
              const tip = document.createElement('div');
              tip.style.cssText = [
                'position:fixed','right:12px',
                'bottom:calc(12px + env(safe-area-inset-bottom,0px))',
                'background:rgba(0,0,0,0.72)','border:1px solid rgba(255,120,120,0.35)',
                'border-radius:8px','padding:7px 12px','max-width:min(72vw,340px)',
                'font-size:12px','color:#fbb','line-height:1.5','z-index:9999',
                'pointer-events:none'
              ].join(';');
              tip.textContent = '❌ 《' + (j.title || '该歌') +
                '》两家歌词库均无收录，可🔍搜歌名或一句歌词';
              document.body.appendChild(tip);
              window._lyricsEmptyTip = tip;
              setTimeout(() => { if (window._lyricsEmptyTip) { window._lyricsEmptyTip.remove(); window._lyricsEmptyTip = null; } }, 8000);
              setStatus('❌ ' + (j.title || '该歌') + ' — 两家歌词库都找不到！可手动🔍搜歌名或一句歌词');
            }
          }
        }
        // 候选歌词版本（识别/搜索后，推荐版本已先自动播放，这里存候选供用户改选）
        else if (j.type === 'lyric_choice'){
          _match.token = j.token || '';
          _match.cands = Array.isArray(j.candidates) ? j.candidates : [];
          _match.selCid = (j.recommended_cid != null ? String(j.recommended_cid) : null);
          _match.songTitle = j.title || '';
          _match.songArtist = j.artist || '';
          renderVersionSelect();
          if (matchVersionBtn) matchVersionBtn.style.display = '';
          // v3.46i 搜索词与推荐版歌名不符：提示手动挑选，未自动切换歌词
          if (j.query_mismatch){
            setStatus('🔍 找到 ' + _match.cands.length +
              ' 个候选，但歌名与搜索词不吻合 — 点「🎯 歌词版本更换」逐个挑');
          }
        }
        // 识别失败
        else if (j.type === 'recognize_failed'){
          setRecogIdle();
          setStatus('⚠ ' + (j.msg || '识别失败'));
        }
        // v3.45: AudD 低置信匹配（查无歌词）——未自动采用，仅提示
        else if (j.type === 'recognize_unverified'){
          setRecogIdle();
          setStatus('🛡 ' + (j.msg || '识别结果置信度低，未自动采用'));
        }
        // 识别中（防重复点击）
        else if (j.type === 'recognize_started'){
          // 带 msg 的是搜索/扩池（不录音），不进识别按钮状态机
          if (!j.msg) setRecogBusy();
          setStatus(j.msg ? ('🔎 ' + j.msg)
                          : '🔎 正在识别……（约 6 秒）');
        }
        // 自动跟随状态广播
        else if (j.type === 'auto_lock_ack'){
          state.autoLock.enabled = j.enabled;
          if (j.grace != null) state.autoLock.grace = j.grace;
          setAutoNextAt(j.next_at_audio);
          reflectAutoLock();
        }
        else if (j.type === 'auto_lock_tick'){
          setRecogIdle();
          setAutoNextAt(j.next_at_audio);
        }
        else if (j.type === 'auto_lock_changed'){
          setRecogIdle();
          state.lyrics.userOffsetSec = 0; // 新歌重新校
          setStatus('🔄 歌曲切换 → ' + (j.title || '新歌') + '，歌词已自动更新');
        }
        else if (j.type === 'auto_lock_same'){
          setRecogIdle();
          // 同首歌，静默
        }
        else if (j.type === 'auto_lock_failed'){
          setRecogIdle();
          const n = j.fail_count ? ('（' + j.fail_count + '/' + (j.fail_max||3) + '）') : '';
          setStatus('⚠ 自动扫描未识别' + n + ': ' + (j.msg || ''));
        }
        else if (j.type === 'auto_lock_dj_mode'){
          // 连续3次失败 → 纯DJ模式：按钮转关闭态
          state.autoLock.enabled = false;
          state.autoLock.nextAt = 0;
          reflectAutoLock();
          setStatus('🎧 ' + (j.msg || '已进入纯DJ模式'));
        }
        else if (j.type === 'auto_lock_resumed'){
          // 用户手动识别成功 → 自动跟随恢复
          state.autoLock.enabled = true;
          setAutoNextAt(j.next_at_audio);
          reflectAutoLock();
        }
        else if (j.type === 'auto_lock_started'){
          // 后台自动识别开始（录音15秒+识别）→ 按钮灰色倒计时
          setRecogBusy();
        }
        // 初始状态：告知识别 API 是否配好
        else if (j.type === 'status'){
          state.auddConfigured = !!j.audd_configured;
          state.acrConfigured = !!j.acr_configured;
          if (recogBtn){
            if (!j.acr_configured && !j.audd_configured){
              recogBtn.title = '需设置识别 API（见日志）';
            } else {
              recogBtn.title = '用 ACRCloud/AudD 识别当前歌曲';
            }
          }
          if (j.auto_lock_enabled !== undefined){
            state.autoLock.enabled = j.auto_lock_enabled;
            if (j.auto_lock_grace != null) state.autoLock.grace = j.auto_lock_grace;
            setAutoNextAt(j.auto_lock_next_at_audio);
            reflectAutoLock();
          }
        }
      }catch(_){}
}

/* ============================================================
 * v3.90 播放器本地文件识别：播放器模式下点「识别歌曲」不再开麦克风，
 * 直接从本地音乐文件截取当前播放位置前 15 秒提交云端识别。
 * 片段语义与麦克风录音完全一致（片段终点≈点击瞬间的播放位置），
 * 服务端 ACR play_offset_ms 锚点公式无需任何改动。
 *  - mp3/flac/wav(16bit)：字节级裁剪（零解码、省内存、瞬时完成）
 *  - m4a/ogg 等容器格式：decodeAudioData 全解码 → 单声道 16bit WAV
 *    （超长文件有内存上限，报错提示转 mp3）
 * ============================================================ */
function _plId3v2Size(u8){
  if (u8.length < 10 || u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return 0;
  const sz = ((u8[6]&0x7f)<<21)|((u8[7]&0x7f)<<14)|((u8[8]&0x7f)<<7)|(u8[9]&0x7f);
  return 10 + sz + ((u8[5]&0x10) ? 10 : 0);   // 10字节头 + 标签体 + footer
}
/* 从 buf 头开始搜音频帧同步字（mp3: 0xFF+版本/层合法位；flac: 0xFFF8xx） */
function _plFindSync(u8, isFlac){
  const end = Math.min(u8.length - 4, 262144);
  for (let i = 0; i < end; i++){
    if (u8[i] !== 0xFF) continue;
    const b1 = u8[i+1], b2 = u8[i+2];
    if (isFlac){ if ((b1 & 0xFC) === 0xF8) return i; }
    else if ((b1 & 0xE0) === 0xE0 && (b1 & 0x18) !== 0x08 && (b1 & 0x06) !== 0x00 &&
             (b2 & 0xF0) !== 0xF0 && (b2 & 0x0C) !== 0x0C) return i;
  }
  return -1;
}
/* 16bit PCM 字节包上 WAV 头（支持单/双声道，采样率取自源文件） */
function _plWrapWav(pcm, sr, ch){
  const bytes = pcm.byteLength;
  const buf = new ArrayBuffer(44 + bytes);
  const dv = new DataView(buf);
  const w = (o,s) => { for (let i=0;i<s.length;i++) dv.setUint8(o+i, s.charCodeAt(i)); };
  w(0,'RIFF'); dv.setUint32(4, 36 + bytes, true);
  w(8,'WAVEfmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * ch * 2, true);
  dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true);
  w(36,'data'); dv.setUint32(40, bytes, true);
  new Uint8Array(buf, 44).set(pcm);
  return buf;
}
/* 截取片段：返回 {data:ArrayBuffer, b:片段终点秒}。
   片段 [a,b]：a = max(0, p-15)，b = a+15（封顶歌曲长度）；
   p<15 时取歌曲开头 15s，锚点由调用方用 tAdj 补偿（b - p）。 */
/* ============================================================
 * v3.95 M4A/MP4 字节级裁剪（不再整本解码 PCM）
 * 解析 MP4 box：moov→trak(soun)→mdia→(mdhd, minf→stbl)
 *   mdhd 取 timescale；stbl 取 stsd/mp4a/esds（AudioSpecificConfig）、
 *   stts（时间→sample）、stsc/stsz/stco(co64)（sample→字节偏移）。
 * 裁出 [a,b] 内 AAC raw frame，逐帧加 ADTS 头（7B）→ .aac 数据，
 * ACRCloud 支持 AAC。127 分钟文件也只读 moov + 目标 15 秒字节。
 * ============================================================ */
function _mp4Four(u8,o){
  return String.fromCharCode(u8[o],u8[o+1],u8[o+2],u8[o+3]);
}
/* 列出缓冲区内直接子 box（自动跳 32/64 位 boxsize） */
function _mp4Children(u8,start,end){
  const dv = new DataView(u8.buffer,u8.byteOffset,u8.byteLength);
  const list=[]; let o=start;
  while(o+8<=end){
    let sz=dv.getUint32(o), hdr=8;
    if(sz===1){
      try{ sz=Number(dv.getBigUint64(o+8)); }catch(e){ break; }
      hdr=16;
    } else if(sz===0){ sz=end-o; }
    if(sz<hdr||o+sz>end) break;
    list.push({t:_mp4Four(u8,o+4),s:o+hdr,e:o+sz});
    o+=sz;
  }
  return list;
}
function _mp4Find(children,type){
  for(let i=0;i<children.length;i++) if(children[i].t===type) return children[i];
  return null;
}
/* ES Descriptor 解析（tag + 变长 size） */
function _mp4Desc(u8,o,limit){
  const tag=u8[o]; let p=o+1,sz=0,b;
  do{ b=u8[p]; sz=(sz<<7)|(b&0x7F); p++; }while((b&0x80)!==0&&p<limit);
  return {tag,s:p,e:p+sz};
}
async function _plMp4Clip(file,a,b,dur){
  const fsize=file.size;
  const readAt=async(o,n)=>new Uint8Array(await file.slice(o,Math.min(fsize,o+n)).arrayBuffer());
  /* 1) 顶层扫描：定位 moov，并记录全部 moof（分片 MP4）。仅读 box 头 */
  let off=0,moov=null; const moofs=[];
  while(off+8<=fsize){
    const h=await readAt(off,16);
    if(h.length<8) break;
    const hv=new DataView(h.buffer);
    let sz=hv.getUint32(0);
    const t=_mp4Four(h,4);
    if(sz===1){ sz=Number(hv.getBigUint64(8)); }
    else if(sz===0){ sz=fsize-off; }
    if(sz<=0) break;
    if(t==='moov'){ moov={s:off,sz}; }
    else if(t==='moof'){ moofs.push({s:off,sz}); }
    off+=sz;
  }
  if(!moov) throw new Error('M4A 缺少 moov 索引，无法裁剪');
  if(moov.sz>64*1048576) throw new Error('M4A 索引过大（>64MB），无法处理');
  /* 2) 读 moov 全文（缓冲以 moov 头开头），直接解析其子级 trak */
  const mb=await readAt(moov.s,moov.sz);
  const mdv=new DataView(mb.buffer);
  let traks=_mp4Children(mb,8,mb.length).filter(x=>x.t==='trak');
  let trak=null;
  for(const tr of traks){
    const mdia=_mp4Find(_mp4Children(mb,tr.s,tr.e),'mdia');
    if(!mdia) continue;
    const hdlr=_mp4Find(_mp4Children(mb,mdia.s,mdia.e),'hdlr');
    if(hdlr&&_mp4Four(mb,hdlr.s+8)==='soun'){ trak={tr,mdia}; break; }
  }
  if(!trak) throw new Error('M4A 中找不到音轨');
  const mdiaKids=_mp4Children(mb,trak.mdia.s,trak.mdia.e);
  const mdhdB=_mp4Find(mdiaKids,'mdhd');
  const minfB=_mp4Find(mdiaKids,'minf');
  const stblB=_mp4Find(_mp4Children(mb,minfB.s,minfB.e),'stbl');
  const stKids=_mp4Children(mb,stblB.s,stblB.e);
  const u32=o=>mdv.getUint32(mb.byteOffset+o);
  const u64=o=>Number(mdv.getBigUint64(mb.byteOffset+o));
  /* timescale：mdhd v0 @ data+12，v1 @ data+20 */
  const ver=mb[mdhdB.s];
  const timescale=u32(ver===1?mdhdB.s+20:mdhdB.s+12);
  /* stsd → mp4a → esds → AudioSpecificConfig */
  const stsdB=_mp4Find(stKids,'stsd');
  if(!stsdB) throw new Error('M4A 缺少音频参数，建议转 mp3');
  const entCnt=u32(stsdB.s+4);
  let p=stsdB.s+8, codec=null, esdsData=null;
  for(let e=0;e<entCnt;e++){
    const eSz=u32(p), eType=_mp4Four(mb,p+4);
    const eEnd=p+eSz;
    if(eType==='mp4a'){
      codec='aac';
      /* mp4a 8B box 头 + 28B AudioSampleEntry 固定字段后才是子 box（esds） */
      const sub=_mp4Children(mb,p+36,eEnd);
      const esds=_mp4Find(sub,'esds');
      if(esds) esdsData={s:esds.s+4,e:esds.e};   // 跳过 version/flags
    }
    p=eEnd;
  }
  if(codec!=='aac'||!esdsData) throw new Error('该 M4A 非 AAC 编码（可能是 ALAC），建议转 mp3');
  /* 描述符链：ES(0x03) → DecoderConfig(0x04) → DecSpecificInfo(0x05)=ASC */
  let asc=null;
  try{
    const dES=_mp4Desc(mb,esdsData.s,esdsData.e);
    let q=dES.s;
    while(q<dES.e&&mb[q]!==0x04) q++;
    const dDC=_mp4Desc(mb,q,dES.e);
    let r=dDC.s;
    while(r<dDC.e&&mb[r]!==0x05) r++;
    const dSI=_mp4Desc(mb,r,dDC.e);
    asc=mb.subarray(dSI.s,Math.min(dSI.e,dSI.s+4));
  }catch(e){}
  if(!asc||asc.length<2) throw new Error('无法读取 AAC 配置，建议转 mp3');

  /* 3) 选帧：sel = 目标区间内每帧 {o:文件绝对偏移, n:raw 长度} */
  let sel;
  if(moofs.length>0){
    /* —— 分片 MP4：解析 moof→traf(tfhd/tfdt/trun) + mdat —— */
    if(moofs.length>50000) throw new Error('分片数量异常，无法处理');
    const runs=[];   // {baseTime, samples:[{o,n,d}]}，按时间顺序
    for(const mf of moofs){
      const fb=await readAt(mf.s,mf.sz);
      const fdv=new DataView(fb.buffer);
      const fu32=o=>fdv.getUint32(fb.byteOffset+o);
      const fu64=o=>Number(fdv.getBigUint64(fb.byteOffset+o));
      for(const moofCh of _mp4Children(fb,8,fb.length)){
        if(moofCh.t!=='traf') continue;
        const trafKids=_mp4Children(fb,moofCh.s,moofCh.e);
        const tfhd=_mp4Find(trafKids,'tfhd');
        let baseDataOff=mf.s, defDur=0, defSize=0;
        let q=tfhd.s+8;   // 跳过 ver/flags + track_ID
        const flags=(fb[tfhd.s+1]<<16)|(fb[tfhd.s+2]<<8)|fb[tfhd.s+3];
        if(flags&0x01){ baseDataOff=fu64(q); q+=8; }
        if(flags&0x02){ q+=4; }
        if(flags&0x08){ defDur=fu32(q); q+=4; }
        if(flags&0x10){ defSize=fu32(q); q+=4; }
        if(flags&0x20){ q+=4; }
        if(flags&0x020000) baseDataOff=mf.s;   // default-base-is-moof
        const tfdt=_mp4Find(trafKids,'tfdt');
        const baseTime=tfdt ? (fb[tfdt.s]===1 ? fu64(tfdt.s+4) : fu32(tfdt.s+4)) : 0;
        const samples=[];
        for(const tk of trafKids){
          if(tk.t!=='trun') continue;
          let r=tk.s;
          const tflags=(fb[r+1]<<16)|(fb[r+2]<<8)|fb[r+3];
          const cnt=fu32(r+4); r+=8;
          if(tflags&0x01){ const dOff=fdv.getInt32(fb.byteOffset+r); r+=4; var cursor=baseDataOff+dOff; }
          else var cursor=baseDataOff;
          if(tflags&0x04) r+=4;
          for(let i=0;i<cnt;i++){
            let sd=defDur, ss=defSize;
            if(tflags&0x0100){ sd=fu32(r); r+=4; }
            if(tflags&0x0200){ ss=fu32(r); r+=4; }
            if(tflags&0x0400) r+=4;
            if(tflags&0x0800) r+=4;
            samples.push({o:cursor,n:ss,d:sd});
            cursor+=ss;
          }
        }
        runs.push({baseTime,samples});
      }
    }
    const ta=Math.max(0,a)*timescale, tb=b*timescale;
    sel=[];
    outer: for(const run of runs){
      let t=run.baseTime;
      for(const smp of run.samples){
        if(t+smp.d>ta && t<tb && smp.n>0) sel.push({o:smp.o,n:smp.n});
        t+=smp.d;
        if(t>=tb) break outer;
      }
    }
  } else {
    /* —— 常规 MP4：stts/stsc/stsz/stco(co64) —— */
    /* stts：时间→sample */
    const sttsB=_mp4Find(stKids,'stts');
    const sttsN=u32(sttsB.s+4);
    const stts=[];
    for(let i=0;i<sttsN;i++) stts.push([u32(sttsB.s+8+i*8),u32(sttsB.s+12+i*8)]);
    /* stsc */
    const stscB=_mp4Find(stKids,'stsc');
    const stscN=u32(stscB.s+4);
    const stsc=[];
    for(let i=0;i<stscN;i++) stsc.push([u32(stscB.s+8+i*12),u32(stscB.s+12+i*12)]);
    /* stsz */
    const stszB=_mp4Find(stKids,'stsz');
    const uniSz=u32(stszB.s);
    const stszCnt=u32(stszB.s+4);
    const sizeAt=i=>uniSz?uniSz:u32(stszB.s+8+i*4);
    /* stco / co64 */
    const coB=_mp4Find(stKids,'co64')||_mp4Find(stKids,'stco');
    if(!coB) throw new Error('M4A 缺少数据索引，无法裁剪');
    const co64=coB.t==='co64';
    const chunkCount=Math.floor((coB.e-coB.s)/(co64?8:4));
    const chunkAt=i=>co64?u64(coB.s+i*8):u32(coB.s+i*4);
    const spc=c=>{   // 0-based chunk → 每 chunk sample 数（stsc firstChunk 为 1-based）
      for(let j=stsc.length-1;j>=0;j--) if(c+1>=stsc[j][0]) return stsc[j][1];
      return stsc[0][1];
    };
    /* 时间 → 起止 sample */
    const mapSample=tu=>{
      let acc=0,idx=0;
      for(const [cnt,delta] of stts){
        const d=cnt*delta;
        if(tu<acc+d){ return idx+Math.floor((tu-acc)/delta); }
        acc+=d; idx+=cnt;
      }
      return idx;
    };
    const s0=Math.max(0,mapSample(Math.max(0,a)*timescale));
    let s1=Math.min(stszCnt,mapSample(b*timescale)+1);
    if(s1<=s0) s1=Math.min(stszCnt,s0+1);
    /* sample → chunk：线性定位 s0 所在 chunk */
    let c=0,before=0;
    for(;c<chunkCount;c++){
      const n=spc(c);
      if(s0<before+n) break;
      before+=n;
    }
    if(c>=chunkCount) throw new Error('裁剪定位失败');
    /* 顺序收集 [s0,s1) 的帧偏移 */
    sel=[];
    let curC=c, curIn=s0-before, curS=s0, cursor=chunkAt(curC);
    for(let k=0;k<curIn;k++) cursor+=sizeAt(before+k);  // 推到 chunk 内 curIn 起点
    while(curS<s1){
      const n=spc(curC);
      while(curS<s1&&curIn<n){
        sel.push({o:cursor,n:sizeAt(curS)});
        cursor+=sizeAt(curS);
        curS++; curIn++;
      }
      if(curS<s1){
        curC++; curIn=0;
        if(curC>=chunkCount) break;
        cursor=chunkAt(curC);
      }
    }
  }
  if(!sel.length) throw new Error('裁剪定位失败');

  /* 4) 合并相邻区间 → 读字节 → 逐帧 ADTS 封装 */
  const readRanges=[];
  for(const s2 of sel){
    const rs=s2.o, re=s2.o+s2.n;
    const last=readRanges[readRanges.length-1];
    if(last&&last[1]===rs) last[1]=re; else readRanges.push([rs,re]);
  }
  const parts=[]; let total=0;
  for(const [rs,re] of readRanges){
    const d=await readAt(rs,re-rs);
    parts.push(d); total+=d.length;
  }
  const raw=new Uint8Array(total);
  let cpy=0;
  for(const d of parts){ raw.set(d,cpy); cpy+=d.length; }
  const aot=((asc[0]&0xF8)>>3);          // AudioObjectType (2=AAC-LC)
  const profile=Math.max(0,aot-1);        // ADTS profile = AOT-1
  const freqIdx=((asc[0]&0x07)<<1)|((asc[1]&0x80)>>7);
  const chCfg=(asc[1]&0x78)>>3;
  const frameCount=sel.length;
  const out=new Uint8Array(total+frameCount*7);
  let w=0, rp=0;
  for(let i=0;i<frameCount;i++){
    const n=sel[i].n;
    const frameLen=7+n;
    out[w]=0xFF; out[w+1]=0xF1;
    out[w+2]=((profile&3)<<6)|((freqIdx&0xF)<<2)|((chCfg>>2)&1);
    out[w+3]=((chCfg&3)<<6)|((frameLen>>11)&3);
    out[w+4]=(frameLen>>3)&0xFF;
    out[w+5]=((frameLen&7)<<5)|0x1F;
    out[w+6]=0xFC;
    out.set(raw.subarray(rp,rp+n),w+7);
    w+=frameLen; rp+=n;
  }
  return {data:out.buffer.slice(0,w),b};
}

async function _plExtractClip(pAtClick){
  const it = _plItems[_plIdx];
  const dur = playerAudio.duration;
  const p = pAtClick || 0;
  const a = Math.max(0, p - 15);
  const b = Math.min(dur, a + 15);
  const ext = (((it.file && it.file.name) || it.name || '').split('.').pop() || '').toLowerCase();
  let file = it.file;
  if (!file && it.url){   // 云端直链播放（未升级本地条目）：先查后台缓存，没有再拉回
    let hit = null;
    try{
      if ('caches' in window){
        hit = await caches.match(it.url);
        if (hit) file = await hit.blob();
      }
    }catch(e){}
    if (!file){
      setStatus('⬇ 正在拉取音频用于识别…');
      const res = await fetch(it.url);
      if (!res.ok) throw new Error('音频下载失败 HTTP ' + res.status);
      file = await res.blob();
    }
  }
  if (!file) throw new Error('找不到音频文件');
  if (ext === 'mp3' || ext === 'flac'){
    const isFlac = ext === 'flac';
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const tagSz = isFlac ? 0 : _plId3v2Size(head);
    const audioBytes = Math.max(1, file.size - tagSz);
    const sB = tagSz + Math.floor(a / dur * audioBytes);
    const eB = Math.min(file.size, tagSz + Math.ceil(b / dur * audioBytes));
    let u8 = new Uint8Array(await file.slice(sB, eB).arrayBuffer());
    const si = _plFindSync(u8, isFlac);
    if (si > 0) u8 = u8.subarray(si);   // 对齐到真实帧头（修正码率估算误差）
    return { data: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength), b };
  }
  if (ext === 'wav'){
    const hbuf = await file.slice(0, 4096).arrayBuffer();
    const dv = new DataView(hbuf), u8h = new Uint8Array(hbuf);
    const tag4 = o => String.fromCharCode(u8h[o], u8h[o+1], u8h[o+2], u8h[o+3]);
    let sr = 44100, ch = 1, bits = 16, dataOff = -1, dataLen = 0;
    for (let off = 12; off + 8 <= hbuf.byteLength;){
      const id = tag4(off), sz = dv.getUint32(off + 4, true);
      if (id === 'fmt '){
        ch = dv.getUint16(off + 10, true);
        sr = dv.getUint32(off + 12, true);
        bits = dv.getUint16(off + 22, true);
      } else if (id === 'data'){ dataOff = off + 8; dataLen = sz; break; }
      off += 8 + sz + (sz & 1);
    }
    if (dataOff < 0 || bits !== 16 || ch < 1 || ch > 2){
      throw new Error('该 WAV 格式暂不支持直读，建议转 mp3');
    }
    const byteRate = sr * ch * 2;
    const s0 = Math.max(0, Math.floor(a * byteRate));
    const s1 = Math.min(dataLen, Math.ceil(b * byteRate));
    const pcm = new Uint8Array(await file.slice(dataOff + s0, dataOff + s1).arrayBuffer());
    return { data: _plWrapWav(pcm, sr, ch), b };
  }
  // v3.95：MP4 容器（m4a/mp4/mov/m4v）字节级裁剪 → ADTS AAC（不再整本解码）
  if (ext === 'm4a' || ext === 'mp4' || ext === 'mov' || ext === 'm4v'){
    return await _plMp4Clip(file, a, b, dur);
  }
  // 其他容器格式（ogg/opus/aac…）：全量解码 → 单声道 16bit WAV
  if (dur > 900) throw new Error('该格式文件过长（' + Math.round(dur/60) + '分钟），解码内存不足，建议转 mp3');
  setStatus('⏳ 正在解码音频（' + ext.toUpperCase() + '）…');
  const whole = await file.arrayBuffer();
  ensureAudioCtx();
  const ab = await audioCtx.decodeAudioData(whole.slice(0));
  const sr = ab.sampleRate;
  const s0 = Math.max(0, Math.floor(a * sr));
  const s1 = Math.min(ab.length, Math.ceil(b * sr));
  const n = Math.max(1, s1 - s0);
  const out = new Int16Array(n);
  const c0 = ab.getChannelData(0);
  const c1 = ab.numberOfChannels > 1 ? ab.getChannelData(1) : null;
  for (let i = 0; i < n; i++){
    const s = c1 ? (c0[s0+i] + c1[s0+i]) * 0.5 : c0[s0+i];
    out[i] = s < -1 ? -32768 : s > 1 ? 32767 : Math.round(s * 32767);
  }
  return { data: encodeWavI16(out, sr), b };
}
async function _plFileRecognize(isAuto){
  const it = _plItems[_plIdx];
  if (!it || _plIdx < 0) return { type: 'failed', msg: '播放器未在播放歌曲' };
  const dur = playerAudio.duration;
  if (!isFinite(dur) || dur <= 0){
    if (!isAuto) setStatus('⏳ 歌曲尚未加载完成，稍候 1~2 秒再点识别');
    return { type: 'precheck' };
  }
  if (!isAuto) setRecogBusy();
  try {
    const t0 = performance.now() / 1000;      // 点击时刻（墙钟秒）
    const pAtClick = playerAudio.currentTime || 0;
    /* v4.00：发声链路已无 WebAudio（环形录音随之移除），统一从音频源
       直接截取「点击瞬间往前 15 秒」——mp3/flac/wav/m4a 走字节级裁剪
       秒出，其他格式解码截取；播放/暂停中都能识别，任意时长可用。 */
    if (!isAuto) setStatus('🔎 正在从本地文件截取 15 秒识别……');
    const clip = await _plExtractClip(pAtClick);
    /* 锚点补偿：handleCloudResult 公式 songSecNow = anchor.songSecAtClick + (now - t0)
       服务端 anchor ≈ 片段终点 b（歌曲内秒）。片段终点若不等于点击位置 p，
       把 t0 平移成 t0 + (b - p)，使公式结果恒等于 p + (now - t0)。 */
    const tAdj = t0 + ((clip.b || 0) - pAtClick);
    const audioB64 = await arrayBufferToBase64(clip.data);
    let r;
    try {
      const res = await fetch(API_BASE + '/api/recognize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: audioB64 }),
      });
      r = await res.json();
    } catch(e){ r = { ok: false, error: '网络错误: ' + e }; }
    const ret = handleCloudResult(r, tAdj);
    setRecogIdle();
    return ret;
  } catch(e){
    setRecogIdle();
    setStatus('⚠ 本地识别失败：' + ((e && e.message) || e));
    return { type: 'error' };
  }
}

/* ============================================================
 * v3.46 云端 API：手机麦克风 WAV → Worker 识别 / 搜索
 * ============================================================ */
async function cloudRecognize(isAuto){
  /* v3.90 播放器模式：直接读本地文件识别，不再请求麦克风 */
  if (state.source === 'player' && _plIdx >= 0){
    return _plFileRecognize(isAuto);
  }
  if (!micStream){
    if (isAuto) return { type: 'failed', msg: '麦克风未开启' };
    // v3.46 麦克风入口在设置面板内 → 点识别即在点击手势内自动请求授权
    try {
      await startMicModeAsync(false);
      setStatus('🎤 麦克风已开启，请让音乐播放 12~15 秒后再点一次识别');
    } catch(e){
      setStatus('⚠ 麦克风开启失败或被拒绝：可点 ⚙ 设置 → 音源 → 麦克风 重试');
    }
    return { type: 'precheck' };
  }
  if (_micRingSamples < _micRingSR * 12){
    if (!isAuto){
      const backend = _micNode ? 'worklet' : (_micProc ? 'script' : '无');
      const diag = '[b ctx=' + (audioCtx ? audioCtx.state : '?') +
        ' 回调=' + _micCbCount + ' 方式=' + backend +
        ' SR=' + _micRingSR + ']';
      setStatus('⏳ 已录 ' + (_micRingSamples / _micRingSR).toFixed(1) +
        ' 秒/需12秒 ' + diag);
    }
    return { type: 'precheck' };
  }
  if (!isAuto) setStatus('🔎 正在识别……（约 6 秒）');
  const t0 = performance.now() / 1000;
  const wav = captureRingWav(15);
  const audioB64 = await arrayBufferToBase64(wav);
  let r;
  try {
    const res = await fetch(API_BASE + '/api/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: audioB64 }),
    });
    r = await res.json();
  } catch(e){
    r = { ok: false, error: '网络错误: ' + e };
  }
  return handleCloudResult(r, t0);
}

async function cloudSearch(q){
  setStatus('🔍 正在搜索: ' + q);
  let r;
  try {
    const res = await fetch(API_BASE + '/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q }),
    });
    r = await res.json();
  } catch(e){
    r = { ok: false, error: '网络错误: ' + e };
  }
  return handleCloudResult(r, null, q);
}

function handleCloudResult(r, t0, searchQ){
  if (!r || r.ok === false){
    setStatus('⚠ ' + ((r && r.error) || '云端服务错误'));
    return { type: 'error' };
  }
  if (r.type === 'failed'){
    setRecogIdle();
    setStatus('⚠ ' + r.msg);
    return { type: 'failed' };
  }
  if (r.type === 'unverified'){
    setRecogIdle();
    setStatus('🛡 ' + r.msg);
    return { type: 'unverified' };
  }
  if (r.type === 'choice'){
    setRecogIdle();
    // 识别锚点：按下瞬间的歌曲位置 + 真实流逝；搜索无锚点→0
    let songSecNow = 0;
    if (r.anchor && t0 != null){
      songSecNow = r.anchor.songSecAtClick + (performance.now() / 1000 - t0);
    }
    const rec = r.candidates.find(c => String(c.cid) === String(r.recommended_cid))
                || r.candidates[0];
    _match.cands = r.candidates;        // 含 lrc 全文，本地换版
    _match.token = '';
    _match.selCid = String(rec.cid);
    _match.songTitle = r.title;
    _match.songArtist = r.artist;
    /* v3.46i 手动搜索：推荐版歌名与搜索词无交集时，不自动替换当前歌词，
       只存候选让用户手动挑（防止搜"往事如烟"被切到"小城故事"） */
    if (searchQ){
      const norm = s => (s || '').toLowerCase()
        .replace(/[\s()（）\[\]【】\-—_·.,，。!！?？'"]/g, '');
      const nq = norm(searchQ), nt = norm(rec.title || r.title);
      const nameHit = nq && nt && (nt.indexOf(nq) >= 0 || nq.indexOf(nt) >= 0);
      if (!nameHit){
        renderVersionSelect();
        if (matchVersionBtn) matchVersionBtn.style.display = '';
        setStatus('🔍 找到 ' + r.candidates.length + ' 个候选，但与「' + searchQ +
          '」歌名不吻合（推荐为「' + (rec.title || r.title) + '」）— 点「🎯 歌词版本更换」逐个挑');
        return { type: 'choice' };
      }
    }
    const isAuto = state._cloudAutoTrigger;
    applyServerMessage({ data: JSON.stringify({
      type: 'lyrics',
      source: r.anchor
        ? ((r.anchor.by === 'audd' ? 'audd' : 'acr') + (isAuto ? '_auto' : ''))
        : 'manual',
      title: rec.title || r.title,
      artist: rec.artist || r.artist,
      lrc: rec.lrc,
      duration: rec.duration || r.duration,
      audio_offset_sec: songSecNow,
    })});
    renderVersionSelect();
    if (matchVersionBtn) matchVersionBtn.style.display = '';
    return { type: 'choice' };
  }
  return { type: 'unknown' };
}

/* ============================================================
   UI
   ============================================================ */
function setStatus(msg){
  if (statusEl) statusEl.textContent = msg || '';
  clearTimeout(setStatus._t);
  setStatus._t = setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
}

// 音源（v3.88：播放器成为一等音源——播放歌曲时自动亮「播放器」；切「麦克风」立即暂停播放器）
function _setSourceUI(src){
  document.querySelectorAll('#sourceSeg .seg-btn').forEach(x =>
    x.classList.toggle('active', x.dataset.source === src));
}
document.querySelectorAll('#sourceSeg .seg-btn').forEach(b => {
  b.onclick = () => {
    const src = b.dataset.source;
    if (src === 'system'){
      _setSourceUI(src);
      state.source = src;
      stopAudio();
      connectWS();
      setStatus('● 监听系统音频...');
    } else if (src === 'mic'){
      _setSourceUI(src);
      state.source = src;
      if (!playerAudio.paused) _plPause();   // 麦克风与播放器互斥：切麦克风立即停歌（_plPause 不再改音源，source 保持 mic）
      stopAudio();
      if (ws) ws.close();
      startMicMode();
      setStatus('● 麦克风已开启');
    } else if (src === 'player'){
      stopAudio();   // 停掉麦克风（若在收音）
      if (_plIdx >= 0 && _plItems.length){
        _setSourceUI(src);
        state.source = src;
        if (playerAudio.paused){ _plManualPause = false; _plResume(); }
      } else {
        setStatus('⚠️ 曲库还没有歌，先点「＋ 添加本地歌曲」导入');
        _setSourceUI(state.source);   // 回退高亮
      }
    }
  };
});

// 云端模式：系统音频依赖本机服务端，云端隐藏系统音频按钮；播放器(本地歌曲)云端可用
if (CLOUD_MODE){
  document.querySelectorAll('#sourceSeg .seg-btn').forEach(x => {
    if (x.dataset.source === 'system'){
      x.style.display = 'none';
    }
    if (x.dataset.source === 'mic') x.classList.add('active');
  });
}

// 配色
document.getElementById('color').addEventListener('change', e => {
  state.colorPalette = e.target.value;
});

// 滑杆
function bindSlider(id, key, fmt){
  const el = document.getElementById(id);
  const lab = document.getElementById(id+'V');
  el.value = state[key];
  lab.textContent = fmt(state[key]);
  el.addEventListener('input', () => {
    state[key] = parseFloat(el.value);
    lab.textContent = fmt(state[key]);
  });
}
bindSlider('sens',   'sens',   v => v.toFixed(2));
bindSlider('smooth', 'smooth', v => v.toFixed(2));
bindSlider('glow',   'glow',   v => v.toFixed(2));
bindSlider('lw',     'lw',     v => v.toFixed(2));

// ---------- 同步歌词：识别歌曲 + 搜索歌名/歌词 ----------
const recogBtn = document.getElementById('recogBtn');
const recogFillEl = document.querySelector('#recogBtn .recog-fill');
const recogLabelEl = document.querySelector('#recogBtn .recog-label');
const autoLockChip = document.getElementById('autoLockChip');
const autoLockChipText = document.getElementById('autoLockChipText');
const subsSearch = document.getElementById('subsSearch');
const searchBtn = document.getElementById('searchBtn');
const lyricsOnOffBtn = document.getElementById('lyricsOnOffBtn');

const RECOG_NOTE_HTML = '<span class="recog-note">&#x266A;&#xFE0E;</span>';
const RECOG_LABEL_HTML = RECOG_NOTE_HTML + ' 识别歌曲';
/* 识别按钮填充两态（v3.38：等待期绿色填充已取消，仅识别中灰色）：
   idle    —— 正常「🎵 识别歌曲」
   waiting —— 歌放完后 grace(20s) 等待期：按钮外观不变，仅左上 chip 读秒
   busy    —— 环形缓冲即时截取15s + 网络识别~5s：灰色按钮 + 灰色读条 + 「识别中 Ns」倒计时 */
const RECOG_EXPECT_SEC = 6;
const recogUI = { mode: 'idle', busyAt: 0 };
function setRecogBusy(){
  recogUI.mode = 'busy';
  recogUI.busyAt = performance.now();
}
function setRecogIdle(){ recogUI.mode = 'idle'; }

function updateRecogUI(){
  if (!recogBtn) return;
  const grace = state.autoLock.grace || 20;
  let mode = recogUI.mode;
  let remain = 0;
  if (mode !== 'busy'){
    if (state.autoLock.enabled && state.autoLock.nextAt){
      remain = (state.autoLock.nextAt - performance.now()) / 1000;
      mode = (remain > 0 && remain <= grace) ? 'waiting' : 'idle';
    } else mode = 'idle';
  }
  recogBtn.classList.toggle('busy', mode === 'busy');
  if (mode === 'busy'){
    const el = (performance.now() - recogUI.busyAt) / 1000;
    if (recogFillEl) recogFillEl.style.width =
      (Math.min(1, el / RECOG_EXPECT_SEC) * 100).toFixed(1) + '%';
    if (recogLabelEl){
      const left = Math.max(0, Math.ceil(RECOG_EXPECT_SEC - el));
      recogLabelEl.innerHTML = el >= RECOG_EXPECT_SEC
        ? RECOG_NOTE_HTML + ' 识别中…' : RECOG_NOTE_HTML + ' 识别中 ' + left + 's';
    }
    if (autoLockChip) autoLockChip.classList.remove('show');
  } else if (mode === 'waiting'){
    // v3.38：等待期按钮不再填充绿色，只保留左上角读秒胶囊
    if (recogFillEl) recogFillEl.style.width = '0%';
    if (recogLabelEl) recogLabelEl.innerHTML = RECOG_LABEL_HTML;
    if (autoLockChipText)
      autoLockChipText.textContent = '自动识别 ' + Math.ceil(remain) + 's';
    if (autoLockChip) autoLockChip.classList.add('show');
  } else {
    if (recogFillEl) recogFillEl.style.width = '0%';
    if (recogLabelEl) recogLabelEl.innerHTML = RECOG_LABEL_HTML;
    if (autoLockChip) autoLockChip.classList.remove('show');
  }
}

// ---- 同步歌词按钮群 ----
if (recogBtn){
  recogBtn.addEventListener('click', () => {
    if (recogUI.mode === 'busy') return;   // 识别中防重复点击
    if (CLOUD_MODE){ cloudRecognize(false); return; }
    if (!ws || ws.readyState !== 1){ setStatus('⚠ 未连上音频服务，等几秒再试'); return; }
    if (!state.acrConfigured && !state.auddConfigured){
      setStatus('⚠ 需配置 ACRCloud / AudD API 后重启服务，或用下方搜索框');
      return;
    }
    ws.send(JSON.stringify({type:'recognize'}));
    setStatus('🔎 正在识别……（约 6 秒）');
  });
}
if (searchBtn && subsSearch){
  const doSearch = () => {
    const q = subsSearch.value.trim();
    if (!q) { setStatus('⚠ 请先输入歌名、歌手，或一句歌词'); return; }
    if (CLOUD_MODE){ cloudSearch(q); return; }
    if (!ws || ws.readyState !== 1){ setStatus('⚠ 未连上音频服务'); return; }
    ws.send(JSON.stringify({type:'lookup_lyrics', query: q}));
    setStatus('🔍 正在搜索: ' + q);
    // v3.75：播放器中主动搜来的歌词按「手动播放」处理——歌名胶囊保持显示、
    // 锁定切换被抑制、歌词播完自动接锁定段（与下拉框选版本同一语义）
    if (state.source === 'player'){
      _plManual = { kind:'search', cid:'__lookup__',
        anchorTime: playerAudio.currentTime, anchorLyricSec: currentSongSec() };
    }
  };
  searchBtn.addEventListener('click', doSearch);
  subsSearch.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
}
// 歌词开关：关闭后歌词不再显示，搜索记录/候选/历史全部保留不删
if (lyricsOnOffBtn){
  lyricsOnOffBtn.addEventListener('click', () => {
    state.lyrics.hidden = !state.lyrics.hidden;
    lyricsOnOffBtn.textContent = state.lyrics.hidden ? '🔇 歌词 关' : '🎤 歌词 开';
    lyricsOnOffBtn.classList.toggle('active', !state.lyrics.hidden);
    if (state.lyrics.hidden){
      // 关掉同时收起歌词列表面板、清掉飞行中的句子
      const panel = document.getElementById('lyricsAllPanel');
      if (panel) panel.classList.remove('show');
      _flyLines.length = 0;
      setStatus('🔇 歌词已关闭（记录保留，点「歌词 开」随时恢复）');
    } else {
      _flyLines.length = 0;
      setStatus('🎤 歌词已开启，按当前播放位置精确对齐');
    }
  });
}

// ---------- 历史搜索记录（localStorage 持久，重开页面仍在）----------
const HIST_KEY = 'pb_lyric_history_v1';
let _history = [];
try { _history = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); }
catch (_) { _history = []; }
if (!Array.isArray(_history)) _history = [];

function saveHistory(){
  try { localStorage.setItem(HIST_KEY, JSON.stringify(_history)); } catch (_) {}
}
// 识别成功拿到歌词 → 记入识别历史（按【歌名】去重，同名点最新，上限20）
function recordHistory(title, artist){
  if (!title) return;
  const key = title.trim().toLowerCase();
  _history = _history.filter(h =>
    (h.title || '').trim().toLowerCase() !== key);
  _history.unshift({
    title, artist: artist || '',
    query: [title, artist].filter(Boolean).join(' '),
  });
  if (_history.length > 20) _history.length = 20;
  saveHistory();
}

const historyPanel = document.getElementById('historyPanel');

// v3.41: 面板 fixed 定位——桌面端放搜索框下方；窄屏（底部工具栏）放搜索框上方、左右贴边。
// 必须脱离 #ui/.row（窄屏 .row 是 overflow-x:auto 滚动容器，会裁掉向上弹出的面板）
function positionHistory(){
  if (!historyPanel || !subsSearch) return;
  historyPanel.style.left = '';
  historyPanel.style.right = '';
  historyPanel.style.top = '';
  historyPanel.style.bottom = '';
  historyPanel.style.width = '';
  const r = subsSearch.getBoundingClientRect();
  if (_isRot90()){
    /* v3.90 强制横屏：fixed 相对旋转后的 body 定位，全部换到 body 坐标系 */
    if (window.matchMedia('(max-width:820px)').matches){
      historyPanel.style.left = '10px';
      historyPanel.style.right = '10px';
      historyPanel.style.bottom = (r.right + 6) + 'px';   // body 高=innerWidth，r_body.top=innerWidth-r.right
    } else {
      historyPanel.style.left = r.top + 'px';
      historyPanel.style.top = (window.innerWidth - r.left + 6) + 'px';
    }
  } else if (window.matchMedia('(max-width:820px)').matches){
    historyPanel.style.left = '10px';
    historyPanel.style.right = '10px';
    historyPanel.style.bottom = (window.innerHeight - r.top + 6) + 'px';
  } else {
    historyPanel.style.left = r.left + 'px';
    historyPanel.style.top = (r.bottom + 6) + 'px';
    historyPanel.style.width = Math.max(220, r.width) + 'px';
  }
}

function renderHistory(){
  if (!historyPanel) return;
  // 只显示歌名：按歌名去重（同名保留最新一条），取最近20条
  const seen = new Set();
  const list = _history.filter(h => {
    const k = (h.title || '').trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 20);
  if (!list.length){
    historyPanel.innerHTML = '<div class="hist-empty">还没有识别记录<br>点「🎵 识别歌曲」后会自动保存歌名</div>';
    return;
  }
  historyPanel.innerHTML = '';
  list.forEach(h => {
    const d = document.createElement('div');
    d.className = 'hist-item';
    d.textContent = h.title;        // 只显示歌名
    d.title = h.title;
    // 用 mousedown：在输入框 blur 之前触发，避免面板先收起导致点不中
    d.addEventListener('mousedown', e => {
      e.preventDefault();
      if (subsSearch) subsSearch.value = h.title;
      if (ws && ws.readyState === 1){
        ws.send(JSON.stringify({type:'lookup_lyrics', query:h.title}));
        setStatus('🕘 从识别记录载入: ' + h.title);
      } else {
        setStatus('⚠ 未连上音频服务');
      }
      historyPanel.classList.remove('show');
    });
    historyPanel.appendChild(d);
  });
}

// 历史已并入搜索框：点击搜索框即弹出最近20条识别歌名；
// 开始输入或点搜索框/面板以外时收起
if (historyPanel){
  if (subsSearch){
    subsSearch.addEventListener('click', () => {
      renderHistory();
      positionHistory();
      historyPanel.classList.add('show');
    });
    // 用户一旦开始打字就收起历史，避免遮挡
    subsSearch.addEventListener('input', () =>
      historyPanel.classList.remove('show'));
  }
  document.addEventListener('mousedown', e => {
    if (historyPanel.classList.contains('show') &&
        !historyPanel.contains(e.target) && e.target !== subsSearch){
      historyPanel.classList.remove('show');
    }
  });
  // 窗口尺寸变化（含旋转屏）时按新位置重新摆放已打开的面板
  window.addEventListener('resize', () => {
    if (historyPanel.classList.contains('show')) positionHistory();
  });
}

// ---- 歌词版本更换：一键切下一版 + 下拉框自行选择 ----
const matchVersionBtn = document.getElementById('matchVersionBtn');
const versionSelect = document.getElementById('versionSelect');
const _match = {token:'', cands:[], selCid:null, songTitle:'', songArtist:''};

function fmtMatchDur(sec){
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}
function matchSrcName(src){ return src === 'netease' ? '网易云' : 'LRCLib'; }

// v3.73：下拉列表中锁定歌词只出现「当前正在播放的这一篇」（不再列出整首歌的所有锁定篇）；
// 无歌词时为空值（占位「点击选择歌词」）。搜索到的版本照常整组列出。
// 签名增量刷新：监测循环发现 sig 变化才重建（避免下拉打开时被定时重建关掉）
let _vselSigLast = '';
function _vselectSig(){
  // 屏幕上正在播放的锁定篇：手动播锁定篇→该篇；手动播搜索版→null；否则生效段
  const curLock = _plManual
    ? (_plManual.kind === 'lock' ? _plManual.seg : null)
    : _plLockActive;
  return JSON.stringify({
    lk: curLock ? [curLock.title, curLock.start, curLock.end] : null,
    c: _match.cands.map(c => [c.cid, c.title, c.artist, c.source, c.duration, c.recommended]),
    // 当前选中：手动覆盖优先；否则生效段；都没有=null（框空）
    cur: _plManual
      ? (_plManual.kind === 'lock'
          ? 'L'
          : ['S', String(_plManual.cid)])
      : (_plLockActive ? 'L' : null),
  });
}
function renderVersionSelect(){
  if (!versionSelect) return;
  versionSelect.innerHTML = '';

  // 空值占位（用户不可选；无歌词时框显示它）
  const ph = document.createElement('option');
  ph.value = ''; ph.disabled = true;
  ph.textContent = '🎵 点击选择歌词';
  versionSelect.appendChild(ph);

  // v3.73：锁定组只放「当前正在播放的这一篇」，其余锁定篇不出现在列表中
  const curLock = _plManual
    ? (_plManual.kind === 'lock' ? _plManual.seg : null)
    : _plLockActive;
  if (curLock){
    const g = document.createElement('optgroup');
    g.label = '🔒 当前播放';
    const o = document.createElement('option');
    o.value = 'lock';
    o.textContent = (curLock.title || '锁定歌词') + ' [🔒 ' +
      leFmt(curLock.start) + '→' + leFmt(curLock.end) + ']';
    g.appendChild(o);
    versionSelect.appendChild(g);
  }

  if (_match.cands.length){
    const g2 = document.createElement('optgroup');
    g2.label = '🔍 搜索到的歌词版本';
    _match.cands.forEach((c, i) => {
      const o = document.createElement('option');
      o.value = String(c.cid);
      let name = (c.title || '') + (c.artist ? ' - ' + c.artist : '');
      if (name.length > 22) name = name.slice(0, 21) + '…';
      o.textContent = (i + 1) + '. ' + (name || '?') +
        ' [' + matchSrcName(c.source) +
        (c.duration ? ' ' + fmtMatchDur(c.duration) : '') +
        (c.recommended ? ' 推荐' : '') + ']';
      g2.appendChild(o);
    });
    versionSelect.appendChild(g2);
  }

  // 当前值：手动覆盖→对应项；否则生效锁定段；都没有→空值
  let selectedVal = '';
  if (_plManual){
    selectedVal = _plManual.kind === 'lock' ? 'lock' : String(_plManual.cid);
  } else if (_plLockActive){
    selectedVal = 'lock';
  }
  const exists = [...versionSelect.options].some(o => o.value === selectedVal);
  versionSelect.value = exists ? selectedVal : '';
  versionSelect.style.display = (curLock || _match.cands.length) ? '' : 'none';
  _vselSigLast = _vselectSig();
}

// 选定某版本：服务端下发该版歌词，沿用识别时反推出的歌曲起点 →
// 无论什么时刻切换，都按当前播放位置精确落到对应 LRC 行
function pickVersion(cid){
  if (CLOUD_MODE){
    const c = _match.cands.find(x => String(x.cid) === String(cid));
    if (!c){ setStatus('⚠ 该版本不可用'); return; }
    _match.selCid = String(cid);
    if (versionSelect) versionSelect.value = String(cid);
    // 保持当前歌曲位置切版本（本地直接构造，无需服务器）
    applyServerMessage({ data: JSON.stringify({
      type: 'lyrics', source: c.source,
      title: c.title, artist: c.artist,
      lrc: c.lrc, duration: c.duration,
      audio_offset_sec: currentSongSec(),
    })});
    return;
  }
  if (!ws || ws.readyState !== 1){ setStatus('⚠ 未连上音频服务'); return; }
  ws.send(JSON.stringify({type:'pick_candidate', token:_match.token, cid:String(cid)}));
  _match.selCid = String(cid);
  if (versionSelect) versionSelect.value = String(cid);
}

// 点按钮 → 多个版本：一键切到下一个版本（末尾循环）；
//          只有1个版本：按歌名（不带歌手）重新搜索扩池
if (matchVersionBtn){
  matchVersionBtn.addEventListener('click', () => {
    if (!_match.cands.length){ setStatus('⚠ 当前没有其他歌词版本'); return; }
    if (_match.cands.length === 1){
      const songTitle = state.lyrics.title || _match.songTitle || '';
      if (!songTitle){ setStatus('⚠ 缺少歌名，无法重新搜索'); return; }
      if (CLOUD_MODE){
        cloudSearch(songTitle);
        setStatus('🔎 只有一个版本，正在按歌名「' + songTitle + '」重新搜索……');
        return;
      }
      if (!ws || ws.readyState !== 1){ setStatus('⚠ 未连上音频服务'); return; }
      ws.send(JSON.stringify({type:'expand_lyric_pool', title:songTitle}));
      setStatus('🔎 只有一个版本，正在按歌名「' + songTitle + '」重新搜索……');
      return;
    }
    let idx = _match.cands.findIndex(c => String(c.cid) === String(_match.selCid));
    idx = (idx + 1) % _match.cands.length;
    const c = _match.cands[idx];
    _plPlaySearch(c);   // v3.72：统一为手动覆盖播放（播完自动接锁定段）
  });
}
// 下拉框自行选择（v3.73：列表里锁定篇只有当前播放篇，选它=从头重播本篇）：
//   lock = 立即从头重播当前锁定篇；其余 = 立即播放该搜索版本（当前位置对齐）
if (versionSelect){
  versionSelect.addEventListener('change', () => {
    const v = versionSelect.value;
    if (v === 'lock'){
      const seg = (_plManual && _plManual.kind === 'lock')
        ? _plManual.seg : _plLockActive;
      if (seg) _plPlayLock(seg);
    } else {
      const c = _match.cands.find(x => String(x.cid) === String(v));
      if (c) _plPlaySearch(c);
      else setStatus('⚠ 该版本不可用');
    }
  });
}

// ---- 自动跟随按钮 ----
const autoLockBtn = document.getElementById('autoLockBtn');
const autoLockCountdown = document.getElementById('autoLockCountdown');

// 服务端下发的"音频时钟秒"→ 客户端墙钟倒计时
/* ---------- v3.46 云端自动跟随（纯客户端状态机） ---------- */
const cloudAuto = {
  enabled: true, grace: 30, pending: false,
  failCount: 0, djMode: false,
  songEndWall: 0,    // 最后一行对应的墙钟（秒）
  nextAtWall: 0,
};
const CLOUD_AUTO_FAIL_MAX = 3;

function armCloudAuto(arr){
  // 歌词应用后调用：推算最后一行的墙钟时刻
  const lastSec = arr.length ? arr[arr.length - 1].time : 0;
  cloudAuto.songEndWall = performance.now() / 1000 + (lastSec - currentSongSec());
  cloudAuto.nextAtWall = cloudAuto.songEndWall + cloudAuto.grace;
  cloudAuto.failCount = 0;
}

async function cloudAutoTick(){
  if (!cloudAuto.enabled || cloudAuto.pending || cloudAuto.djMode) return;
  // v3.52：锁定歌词生效中 → 云端也不自动识别
  if (typeof _plLockActive !== 'undefined' && _plLockActive) return;
  if (performance.now() / 1000 < cloudAuto.nextAtWall) return;
  cloudAuto.pending = true;
  state._cloudAutoTrigger = true;
  let r;
  try { r = await cloudRecognize(true); }
  catch { r = { type: 'error' }; }
  state._cloudAutoTrigger = false;
  if (r && r.type === 'choice'){
    cloudAuto.failCount = 0;   // armCloudAuto 已在歌词应用时执行
  } else {
    cloudAuto.failCount++;
    cloudAuto.songEndWall = performance.now() / 1000;
    cloudAuto.nextAtWall = cloudAuto.songEndWall + cloudAuto.grace;
    if (cloudAuto.failCount >= CLOUD_AUTO_FAIL_MAX){
      cloudAuto.djMode = true;
      cloudAuto.enabled = false;
      setStatus('🎧 连续 ' + CLOUD_AUTO_FAIL_MAX + ' 次没识别到，已暂停自动跟随；点识别按钮可恢复');
    }
  }
  cloudAuto.pending = false;
}

function setAutoNextAt(audioT){
  state.autoLock.nextAt = (typeof audioT === 'number')
    ? (performance.now() + (audioT - state.wsAudioTime) * 1000) : 0;
}
function reflectAutoLock(){
  if (autoLockBtn){
    autoLockBtn.textContent = state.autoLock.enabled ? '🔄 自动跟随' : '🔒 自动跟随';
    autoLockBtn.classList.toggle('active', state.autoLock.enabled);
  }
  if (autoLockCountdown && !state.autoLock.enabled){
    autoLockCountdown.textContent = '已暂停';
  }
}

if (autoLockBtn){
  autoLockBtn.addEventListener('click', () => {
    if (CLOUD_MODE){
      if (cloudAuto.djMode){
        cloudAuto.djMode = false; cloudAuto.failCount = 0;
        cloudAuto.songEndWall = performance.now() / 1000;
        cloudAuto.nextAtWall = cloudAuto.songEndWall + cloudAuto.grace;
      }
      cloudAuto.enabled = !cloudAuto.enabled;
      reflectAutoLock();
      setStatus(cloudAuto.enabled
        ? '🔄 自动跟随已开启（歌词放完后等 30 秒自动识别下一首）'
        : '🔒 自动跟随已暂停');
      return;
    }
    if (!ws || ws.readyState !== 1){ setStatus('⚠ 未连上音频服务'); return; }
    state.autoLock.enabled = !state.autoLock.enabled;
    ws.send(JSON.stringify({type:'auto_lock_config',
      enabled: state.autoLock.enabled}));
    reflectAutoLock();
    setStatus(state.autoLock.enabled
      ? '🔄 自动跟随已开启（歌词放完后等 30 秒自动识别下一首）'
      : '🔒 自动跟随已暂停');
  });
}
// 歌词全列表关闭按钮
const lyricsAllPanel = document.getElementById('lyricsAllPanel');
const lyricsAllClose = document.getElementById('lyricsAllClose');
if (lyricsAllClose){
  lyricsAllClose.addEventListener('click', () => {
    lyricsAllPanel && lyricsAllPanel.classList.remove('show');
  });
}
// 点歌词行时关闭面板（跳到该行）
if (lyricsAllPanel){
  lyricsAllPanel.addEventListener('click', e => {
    const item = e.target.closest('.lyric-all-item');
    if (!item) return;
    // 点行已由 buildLyricsAllList 处理，这里只关面板
    // lyricsAllPanel.classList.remove('show');
  });
}
// 倒计时更新（每秒刷新一次显示）
setInterval(() => {
  if (CLOUD_MODE){
    if (!autoLockCountdown) return;
    if (!cloudAuto.enabled){ autoLockCountdown.textContent = '已暂停'; return; }
    if (cloudAuto.pending){ autoLockCountdown.textContent = '识别中'; return; }
    const remain = Math.max(0, Math.ceil(cloudAuto.nextAtWall - performance.now() / 1000));
    autoLockCountdown.textContent = remain + 's';
    cloudAutoTick();
    return;
  }
  if (!autoLockCountdown || !state.autoLock.enabled || !state.autoLock.nextAt) return;
  const remain = Math.max(0, Math.ceil((state.autoLock.nextAt - performance.now()) / 1000));
  autoLockCountdown.textContent = remain + 's';
}, 1000);

// 歌词列表按钮（右侧面板）
const lyricsListBtn = document.getElementById('lyricsListBtn');
if (lyricsListBtn){
  lyricsListBtn.addEventListener('click', () => {
    if (!lyricsAllPanel) return;
    if (state.lyrics.hidden){
      setStatus('🔇 歌词已关闭，点「🎤 歌词 开」恢复后再查看');
      return;
    }
    const open = lyricsAllPanel.classList.toggle('show');
    lyricsListBtn.classList.toggle('active', open);
    if (open) buildLyricsAllList();
  });
}

// 启动：云端（HTTPS）不连本机 WS；本机模式直连
if (CLOUD_MODE){
  state.source = 'mic';
  reflectAutoLock();
  setStatus('☁️ 云端模式 · 点「🎵 识别歌曲」授权麦克风，音乐播放十几秒后即可识别');
} else {
  connectWS();
}

// 全屏 / 沉浸态
document.getElementById('fsBtn').addEventListener('click', async () => {
  /* v3.42: iPhone/iPad Safari【完全不支持】DOM Fullscreen API（只有 video 元素例外），
     点按钮永远无法全屏。iOS 唯一全屏路径 = 添加到主屏幕 + 从桌面图标启动
     （配合 head 里 apple-mobile-web-app-capable 声明） */
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (/Macintosh|MacIntel/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1); // iPadOS 桌面 UA
  if (isIOS){
    if (navigator.standalone === true){
      // v3.46d 桌面图标启动已是全屏：直接进入沉浸态（隐藏全部按钮）
      pinned = false; reflectPanel();
    } else {
      setStatus('📱 iPhone 全屏：① 点 Safari 底部「分享」图标 → ②「添加到主屏幕」→ ③ 先关掉本页，再【点桌面新图标启动】（在 Safari 里打开不会全屏）');
    }
    return;
  }
  /* v3.91：沉浸态立即进入，OS 级全屏尽力而为。
     背景：部分环境（Electron 内嵌渲染器、权限策略受限的 WebView）调用
     requestFullscreen() 后 Promise 长期挂起或静默失败——旧代码死等会导致
     点了按钮毫无反应。现在先收起 UI（3 秒后自动隐藏/点击呼出），
     再给 OS 全屏 600ms；超时或拒绝都只提示、不影响沉浸使用。 */
  if (document.fullscreenElement){
    try{ await document.exitFullscreen(); }catch(e){}
    return;
  }
  pinned = false;
  reflectPanel();
  if (document.documentElement.requestFullscreen){
    let done = false;
    const pr = document.documentElement.requestFullscreen();
    if (pr && pr.then){
      pr.then(()=>{ done = true; },
             e => { if (!done) setStatus('ℹ️ 已进入沉浸模式（系统全屏未生效：' +
                                         (e && e.name ? e.name : e) + '）'); });
      setTimeout(() => { if (!done && !document.fullscreenElement) done = true; }, 600);
    }
  }
});
/* v3.91 退出 DOM 全屏（Esc / 系统手势）→ 同步退出沉浸态，控制台与音符按钮恢复常驻。
   进入全屏时此事件也触发，但此时 fullscreenElement 非空，条件不满足。 */
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && !pinned){
    pinned = true;
    reflectPanel();
  }
});

// 设置三级面板：二级工具栏的「⚙ 设置」开关
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const settingsClose = document.getElementById('settingsClose');
function setSettings(open){
  if (!settingsPanel) return;
  settingsPanel.classList.toggle('show', open);
  if (settingsBtn) settingsBtn.classList.toggle('active', open);
  if (open && typeof setPlayerPanel === 'function') setPlayerPanel(false);
}
if (settingsBtn) settingsBtn.addEventListener('click', () =>
  setSettings(!settingsPanel.classList.contains('show')));
if (settingsClose) settingsClose.addEventListener('click', () => setSettings(false));

// v3.46f 人声提纯开关
const vocalEnhanceBtn = document.getElementById('vocalEnhanceBtn');
if (vocalEnhanceBtn) vocalEnhanceBtn.addEventListener('click', () => {
  state.vocalEnhance = !state.vocalEnhance;
  vocalEnhanceBtn.classList.toggle('active', state.vocalEnhance);
  vocalEnhanceBtn.textContent = state.vocalEnhance ? '🎚 人声提纯 开' : '🎚 人声提纯 关';
  setStatus(state.vocalEnhance ? '🎚 人声提纯已开启' : '🎚 人声提纯已关闭（提交原始录音）');
});

/* v3.95 省电模式开关（手机默认开） */
const powerSaveBtn = document.getElementById('powerSaveBtn');
function _reflectPowerSave(){
  if (!powerSaveBtn) return;
  powerSaveBtn.classList.toggle('active', _powerSave);
  powerSaveBtn.textContent = _powerSave ? '🔋 省电模式 开' : '🔋 省电模式 关';
}
if (powerSaveBtn) powerSaveBtn.addEventListener('click', () => {
  _powerSave = !_powerSave;
  try{ localStorage.setItem('pb_powersave', _powerSave ? '1' : '0'); }catch(e){}
  _reflectPowerSave();
  setStatus(_powerSave ? '🔋 省电模式已开启（30fps，降温省电）' : '🔋 省电模式已关闭（60fps 满帧）');
});
_reflectPowerSave();

let pinned = true;
const showBtn = document.getElementById('showBtn');
let _showBtnTimer = null;
/* v3.91 全屏沉浸态：呼出「控制台按钮 + 左下角音符按钮」，3 秒无操作自动隐藏
   （重复触发重新计时）。播放器面板打开期间不隐藏音符按钮——用户正在操作；
   面板关闭时其关闭按钮的点击会冒泡到 document 再次 nudge。 */
function nudgeImmersive(){
  if (pinned) return;
  showBtn.classList.add('show');
  playerBtnEl.classList.remove('auto-hide');
  clearTimeout(_showBtnTimer);
  _showBtnTimer = setTimeout(() => {
    showBtn.classList.remove('show');
    if (!playerPanelEl.classList.contains('show')) playerBtnEl.classList.add('auto-hide');
  }, 3000);
}
function reflectPanel(){
  ui.classList.toggle('pinned', pinned);
  if (!pinned){
    setSettings(false);   // 工具栏收起时一并关闭设置
    nudgeImmersive();
  } else {
    clearTimeout(_showBtnTimer);
    showBtn.classList.remove('show');
    playerBtnEl.classList.remove('auto-hide');
  }
}
/* v3.91 「— 缩小」按钮已删除：收起入口统一为「⛶ 全屏」（功能合并） */
showBtn.addEventListener('click', e => { e.stopPropagation(); pinned = true; reflectPanel(); });

/* ============================================================
   v3.90 强制横屏切换：手机没开「自动旋转」也能横屏使用。
   v3.92 双通道：
     ① 系统级真横屏 screen.orientation.lock('landscape')——仅主屏 PWA /
        全屏上下文可用（iOS 主屏 Web App 16.4+ 支持）。真横屏时系统按
        「竖直方向紧凑」规则【自动隐藏状态栏】（时间/电池），所有面板按
        真实横屏坐标渲染，无截断；关闭时 unlock。
     ② 不支持或被拒绝（Safari 标签页 / 旧设备）→ CSS 整体旋转 90°
       （html.rot90 body，见 index.html），坐标经 _rotXY 换算；
       v3.92 已用重映射变量修掉面板错位/X 超出/按钮截断。
   状态存 localStorage，刷新后保持。 */
const rotBtn = document.getElementById('rotBtn');
if (rotBtn){
  let _rotReal = false;   // ① 系统真横屏已生效（此时禁止 CSS 旋转/坐标转换）
  /* 请求系统横屏锁定。部分环境（Electron/受限 WebView）Promise 可能长期挂起：
     给 700ms，未决即判失败走 CSS 方案；若之后晚到成功，再补清理 class。 */
  async function _tryRealLock(){
    if (!(screen.orientation && screen.orientation.lock)) return false;
    let state = null;      // true=已锁 false=被拒
    const pr = screen.orientation.lock('landscape');
    if (pr && pr.then) pr.then(() => { state = true; }, () => { state = false; });
    else if (pr !== undefined) return true;
    const t0 = Date.now();
    while (state === null && Date.now() - t0 < 700){
      await new Promise(r => setTimeout(r, 50));
    }
    if (state === true) return true;
    if (state === null){
      pr.then(() => {
        if ((screen.orientation.type || '').indexOf('landscape') === 0){
          _rotReal = true;
          document.documentElement.classList.remove('rot90');
          rotBtn.classList.add('active');
          resize();
        }
      }).catch(() => {});
    }
    return false;
  }
  const _rotApply = async on => {
    if (on){
      _rotReal = await _tryRealLock();
      document.documentElement.classList.toggle('rot90', !_rotReal);
    } else {
      if (_rotReal){
        try{ screen.orientation.unlock(); }catch(e){}
        _rotReal = false;
      }
      document.documentElement.classList.remove('rot90');
    }
    rotBtn.classList.toggle('active', on);
    rotBtn.innerHTML = on ? '📱 竖屏' : '🔄 横屏';
    rotBtn.title = on ? '恢复竖屏' : '强制横屏（手机未开自动旋转也能横过来用）';
    resize();
    if (on && _rotReal) setTimeout(resize, 350);   // 等系统旋转动画结束再重算
  };
  if (localStorage.getItem('pb_rot90') === '1') _rotApply(true);
  rotBtn.addEventListener('click', () => {
    const on = !(_rotReal || _isRot90());
    try { localStorage.setItem('pb_rot90', on ? '1' : '0'); } catch(e){}
    _rotApply(on);
    setStatus(on ? '🔄 已强制横屏（把手机横过来拿）' : '📱 已恢复竖屏');
  });
}

// v3.91 全屏沉浸态下，点击屏幕任意处重新呼出「控制台按钮 + 音符按钮」（点按钮本身除外）
document.addEventListener('click', e => {
  if (pinned) return;
  if (e.target === showBtn || showBtn.contains(e.target)) return;
  nudgeImmersive();
});

// ============================================================
// v3.44: 左键拖拽歌词区域 → 所有歌词半透明悬浮 → 上下滑动选行 → 松手对齐
// 桌面：鼠标左键；手机：手指（Pointer Events 统一入口，单击无位移=不跳转）
// ============================================================
const dragSeek = {
  active:false, moved:false, lastY:0, scrollY:0, curIdx:0, selIdx:0,
  x0:0, dx:0, curX:0, curY:0, zone:'none'   // v3.53 横向手势：右拖=锁定/编辑 左拖=解除锁定
};

function _lrcIdxAt(sec){
  const arr = state.lyrics.lines;
  let lo = 0, hi = arr.length - 1, idx = 0;
  while (lo <= hi){
    const m = (lo + hi) >> 1;
    if (arr[m].time <= sec){ idx = m; lo = m + 1; } else hi = m - 1;
  }
  return idx;
}

function beginDragSeek(y, x){
  if (!state.lyrics.lines.length) return;
  dragSeek.active = true;
  dragSeek.moved = false;
  dragSeek.lastY = y;
  dragSeek.scrollY = 0;
  dragSeek.x0 = dragSeek.curX = (x != null ? x : 0);
  dragSeek.curY = y;
  dragSeek.dx = 0;
  dragSeek.zone = 'none';
  dragSeek.curIdx = _lrcIdxAt(currentSongSec());
  dragSeek.selIdx = dragSeek.curIdx;
}

/* v3.53 横向手势：右拖出现「🔒 锁定」+「✎ 编辑范围」按钮（压住编辑=打开全屏编辑页），
   右拖过阈值松手=锁定当前歌词；左拖过阈值松手=解除锁定 */
function _dsLockBtnRects(){
  const hs = H / 1080;
  // v3.62：按钮加大（172→230 宽、46→64 高）+ 固定贴右边缘（不再跟随拖拽起点），
  // 右侧拖出时更容易够到，也不会因为起点靠左而挤在中间
  const pw = 230 * hs, ph = 64 * hs;
  // v3.55：触发阈值加大，防止误触
  const LOCK_DX = Math.max(110, 150 * hs);
  const rx = W - 20 * hs - pw;   // 固定贴右
  const cy = H * 0.46;
  return {
    lockDx: LOCK_DX,
    lock: { x: rx, y: cy + 66 * hs, w: pw, h: ph },
    edit: { x: rx, y: cy - 66 * hs - ph, w: pw, h: ph },
  };
}
function updateDragSeek(y, x){
  const arr = state.lyrics.lines;
  const lineH = 58 * (H / 1080);
  dragSeek.curX = (x != null) ? x : dragSeek.curX;
  dragSeek.curY = y;
  dragSeek.dx = dragSeek.curX - dragSeek.x0;
  const R = _dsLockBtnRects();
  let zone = 'none';
  if (dragSeek.dx > 24){
    const b = R.edit;
    zone = (dragSeek.curX >= b.x && dragSeek.curX <= b.x + b.w &&
            dragSeek.curY >= b.y && dragSeek.curY <= b.y + b.h) ? 'edit'
         : (dragSeek.dx > R.lockDx ? 'lock' : 'none');
  } else if (dragSeek.dx < -R.lockDx){
    zone = 'unlock';
  }
  dragSeek.zone = zone;
  dragSeek.scrollY += y - dragSeek.lastY;
  dragSeek.lastY = y;
  if (Math.abs(dragSeek.scrollY) > 7) dragSeek.moved = true;
  // 硬边界：不允许拖过首行/末行
  const min = -(arr.length - 1 - dragSeek.curIdx) * lineH;
  const max =  dragSeek.curIdx * lineH;
  if (dragSeek.scrollY < min) dragSeek.scrollY = min;
  if (dragSeek.scrollY > max) dragSeek.scrollY = max;
  // 下拖(scrollY>0)=往更早的行；上拖=往更晚的行
  let sel = dragSeek.curIdx - Math.round(dragSeek.scrollY / lineH);
  dragSeek.selIdx = Math.max(0, Math.min(arr.length - 1, sel));
}

function commitDragSeek(){
  const ln = state.lyrics.lines[dragSeek.selIdx];
  if (!ln) return;
  const tag = '🎯 拖拽对齐到 ' + fmtTime(ln.time) + '「' +
    (ln.text || '').slice(0, 14) + (ln.text && ln.text.length > 14 ? '…' : '') + '」';
  // v3.72：手动覆盖播放中 → 对齐只对本次播放生效，不写入任何锁定段
  if (typeof _plManual !== 'undefined' && _plManual){
    state.lyrics.userOffsetSec = ln.time -
      (playerAudio.currentTime - _plManual.anchorTime) - _plManual.anchorLyricSec;
    setStatus(tag + '（本次播放临时生效）');
    return;
  }
  // v3.53：锁定歌词生效中 → 以"播放器进度−锁定起点"为基准（精确），对齐结果永久保存进锁定段
  if (typeof _plLockActive !== 'undefined' && _plLockActive){
    const baseSec = playerAudio.currentTime - _plLockActive.start;
    state.lyrics.userOffsetSec = ln.time - baseSec;
    _plLockActive.alignOffsetSec = +state.lyrics.userOffsetSec.toFixed(3);
    _plLocksSave();
    setStatus(tag + '（已保存到锁定歌词，偏移 ' +
      state.lyrics.userOffsetSec.toFixed(1) + 's）');
    return;
  }
  const wallNow = performance.now() / 1000;
  // 当前不含用户偏移的歌曲内进度；偏移量 = 目标行时间 − 当前进度
  const baseSec = state.lyrics.audioOffsetSec + (wallNow - state.lyrics.wallTimeAtLyricSec);
  state.lyrics.userOffsetSec = ln.time - baseSec;
  setStatus(tag + '（偏移 ' + state.lyrics.userOffsetSec.toFixed(1) + 's）');
}

function drawDragSeek(ctx){
  const arr = state.lyrics.lines;
  const hs = H / 1080;
  const lineH = 58 * hs;
  const retY = H * 0.46;
  const pillH = lineH * 1.18;

  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.shadowBlur = 0;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // 压暗底屏（波形仍在底下流动，歌词半透明悬浮其上）
  ctx.fillStyle = 'rgba(3,5,12,0.58)';
  ctx.fillRect(0, 0, W, H);

  // 选中行区域：淡蓝底衬 + 上下两条发丝引导线
  ctx.fillStyle = 'rgba(120,200,255,0.10)';
  ctx.fillRect(0, retY - pillH / 2, W, pillH);
  ctx.fillStyle = 'rgba(120,200,255,0.40)';
  ctx.fillRect(W * 0.10, retY - pillH / 2, W * 0.80, 1.5);
  ctx.fillRect(W * 0.10, retY + pillH / 2 - 1.5, W * 0.80, 1.5);

  // 悬浮歌词：只画屏内可见行，用离屏矢量精灵保持与飞掠歌词同一字形
  for (let i = 0; i < arr.length; i++){
    const y = retY + (i - dragSeek.curIdx) * lineH + dragSeek.scrollY;
    if (y < -60 || y > H + 60) continue;
    const text = (arr[i].text || '').trim() || '· · ·';
    const d = Math.abs(y - retY) / lineH;
    const sel = (i === dragSeek.selIdx);
    let fs, alpha;
    if (sel){
      fs = H * 0.042; alpha = 1;                    // 选中：最大、满亮
    } else {
      fs = Math.max(H * 0.020, H * 0.028 - H * 0.0012 * d);
      alpha = Math.max(0.12, 1 - d / 7);
    }
    const spr = getLyricSprite(text, sel);
    const sc = fs / GLYPH_PX;
    ctx.globalAlpha = alpha;
    const dw = spr.w * sc, dh = spr.h * sc;
    ctx.drawImage(spr.cv, W / 2 - dw / 2, y - dh / 2, dw, dh);
  }

  // 顶部操作提示
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '600 ' + Math.round(15 * hs) + 'px -apple-system,"Microsoft YaHei",sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.80)';
  ctx.fillText('上下拖动对齐 · 右拖锁定歌词 · 左拖解除锁定 · Esc 取消', W / 2, H * 0.13);

  // v3.53 横向手势视觉：右拖滑入「🔒 锁定」+「✎ 编辑范围」，左拖滑入「🔓 解除锁定」
  // v3.81 按钮改画在置顶覆盖层（压过设置/播放器面板），不再被面板盖住
  lockOverlay.style.display = 'block';
  octx.clearRect(0, 0, W, H);
  const pill = (g, x, y, w, h, r) => {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  };
  const R = _dsLockBtnRects();
  const tR = Math.max(0, Math.min(1, (dragSeek.dx - 24) / (R.lockDx - 24)));
  if (tR > 0){
    const slide = (1 - tR) * (R.lock.w + 80 * hs);
    const drawPill = (r, fill, label) => {
      octx.globalAlpha = 0.4 + 0.6 * tR;
      octx.fillStyle = fill;
      pill(octx, r.x - slide, r.y, r.w, r.h, 32 * hs); octx.fill();
      if (fill.indexOf('0.92') >= 0){
        octx.strokeStyle = 'rgba(255,255,255,0.85)'; octx.lineWidth = 1.5; octx.stroke();
      }
      octx.fillStyle = '#fff';
      octx.font = '600 ' + Math.round(19 * hs) + 'px -apple-system,"Microsoft YaHei",sans-serif';
      octx.textAlign = 'center'; octx.textBaseline = 'middle';
      octx.fillText(label, r.x - slide + r.w / 2, r.y + r.h / 2);
      octx.textBaseline = 'alphabetic';
    };
    drawPill(R.edit, dragSeek.zone === 'edit' ? 'rgba(236,72,153,0.92)' : 'rgba(236,72,153,0.38)',
      '✎ 编辑范围');
    drawPill(R.lock, dragSeek.zone === 'lock' ? 'rgba(139,92,246,0.92)' : 'rgba(139,92,246,0.38)',
      '🔒 松手锁定歌词');
  }
  const tL = Math.max(0, Math.min(1, (-dragSeek.dx - 24) / (R.lockDx - 24)));
  if (tL > 0){
    const pw = 180 * hs, ph = 46 * hs;
    const px = 26 - (1 - tL) * (pw + 80 * hs);
    const py = H * 0.46 - ph / 2;
    octx.globalAlpha = 0.4 + 0.6 * tL;
    octx.fillStyle = dragSeek.zone === 'unlock' ? 'rgba(251,113,133,0.92)' : 'rgba(251,113,133,0.38)';
    pill(octx, px, py, pw, ph, 23 * hs); octx.fill();
    octx.fillStyle = '#fff';
    octx.font = '600 ' + Math.round(15 * hs) + 'px -apple-system,"Microsoft YaHei",sans-serif';
    octx.textAlign = 'center'; octx.textBaseline = 'middle';
    octx.fillText('🔓 松手解除锁定', px + pw / 2, py + ph / 2);
    octx.textBaseline = 'alphabetic';
  }
  octx.globalAlpha = 1;

  // 底部：选中行时间 + 行数计数
  const ln = arr[dragSeek.selIdx];
  if (ln){
    ctx.font = '600 ' + Math.round(14 * hs) + 'px Consolas,"Microsoft YaHei",monospace';
    ctx.fillStyle = 'rgba(120,200,255,0.90)';
    ctx.fillText(fmtTime(ln.time) + '　·　' +
      (dragSeek.selIdx + 1) + ' / ' + arr.length + ' 行', W / 2, H * 0.85);
  }
  ctx.restore();
}

canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 || dragSeek.active) return;
  // v3.46d 收起/沉浸态：点按仅用于召唤控制台，不启动歌词拖拽
  if (!pinned) return;
  if (!state.lyrics.lines.length || state.lyrics.hidden) return;
  const p = _rotXY(e);   // v3.90 强制横屏：屏幕坐标→画布坐标
  beginDragSeek(p.clientY, p.clientX);
  try { canvas.setPointerCapture(e.pointerId); } catch(_){}
});
canvas.addEventListener('pointermove', e => {
  if (dragSeek.active){ const p = _rotXY(e); updateDragSeek(p.clientY, p.clientX); }
});
function _endDragSeek(){
  if (!dragSeek.active) return;
  const zone = dragSeek.zone;
  const doCommit = dragSeek.moved && zone === 'none';
  dragSeek.active = false;
  // v3.81 收起手势按钮覆盖层
  lockOverlay.style.display = 'none';
  octx.clearRect(0, 0, W, H);
  // v3.53 横向手势优先于对齐提交
  if (zone === 'edit'){ lvOpen(); return; }
  if (zone === 'lock'){
    if (_plIdx >= 0 && state.lyrics.lines.length){
      const fk = _plKey(_plItems[_plIdx]);
      if (!_plLocks[fk]) _plLocks[fk] = { segments: [] };
      const seg = _plMakeSegmentFromCurrent();
      if (seg){
        _plLocks[fk].segments.push(seg);
        _plResolveOverlaps(_plLocks[fk]);   // v3.74：叠加自动截断
        _plLocksSave();
        _plLockActive = seg;
        _plSuppressSync(true);
        setStatus('🔒 已锁定歌词：' + (seg.title || '当前歌词') +
          '（上下拖仍可对齐并永久保存 · 再拖到「✎ 编辑」可调范围）');
      }
    }
    return;
  }
  if (zone === 'unlock'){ _plUnlockCurrentLyrics(); return; }
  if (doCommit) commitDragSeek();
}
canvas.addEventListener('pointerup', _endDragSeek);
canvas.addEventListener('pointercancel', _endDragSeek);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && dragSeek.active){
    dragSeek.active = false;
    lockOverlay.style.display = 'none';   // v3.81 收起手势按钮覆盖层
    octx.clearRect(0, 0, W, H);
  }
});

// 自动隐藏提示
setTimeout(() => hint && hint.classList.add('hide'), 4000);
canvas.addEventListener('click', () => hint && hint.classList.add('hide'));

// 页面标题 + 初始状态文字(带版本号)
document.title = '炫彩DJ · ' + VERSION;   // v3.87 更名（iOS 添加主屏的名称取自 title）
setStatus('炫彩DJ · ' + VERSION + ' · 星空 + 自动配色 + 歌词自动跟随');
