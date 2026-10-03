/* ============================================================
   幻彩律动 · PHANTOM BEATS  v3.16
   - 单形态：镜像波形 · 三频律动
   - 低音/中音/高音 = 平滑镜像波带
   - 配色自动：音量越大越暖，纯度越高越冷
   - 背景：银河系穿行星空(向前飞，速度随 BPM)
   - 三频 (bass / mid / treble) 独立律动
   - 歌词：深空飞掠（3D 透视，从远处朝用户飞来、掠过下方出屏）
   - 任意音源：系统音频 (WASAPI loopback) / 本地文件 / 麦克风 / 演示
   ============================================================ */

const FFT_BINS = 64;
const VERSION = 'v3.46';

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
  sysFrame: null,
  wsConnected: false,
  spec: new Float32Array(FFT_BINS),
  bass: 0, mid: 0, treble: 0, level: 0,
  gate: 0,               // 0..1 自适应噪声门限：无音乐时压回 0、波形归零；有音乐时恢复 1
  purity: 0,             // 0..1，高 = 音色纯净(高音占比大)
  bpm: 0,                // 估算节拍(BPM)，驱动星空飞行速度
  lastBeatTime: 0,       // 上次节拍时间戳(s)
  demoT: 0,
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
  const wallNow = performance.now() / 1000;
  return state.lyrics.audioOffsetSec + (wallNow - state.lyrics.wallTimeAtLyricSec) + state.lyrics.userOffsetSec;
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
  for (let i = 0; i < STARS.length; i++){
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
  for (let i = 0; i < BG_STARS.length; i++){
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
function resize(){
  DPR = window.devicePixelRatio || 1;
  W = window.innerWidth; H = window.innerHeight;
  canvas.width  = W * DPR;
  canvas.height = H * DPR;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  initStars();
}
window.addEventListener('resize', resize);
// v3.41 移动端：旋转屏后等系统布局稳定再重算
window.addEventListener('orientationchange', () => setTimeout(resize, 200));
resize();

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
  if (state.source === 'demo'){
    state.demoT += 1/60;
    spec = new Float32Array(FFT_BINS);
    const beat = Math.max(0, Math.sin(state.demoT * Math.PI * 2 * 2)); // ~120 BPM 节拍
    for (let i = 0; i < FFT_BINS; i++){
      const a = i / FFT_BINS * 10;
      const s = (Math.sin(state.demoT*2.0 + a)*0.5 + 0.5);
      let v = s * (1 - i/FFT_BINS*0.4);
      if (i < 8) v = v * (0.3 + beat * 1.5);   // 低音带受节拍驱动，便于演示 BPM 跟随
      spec[i] = v * (0.5 + 0.5 * Math.abs(Math.sin(state.demoT*0.5)));
    }
  } else if (state.sysFrame){
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
function loop(ts){
  const dt = Math.min(0.05, (ts - lastTs)/1000);
  lastTs = ts;
  t += dt;

  // 左上角：当前播放歌名（仅变化时更新）
  const _np = state.lyrics.title || '';
  if (_np !== _lastNpTitle){
    _lastNpTitle = _np;
    if (npTitleEl) npTitleEl.textContent = _np;
    if (nowPlaying) nowPlaying.classList.toggle('show', !!_np);
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
  const aspect = (W > 0 && H > 0) ? W / H : (16 / 9);
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
let fileBufferSrc = null;
let micStream = null;

/* v3.46 云端识别：15 秒 PCM 环形录音（ScriptProcessor 全平台兼容，含 iOS） */
let _micProc = null;
let _micMute = null;
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
  return encodeWavI16(out, _micRingSR);
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
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.6;
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function startFileMode(file){
  ensureAudioCtx();
  if (fileBufferSrc) try { fileBufferSrc.stop(); } catch(e){}
  if (sourceNode) try { sourceNode.disconnect(); } catch(e){}
  const fr = new FileReader();
  fr.onload = () => {
    audioCtx.decodeAudioData(fr.result, buf => {
      fileBufferSrc = audioCtx.createBufferSource();
      fileBufferSrc.buffer = buf;
      fileBufferSrc.loop = true;
      fileBufferSrc.connect(analyser);
      analyser.connect(audioCtx.destination);
      fileBufferSrc.start();
    });
  };
  fr.readAsArrayBuffer(file);
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
  const stream = await navigator.mediaDevices.getUserMedia(
    { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  micStream = stream;
  sourceNode = audioCtx.createMediaStreamSource(stream);
  sourceNode.connect(analyser);
  // 环形录音：采样率随 AudioContext（手机常为48k，ACR 支持）
  _micRingSR = audioCtx.sampleRate || 44100;
  _micRingCap = Math.floor(_micRingSR * 15.5);
  _micRingChunks = []; _micRingSamples = 0;
  try {
    _micProc = audioCtx.createScriptProcessor(4096, 1, 1);
    _micProc.onaudioprocess = ev => {
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
    // v3.46 手机端：ScriptProcessor 必须汇入 destination 才会触发回调，
    // 经 gain=0 静音节点，保证处理运行且完全无声（不啸叫）
    _micMute = audioCtx.createGain();
    _micMute.gain.value = 0;
    _micProc.connect(_micMute);
    _micMute.connect(audioCtx.destination);
  } catch(e){ _micProc = null; }
  return stream;
}

function stopAudio(){
  try { if (fileBufferSrc) fileBufferSrc.stop(); } catch(e){}
  try { if (micStream) micStream.getTracks().forEach(t => t.stop()); } catch(e){}
  try { if (_micProc) _micProc.disconnect(); } catch(e){}
  try { if (_micMute) _micMute.disconnect(); } catch(e){}
  fileBufferSrc = null; micStream = null;
  _micProc = null; _micMute = null; _micRingChunks = []; _micRingSamples = 0;
}

function pullFrame(){
  if (analyser && (state.source === 'file' || state.source === 'mic')){
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const spec = new Float32Array(FFT_BINS);
    for (let i = 0; i < FFT_BINS; i++){
      spec[i] = (data[i] || 0) / 255;
    }
    state.sysFrame = spec;
  }
  requestAnimationFrame(pullFrame);
}
requestAnimationFrame(pullFrame);

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
          if (arr && arr.length){
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
          setRecogIdle();
          state.lyrics.lines = parseLRC(j.lrc || '');
          state.lyrics.title = j.title || '';
          state.lyrics.artist = j.artist || '';
          state.lyrics.source = j.source || '';
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
              // 屏幕中央大字提示
              if (window._lyricsEmptyTip) window._lyricsEmptyTip.remove();
              const tip = document.createElement('div');
              tip.style.cssText = [
                'position:fixed','left:50%','top:50%','transform:translate(-50%,-50%)',
                'background:rgba(0,0,0,0.88)','border:1px solid rgba(120,200,255,0.4)',
                'border-radius:14px','padding:22px 36px','text-align:center','max-width:420px',
                'font-size:15px','color:#cce','line-height:1.8','z-index:9999',
                'box-shadow:0 0 30px rgba(0,150,255,0.15)'
              ].join(';');
              tip.innerHTML = [
                '<div style="font-size:20px;margin-bottom:10px">🎵 ' + escapeHtml(j.title || '') + '</div>',
                '<div style="opacity:.6;margin-bottom:14px">' + escapeHtml(j.artist || '') + '</div>',
                '<div style="color:#f88;border-top:1px solid rgba(255,255,255,0.1);padding-top:12px;margin-top:4px">',
                '❌ 两家歌词库都没有这首歌<br>（网易云 + LRCLib 均无收录）',
                '</div>',
                '<div style="margin-top:10px;font-size:13px;opacity:.7">',
                '试试：🔍 用更准确的歌名再搜<br>或直接输入一句歌词搜索',
                '</div>'
              ].join('');
              document.body.appendChild(tip);
              window._lyricsEmptyTip = tip;
              setTimeout(() => { if (window._lyricsEmptyTip) { window._lyricsEmptyTip.remove(); window._lyricsEmptyTip = null; } }, 12000);
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
 * v3.46 云端 API：手机麦克风 WAV → Worker 识别 / 搜索
 * ============================================================ */
async function cloudRecognize(isAuto){
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
    if (!isAuto) setStatus('⏳ 已录 ' + (_micRingSamples / _micRingSR).toFixed(0) +
      ' 秒，还需 12 秒，请让音乐继续播放后再点');
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
  return handleCloudResult(r, null);
}

function handleCloudResult(r, t0){
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

// 音源
document.querySelectorAll('#sourceSeg .seg-btn').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('#sourceSeg .seg-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const src = b.dataset.source;
    state.source = src;
    if (src === 'system'){
      stopAudio();
      connectWS();
      setStatus('● 监听系统音频...');
    } else if (src === 'mic'){
      stopAudio();
      if (ws) ws.close();
      startMicMode();
      setStatus('● 麦克风已开启');
    } else if (src === 'file'){
      stopAudio();
      if (ws) ws.close();
      document.getElementById('fileInput').click();
    } else if (src === 'demo'){
      stopAudio();
      if (ws) ws.close();
      state.demoT = 0;
      setStatus('● 演示模式');
    }
  };
});

// v3.46 云端模式：系统音频/本地文件依赖本机服务端，云端隐藏；默认麦克风
if (CLOUD_MODE){
  document.querySelectorAll('#sourceSeg .seg-btn').forEach(x => {
    if (x.dataset.source === 'system' || x.dataset.source === 'file'){
      x.style.display = 'none';
    }
    if (x.dataset.source === 'mic') x.classList.add('active');
  });
}

// 文件选择
document.getElementById('fileInput').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  state.source = 'file';
  startFileMode(f);
  setStatus('● 正在播放: ' + f.name);
});

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
      recogLabelEl.textContent = el >= RECOG_EXPECT_SEC
        ? '🎵 识别中…' : '🎵 识别中 ' + left + 's';
    }
    if (autoLockChip) autoLockChip.classList.remove('show');
  } else if (mode === 'waiting'){
    // v3.38：等待期按钮不再填充绿色，只保留左上角读秒胶囊
    if (recogFillEl) recogFillEl.style.width = '0%';
    if (recogLabelEl) recogLabelEl.textContent = '🎵 识别歌曲';
    if (autoLockChipText)
      autoLockChipText.textContent = '自动识别 ' + Math.ceil(remain) + 's';
    if (autoLockChip) autoLockChip.classList.add('show');
  } else {
    if (recogFillEl) recogFillEl.style.width = '0%';
    if (recogLabelEl) recogLabelEl.textContent = '🎵 识别歌曲';
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
  if (window.matchMedia('(max-width:820px)').matches){
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

// 下拉框：列出全部候选版本（序号. 来源 时长 [推荐]），当前版本选中
function renderVersionSelect(){
  if (!versionSelect) return;
  versionSelect.innerHTML = '';
  _match.cands.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = String(c.cid);
    o.textContent = (i + 1) + '. ' + matchSrcName(c.source) +
      (c.duration ? ' ' + fmtMatchDur(c.duration) : '') +
      (c.recommended ? ' 推荐' : '');
    if (String(c.cid) === String(_match.selCid)) o.selected = true;
    versionSelect.appendChild(o);
  });
  versionSelect.style.display = _match.cands.length ? '' : 'none';
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
    pickVersion(c.cid);
    setStatus('🎯 已切到第 ' + (idx + 1) + ' 版（' + matchSrcName(c.source) +
      '），按当前播放位置精确对齐');
  });
}
// 下拉框自行选择
if (versionSelect){
  versionSelect.addEventListener('change', () => pickVersion(versionSelect.value));
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

// 全屏 / 固定面板
document.getElementById('fsBtn').addEventListener('click', async () => {
  /* v3.42: iPhone/iPad Safari【完全不支持】DOM Fullscreen API（只有 video 元素例外），
     点按钮永远无法全屏。iOS 唯一全屏路径 = 添加到主屏幕 + 从桌面图标启动
     （配合 head 里 apple-mobile-web-app-capable 声明） */
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (/Macintosh|MacIntel/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1); // iPadOS 桌面 UA
  if (isIOS){
    if (navigator.standalone === true){
      setStatus('✅ 当前已是从桌面图标启动的全屏模式，无需再点全屏');
    } else {
      setStatus('📱 iPhone 全屏：① 点 Safari 底部「分享」图标 → ②「添加到主屏幕」→ ③ 先关掉本页，再【点桌面新图标启动】（在 Safari 里打开不会全屏）');
    }
    return;
  }
  try{
    if (!document.fullscreenElement){
      if (!document.documentElement.requestFullscreen){
        setStatus('⚠️ 当前浏览器不支持全屏');
        return;
      }
      await document.documentElement.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  }catch(e){
    setStatus('⚠️ 全屏失败: ' + (e && e.name ? e.name : e));
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
}
if (settingsBtn) settingsBtn.addEventListener('click', () =>
  setSettings(!settingsPanel.classList.contains('show')));
if (settingsClose) settingsClose.addEventListener('click', () => setSettings(false));

let pinned = true;
const pinBtn = document.getElementById('pinBtn');
const hideBtn = document.getElementById('hideBtn');
const showBtn = document.getElementById('showBtn');
function reflectPanel(){
  ui.classList.toggle('pinned', pinned);
  pinBtn.textContent = pinned ? '📌 固定面板' : '📍 浮动面板';
  showBtn.classList.toggle('show', !pinned);
  if (!pinned) setSettings(false);   // 工具栏收起时一并关闭设置
}
pinBtn.addEventListener('click', () => { pinned = !pinned; reflectPanel(); });
hideBtn.addEventListener('click', () => { pinned = false; reflectPanel(); });
showBtn.addEventListener('click', () => { pinned = true; reflectPanel(); });

// ============================================================
// v3.44: 左键拖拽歌词区域 → 所有歌词半透明悬浮 → 上下滑动选行 → 松手对齐
// 桌面：鼠标左键；手机：手指（Pointer Events 统一入口，单击无位移=不跳转）
// ============================================================
const dragSeek = {
  active:false, moved:false, lastY:0, scrollY:0, curIdx:0, selIdx:0
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

function beginDragSeek(y){
  if (!state.lyrics.lines.length) return;
  dragSeek.active = true;
  dragSeek.moved = false;
  dragSeek.lastY = y;
  dragSeek.scrollY = 0;
  dragSeek.curIdx = _lrcIdxAt(currentSongSec());
  dragSeek.selIdx = dragSeek.curIdx;
}

function updateDragSeek(y){
  const arr = state.lyrics.lines;
  const lineH = 58 * (H / 1080);
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
  const wallNow = performance.now() / 1000;
  // 当前不含用户偏移的歌曲内进度；偏移量 = 目标行时间 − 当前进度
  const baseSec = state.lyrics.audioOffsetSec + (wallNow - state.lyrics.wallTimeAtLyricSec);
  state.lyrics.userOffsetSec = ln.time - baseSec;
  setStatus('🎯 拖拽对齐到 ' + fmtTime(ln.time) + '「' +
    (ln.text || '').slice(0, 14) + (ln.text && ln.text.length > 14 ? '…' : '') +
    '」（偏移 ' + state.lyrics.userOffsetSec.toFixed(1) + 's）');
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
  ctx.fillText('上下拖动选择歌词 · 松开从此处播放 · Esc 取消', W / 2, H * 0.13);

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
  if (!state.lyrics.lines.length || state.lyrics.hidden) return;
  beginDragSeek(e.clientY);
  try { canvas.setPointerCapture(e.pointerId); } catch(_){}
});
canvas.addEventListener('pointermove', e => {
  if (dragSeek.active) updateDragSeek(e.clientY);
});
function _endDragSeek(){
  if (!dragSeek.active) return;
  const doCommit = dragSeek.moved;
  dragSeek.active = false;
  if (doCommit) commitDragSeek();
}
canvas.addEventListener('pointerup', _endDragSeek);
canvas.addEventListener('pointercancel', _endDragSeek);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && dragSeek.active) dragSeek.active = false;
});

// 自动隐藏提示
setTimeout(() => hint && hint.classList.add('hide'), 4000);
canvas.addEventListener('click', () => hint && hint.classList.add('hide'));

// 页面标题 + 初始状态文字(带版本号)
document.title = '幻彩律动 · PHANTOM BEATS · ' + VERSION;
setStatus('幻彩律动 · ' + VERSION + ' · 星空 + 自动配色 + 歌词自动跟随');
