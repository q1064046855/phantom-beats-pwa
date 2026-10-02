/* ============================================================
   幻彩律动 · PHANTOM BEATS  v3.9
   - 单形态：镜像波形 · 三频律动
   - 低音/中音/高音 = 平滑镜像波带
   - 配色自动：音量越大越暖，纯度越高越冷
   - 背景：银河系穿行星空(向前飞，速度随 BPM)
   - 三频 (bass / mid / treble) 独立律动
   - 任意音源：系统音频 (WASAPI loopback) / 本地文件 / 麦克风 / 演示
   ============================================================ */

const FFT_BINS = 64;
const VERSION = 'v3.9';

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
  purity: 0,             // 0..1，高 = 音色纯净(高音占比大)
  bpm: 0,                // 估算节拍(BPM)，驱动星空飞行速度
  lastBeatTime: 0,       // 上次节拍时间戳(s)
  demoT: 0,
  gate: 1,              // 静音门限：0=三线压回中线(闭合)，1=正常
  _nf: 0,               // 噪声地板(缓慢跟踪最安静时的能量)
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
function drawBgStars(now){
  ctx.globalCompositeOperation = 'source-over';
  // 极缓慢的镜头偏移(左/上/下小幅游走) → 像往前飞行时的相机晃动，幅度很小
  const panX = Math.sin(now * 0.2) * W * 0.012;
  const panY = Math.cos(now * 0.14) * H * 0.015;
  for (let i = 0; i < BG_STARS.length; i++){
    const s = BG_STARS[i];
    const x = s.nx * W + panX * s.depth;
    const y = s.ny * H + panY * s.depth;
    const a = s.tw * (0.45 + 0.55 * Math.sin(now * s.twSpeed + s.phase)) * 0.8;
    ctx.fillStyle = hsla(s.hue, s.warm ? 70 : 35, 92, a);
    ctx.beginPath();
    ctx.arc(x, y, s.size, 0, Math.PI * 2);
    ctx.fill();
    if (s.size > 1.1){
      ctx.fillStyle = hsla(s.hue, s.warm ? 60 : 45, 80, a * 0.14);
      ctx.beginPath();
      ctx.arc(x, y, s.size * 3.0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
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
resize();

/* ============================================================
   形态渲染器：镜像波形 · 三频律动 (第一版还原 + 星空/自动配色)
   低音 / 中音 / 高音 均为平滑镜像波带
   ============================================================ */
function drawMirror(){
  const cy = H * 0.5;
  // 低音 → 平滑镜像波带
  const arrBass = subMirrorSpec(state.spec, 0, state.spec.length*0.12);
  mirrorStrokeWave(arrBass, cy, H * 0.34, true, 0, 60, state.lw * 1.7, state.glow, state.gate);
  // 中音 → 平滑镜像
  const arrMid = subMirrorSpec(state.spec, state.spec.length*0.12, state.spec.length*0.45);
  mirrorStrokeWave(arrMid, cy, H * 0.22, true, 90, 90, state.lw * 1.3, state.glow, state.gate);
  // 高音 → 平滑镜像
  const arrHi  = subMirrorSpec(state.spec, state.spec.length*0.45, state.spec.length);
  mirrorStrokeWave(arrHi, cy, H * 0.14, true, 200, 130, state.lw, state.glow, state.gate);
}

function subMirrorSpec(s, a, b){
  a = Math.floor(a); b = Math.floor(b);
  const out = new Float32Array(Math.max(1, b - a));
  for (let i = 0; i < out.length; i++) out[i] = s[a + i] || 0;
  return out;
}

function mirrorStrokeWave(arr, cy, amp, mirror, hOff, hSpan, lw, glow, gate){
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
      const y = cy + dir * arr[i] * amp * (gate === undefined ? 1 : gate);
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
  // 音色纯度 = 高音占比 (treble 越突出 → 音色越纯净)
  const total = state.bass + state.mid + state.treble + 0.0001;
  state.purity = Math.min(1, (state.treble / total) * 2.0);

  // --- 静音门限：自适应噪声地板，无音乐时把三线压回中线(闭合) ---
  if (state._nf === 0) state._nf = state.level;
  state._nf = state._nf * 0.995 + state.level * 0.005;   // 缓慢跟随最安静时的能量
  const over = state.level - state._nf;                  // 高出噪声地板的部分
  const targetGate = over > 0.006 ? 1 : 0;
  state.gate += (targetGate - state.gate) * (targetGate > state.gate ? 0.35 : 0.04);

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

function loop(ts){
  const dt = Math.min(0.05, (ts - lastTs)/1000);
  lastTs = ts;
  t += dt;

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

  // 主形态
  drawMirror();

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* ============================================================
   音频：系统 (WS) / 文件 (Web Audio) / 麦克风
   ============================================================ */
let audioCtx = null;
let analyser = null;
let sourceNode = null;
let fileBufferSrc = null;
let micStream = null;

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
  ensureAudioCtx();
  navigator.mediaDevices.getUserMedia({ audio:true }).then(stream => {
    micStream = stream;
    sourceNode = audioCtx.createMediaStreamSource(stream);
    sourceNode.connect(analyser);
  });
}

function stopAudio(){
  try { if (fileBufferSrc) fileBufferSrc.stop(); } catch(e){}
  try { if (micStream) micStream.getTracks().forEach(t => t.stop()); } catch(e){}
  fileBufferSrc = null; micStream = null;
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

/* ---------- WS：系统音频 (QQ 音乐等) ---------- */
let ws = null;
function connectWS(){
  if (ws) try{ ws.close(); }catch(e){}
  try{
    ws = new WebSocket('ws://localhost:8001');
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { state.wsConnected = true; setStatus('● 系统音频已连接 (WASAPI loopback)'); };
    ws.onclose = () => { state.wsConnected = false; setTimeout(connectWS, 1500); };
    ws.onerror = () => { /* reconnect via close */ };
    ws.onmessage = e => {
      if (typeof e.data === 'string'){
        try{
          const j = JSON.parse(e.data);
          if (j.type === 'frame' || j.type === 'level'){
            const arr = j.spectrum || j.spec || j.frame;
            if (arr && arr.length){
              const spec = new Float32Array(FFT_BINS);
              for (let i = 0; i < FFT_BINS && i < arr.length; i++) spec[i] = arr[i];
              state.sysFrame = spec;
            }
          }
        }catch(_){}
      }
    };
  }catch(e){
    setTimeout(connectWS, 2000);
  }
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

// 启动：默认 system
connectWS();

// 全屏 / 固定面板
document.getElementById('fsBtn').addEventListener('click', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
});
let pinned = true;
const pinBtn = document.getElementById('pinBtn');
const hideBtn = document.getElementById('hideBtn');
const showBtn = document.getElementById('showBtn');
function reflectPanel(){
  ui.classList.toggle('pinned', pinned);
  pinBtn.textContent = pinned ? '📌 固定面板' : '📍 浮动面板';
  showBtn.classList.toggle('show', !pinned);
}
pinBtn.addEventListener('click', () => { pinned = !pinned; reflectPanel(); });
hideBtn.addEventListener('click', () => { pinned = false; reflectPanel(); });
showBtn.addEventListener('click', () => { pinned = true; reflectPanel(); });
// 手机上默认隐藏控制台，保证全屏沉浸；点「⚙ 控制面板」再展开
if (window.__PB_MOBILE) { pinned = false; reflectPanel(); }

// 自动隐藏提示
setTimeout(() => hint && hint.classList.add('hide'), 4000);
canvas.addEventListener('click', () => hint && hint.classList.add('hide'));

// 页面标题 + 初始状态文字(带版本号)
document.title = '幻彩律动 · PHANTOM BEATS · ' + VERSION;
setStatus('幻彩律动 · ' + VERSION + ' · 星空穿行 + 自动配色 + 平滑低音');
