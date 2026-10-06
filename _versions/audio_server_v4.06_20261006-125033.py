#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
幻彩律动 · 音频引擎 (audio_server.py)
------------------------------------------------------------
- 通过 WASAPI 回环(Loopback) 捕获“扬声器正在播放”的系统音频
  （QQ音乐 / 网易云 / 浏览器 / 游戏 …… 任意软件的声音）
- 实时 FFT -> 64 段频谱 + 低/中/高频能量，通过 WebSocket 推送给前端
- 脚本模式同时提供静态文件服务(index.html / app.js)；打包后的 exe 仅推 WebSocket

依赖: pip install sounddevice websockets numpy
运行: python audio_server.py            (默认 http://localhost:8000, ws://localhost:8001)
      python audio_server.py --list     (列出音频设备)
      python audio_server.py --device 名 (指定回环设备, 默认=默认输出设备)
"""
import asyncio
import base64
import io
import json
import os
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
import urllib.parse
import urllib.request
import webbrowser
import argparse
import traceback
import socket
import time
import uuid
import wave

# --------------------------------------------------------------------------
# 全局异常兜底：禁止弹出 Windows "未处理脚本异常" 对话框，全部写日志
# --------------------------------------------------------------------------
_IS_FROZEN = getattr(sys, "frozen", False)
_LOG_DIR = os.path.dirname(
    os.path.abspath(sys.executable) if _IS_FROZEN else __file__
)
LOG_PATH = os.path.join(_LOG_DIR, "audio_server.log")


def _log(msg: str) -> None:
    """追加一行到日志文件（utf-8），失败静默。"""
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write("[{0}] {1}\n".format(
                time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


def _excepthook(et, ev, tb) -> None:
    """捕获未处理异常 → 写日志 → 立刻退出，不触发系统对话框。"""
    try:
        _log("[未捕获异常] {0}: {1}\n{2}".format(
            et.__name__, ev, "".join(traceback.format_tb(tb))))
    finally:
        os._exit(1)


def _thread_excepthook(args) -> None:
    """子线程里的未处理异常也走日志。"""
    _log("[线程未捕获异常] {0}: {1}\n{2}".format(
        args.exc_type.__name__, args.exc_value,
        "".join(traceback.format_tb(args.exc_traceback))))
    os._exit(1)


sys.excepthook = _excepthook
try:
    import threading as _t
    _t.excepthook = _thread_excepthook  # py3.8+
except Exception:
    pass
try:
    import faulthandler
    faulthandler.disable()  # 关闭 faulthandler 自带的崩溃对话框
except Exception:
    pass

import numpy as np

try:
    import sounddevice as sd
    from sounddevice import WasapiSettings
except Exception as e:                                   # pragma: no cover
    print("[错误] 无法加载 sounddevice:", e)
    print("请先安装: pip install sounddevice")
    _log("[启动失败] 缺 sounddevice: {0}".format(e))
    sys.exit(1)

try:
    import websockets
except Exception as e:                                    # pragma: no cover
    print("[错误] 无法加载 websockets:", e)
    print("请先安装: pip install websockets")
    _log("[启动失败] 缺 websockets: {0}".format(e))
    sys.exit(1)

N = 64                      # 频谱分箱
SR_TARGET = 44100
CAPTURE_SR = SR_TARGET    # 实际回环采集采样率（随设备原生率变化）
BLOCK = 1024
HOST = "0.0.0.0"
PORT = 8000
WS_PORT = 8001

HERE = os.path.dirname(os.path.abspath(__file__))

# AudD.io 音频指纹识别（环境变量 AUDD_API_TOKEN 配置，留空=仅手动搜歌名）
AUDD_API_TOKEN = os.environ.get("AUDD_API_TOKEN", "").strip()

# ACRCloud 音频指纹识别（中文识别最强，14 天试用后 $99/月）
# 环境变量：ACR_HOST / ACR_ACCESS_KEY / ACR_ACCESS_SECRET；若未设则用默认常量。
ACR_HOST         = os.environ.get("ACR_HOST", "identify-cn-north-1.acrcloud.cn").strip()
ACR_ACCESS_KEY   = os.environ.get("ACR_ACCESS_KEY", "d895d64e3f767df33cf9657ac38e0e4a").strip()
ACR_ACCESS_SECRET= os.environ.get("ACR_ACCESS_SECRET", "mw49HjI4FIx7WmAAhW1TPtrid6bqjrV22ThhP7rK").strip()

# --------------------------------------------------------------------------
# v4.06 局域网 API（替代欠费停用的腾讯云 SCF）：
#   POST /api/recognize   body={"audio": base64(WAV 16bit 单声道 ~15s)}
#   POST /api/search      body={"q": "歌名 歌手 或 一句歌词"}
# 返回格式与 tencent_worker.js（SCF）的 handleRecognize/handleSearch 完全一致，
# 前端 handleCloudResult 无需改动直接兼容。识别/搜索期间并发取歌词源用线程池。
# --------------------------------------------------------------------------
_HTTP_POOL = ThreadPoolExecutor(max_workers=4)
API_RECOGNIZE_MAX_BODY = 8 * 1024 * 1024   # base64 WAV 上限（15s≈1.3MB→b64≈1.8MB）

# 全局最新帧 + 锁
latest = {"spectrum": [0.0] * N, "bass": 0.0, "mid": 0.0, "treble": 0.0, "level": 0.0}
lock = threading.Lock()
audio_status = "init"      # init | loopback | mic | error
status_msg = ""

# -----------------------------------------------------------------
# 滚动音频缓冲 + 累计采样计数（用于 AudD 指纹 + 歌词同步时间轴）
# -----------------------------------------------------------------
AUDIO_BUFFER_SECONDS = 18.0     # 保留最近 N 秒音频供识别抓取（录音15s + 余量）
RECORD_SECONDS = 15.0           # 每次识别截取时长：更长样本 → 识别更准、时间点更精确
_audio_buf_lock = threading.Lock()
_audio_buffer = []              # list[float] 单声道 -1..1
_audio_total_samples = 0        # 累计采样数（所有 callback 之和）


# --------------------------------------------------------------------------
# 端口预检
# --------------------------------------------------------------------------
def port_free(host: str, port: int) -> bool:
    """尝试绑定一次，成功说明端口空闲。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((host, port))
        return True
    except OSError as e:
        _log("[端口冲突] {0}:{1} 已被占用 ({2})".format(host, port, e))
        return False
    finally:
        try:
            s.close()
        except Exception:
            pass


# --------------------------------------------------------------------------
# 音频处理
# --------------------------------------------------------------------------
class Analyser:
    def __init__(self):
        self.run_max = 1e-3

    def process(self, mono: np.ndarray) -> dict:
        n = len(mono)
        if n < 2:
            return {"spectrum": [0.0] * N, "bass": 0.0, "mid": 0.0, "treble": 0.0, "level": 0.0}
        window = np.hanning(n)
        spec = np.abs(np.fft.rfft(mono * window))
        bins = spec.shape[0]
        out = np.zeros(N)
        for i in range(N):
            f0 = int((i / N) ** 2 * bins)
            f1 = max(f0 + 1, int(((i + 1) / N) ** 2 * bins))
            seg = spec[f0:f1]
            out[i] = seg.mean() if seg.size else 0.0
        # 自适应增益 + gamma
        self.run_max = max(self.run_max * 0.995, out.max(), 1e-4)
        norm = np.clip((out / self.run_max) ** 0.6, 0.0, 1.0)
        # 高频能量较弱 -> 施加感知倾斜, 让中/高音线条更活跃
        tilt = 1.0 + (np.arange(N) / N) * 1.3
        norm = np.clip(norm * tilt, 0.0, 1.0)

        bE, mE = int(N * 0.12), int(N * 0.45)
        bass = float(norm[:bE].mean())
        mid = float(norm[bE:mE].mean())
        treble = float(norm[mE:].mean())
        level = float(np.sqrt(np.mean(mono ** 2)))
        return {
            "spectrum": norm.tolist(),
            "bass": bass, "mid": mid, "treble": treble,
            "level": min(1.0, level * 6.0),
        }


analyser = Analyser()


def audio_callback(indata, frames, time_info, status):
    global latest, audio_status, _audio_total_samples
    if status:
        pass  # 忽略 priming/underrun 等中间状态
    try:
        mono = indata.mean(axis=1) if indata.ndim > 1 else indata
        # 保持滚动缓冲
        with _audio_buf_lock:
            _audio_buffer.extend(mono.tolist())
            max_len = int(AUDIO_BUFFER_SECONDS * CAPTURE_SR)
            if len(_audio_buffer) > max_len:
                del _audio_buffer[:len(_audio_buffer) - max_len]
            _audio_total_samples += frames
        frame = analyser.process(np.asarray(mono, dtype=np.float32))
        with lock:
            latest = frame
    except Exception:
        pass


def audio_time_seconds() -> float:
    """累计播放时长(秒) - 从启动或上一次重置算起，可作歌词歌曲时间标签。】
    """
    with _audio_buf_lock:
        return _audio_total_samples / CAPTURE_SR


def audio_buffer_to_wav(seconds: float = 10.0) -> bytes:
    """从滚动缓冲中截取最后 N 秒音频 → WAV (16-bit mono 单声道)。
    """
    target = max(2, int(seconds * CAPTURE_SR))
    with _audio_buf_lock:
        samples = _audio_buffer[-target:]
    # float32 → int16，带自动增益控制（削波保护）：
    # 若峰值 >= 0.95 则缩放到 0.70，消除硬削波失真，保护 ACR 指纹特征
    if not samples:
        return b""
    arr = np.asarray(samples, dtype=np.float32)
    pk = float(np.max(np.abs(arr))) if arr.size else 0.0
    if pk >= 0.95:
        arr = np.clip(arr * (0.70 / pk), -1.0, 1.0)
    else:
        arr = np.clip(arr, -1.0, 1.0)
    arr = (arr * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(CAPTURE_SR)
        w.writeframes(arr.tobytes())
    return buf.getvalue()


# 后端质量优先级：WASAPI(2) > WDM-KS(3) > DirectSound(1) > MME(0)
# WASAPI/WDM-KS 录的回环音质干净，MME 一路会被重采样劣化，AudD 匹配不上
_HOSTAPI_PRIORITY = {2: 0, 3: 1, 1: 2, 0: 3}


def _find_loopback_inputs():
    """查找系统自带回环设备：'立体声混音' / 'Stereo Mix' / 'What U Hear' / 'Wave Out Mix' / 'Loopback'。
    这条路不需要 WasapiSettings.as_loopback，在 sounddevice 任意版本上都能用。
    返回按音质排序的候选列表 [(device_index, channels, native_sr), ...]。
    """
    keywords = [
        "立体声混音", "stereo mix", "wave out mix", "what u hear",
        "what you hear", "loopback", "summation",
    ]
    cands = []
    try:
        for i, d in enumerate(sd.query_devices()):
            if d.get("max_input_channels", 0) <= 0:
                continue
            name = (d.get("name") or "").lower()
            if any(kw in name for kw in keywords):
                hapi = d.get("hostapi", 0)
                prio = _HOSTAPI_PRIORITY.get(hapi, 9)
                cands.append((prio, i, d["max_input_channels"], d.get("default_samplerate", SR_TARGET)))
    except Exception:
        pass
    cands.sort(key=lambda x: x[0])
    return [(i, ch, sr) for _, i, ch, sr in cands]


def start_audio(device=None):
    """启动音频输入：优先级 立体声混音(WASAPI/WDM-KS 优先) → 默认麦克风。"""
    global audio_status, status_msg, CAPTURE_SR

    # 1) 优先：系统自带 '立体声混音' / 'Stereo Mix' 回环设备（按音质排序尝试）
    if device is None:
        for idx, ch, native_sr in _find_loopback_inputs():
            try:
                stream = sd.InputStream(
                    device=idx,
                    channels=min(ch, 2),
                    samplerate=native_sr,
                    blocksize=BLOCK,
                    dtype="float32",
                    callback=audio_callback,
                )
                stream.start()
                CAPTURE_SR = int(native_sr)
                audio_status = "loopback"
                status_msg = "系统音频(立体声混音)已启动"
                print(f"[音频] 使用立体声混音设备 #{idx} (声道={min(ch, 2)}, {int(native_sr)}Hz)")
                _log("[音频] 立体声混音回环成功，设备 #{0} 声道={2} Hz={3}".format(idx, "", min(ch, 2), int(native_sr)))
                return stream
            except Exception as e:
                print("[警告] 立体声混音 #{0} 启动失败: {1}".format(idx, e))
                _log("[音频] 立体声混音 #{0} 失败: {1}".format(idx, e))

    # 2) WASAPI loopback (仅在老 sounddevice 上有效)
    try:
        out_idx = sd.default.device[1] if device is None else device
        stream = sd.InputStream(
            device=out_idx,
            channels=2,
            samplerate=SR_TARGET,
            blocksize=BLOCK,
            dtype="float32",
            callback=audio_callback,
            extra_settings=WasapiSettings(as_loopback=True),
        )
        stream.start()
        audio_status = "loopback"
        status_msg = "系统音频(WASAPI 回环)已启动"
        print(f"[音频] WASAPI 回环捕获中，输出设备 #{out_idx}")
        _log("[音频] WASAPI 回环成功，设备 #{0}".format(out_idx))
        return stream
    except Exception as e:
        print("[警告] WASAPI 回环失败:", e)
        _log("[音频] WASAPI 回环失败: {0}".format(e))

    # 3) 回退：默认麦克风（只能听到麦克风输入，不会跟 QQ 音乐律动）
    try:
        stream = sd.InputStream(
            device=None, channels=1, samplerate=SR_TARGET,
            blocksize=BLOCK, dtype="float32", callback=audio_callback,
        )
        stream.start()
        audio_status = "mic"
        status_msg = "回环不可用，已回退到麦克风"
        print("[音频] 已回退到麦克风输入")
        _log("[音频] 回退到麦克风")
        return stream
    except Exception as e2:
        audio_status = "error"
        status_msg = f"音频启动失败: {e2}"
        print("[错误]", status_msg)
        _log("[音频] 启动失败: {0}".format(e2))
        return None


# --------------------------------------------------------------------------
# HTTP 静态服务 (标准库, 稳定跨平台)
# --------------------------------------------------------------------------
import http.server


# --------------------------------------------------------------------------
# v3.82 在线曲库：任何人上传后，所有能访问本站的人都能看到/播放
# 存储目录: HERE/online_library/  索引: index.json（[{id,name,size,ts}]）
# API（与本站同源，前端直接相对路径 fetch）:
#   GET  /api/online/list                 -> {"items":[...]}（新上传在前）
#   GET  /api/online/file?id=...          -> 音频流（支持 Range 断点/拖进度条）
#   POST /api/online/upload?name=xx.mp3   -> body=文件原始字节 -> {"ok":true,"item":...}
#                                            同名同大小自动去重（dup:true）
#   POST /api/online/delete  {"id":...}   -> 删除该歌曲
# --------------------------------------------------------------------------
ONLINE_DIR = os.path.join(HERE, "online_library")
ONLINE_IDX = os.path.join(ONLINE_DIR, "index.json")
_ONLINE_LOCK = threading.Lock()
_AUDIO_EXTS = {".mp3", ".flac", ".m4a", ".wav", ".ogg", ".aac", ".wma", ".opus"}
_AUDIO_MIME = {".mp3": "audio/mpeg", ".flac": "audio/flac", ".m4a": "audio/mp4",
               ".wav": "audio/wav", ".ogg": "audio/ogg", ".aac": "audio/aac",
               ".opus": "audio/opus", ".wma": "audio/x-ms-wma"}
ONLINE_MAX_SIZE = 200 * 1024 * 1024   # 单文件上限 200MB


def _online_load() -> list:
    try:
        with open(ONLINE_IDX, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _online_save(items: list) -> None:
    with open(ONLINE_IDX, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False)


class StaticHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=HERE, **kwargs)

    def log_message(self, *args):
        pass

    # ---- v3.82 在线曲库 API ----
    def _send_json(self, obj, code: int = 200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _online_disk_path(self, oid: str):
        """id 白名单校验（防目录穿越），返回磁盘路径或 None"""
        if not re.fullmatch(r"s_[0-9]+_[0-9a-f]+\.(mp3|flac|m4a|wav|ogg|aac|wma|opus)", oid or ""):
            return None
        p = os.path.join(ONLINE_DIR, oid)
        return p if os.path.isfile(p) else None

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        if u.path == "/api/online/list":
            with _ONLINE_LOCK:
                items = _online_load()
            return self._send_json({"items": items})
        if u.path == "/api/online/file":
            q = urllib.parse.parse_qs(u.query)
            p = self._online_disk_path((q.get("id") or [""])[0])
            if not p:
                return self.send_error(404)
            ext = os.path.splitext(p)[1].lower()
            size = os.path.getsize(p)
            start, end, code = 0, size - 1, 200
            rng = self.headers.get("Range")
            m = re.match(r"bytes=(\d*)-(\d*)$", rng or "")
            if m and (m.group(1) or m.group(2)):
                if m.group(1):
                    start = int(m.group(1))
                    if m.group(2):
                        end = int(m.group(2))
                else:
                    start = max(0, size - int(m.group(2)))
                end = min(end, size - 1)
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", "bytes */%d" % size)
                    self.end_headers()
                    return
                code = 206
            self.send_response(code)
            self.send_header("Content-Type", _AUDIO_MIME.get(ext, "application/octet-stream"))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(end - start + 1))
            if code == 206:
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            self.end_headers()
            try:
                with open(p, "rb") as f:
                    f.seek(start)
                    remain = end - start + 1
                    while remain > 0:
                        chunk = f.read(min(65536, remain))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remain -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        return super().do_GET()

    def do_POST(self):
        u = urllib.parse.urlsplit(self.path)
        if u.path == "/api/online/upload":
            q = urllib.parse.parse_qs(u.query)
            raw_name = (q.get("name") or [""])[0].strip()
            raw_name = os.path.basename(raw_name.replace("\\", "/"))
            stem, ext = os.path.splitext(raw_name)
            if ext.lower() not in _AUDIO_EXTS:
                return self._send_json({"ok": False, "error": "不支持的文件类型: " + (ext or "无")}, 400)
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length <= 0 or length > ONLINE_MAX_SIZE:
                return self._send_json({"ok": False, "error": "文件大小无效（上限 200MB）"}, 400)
            data = self.rfile.read(length)
            os.makedirs(ONLINE_DIR, exist_ok=True)
            with _ONLINE_LOCK:
                items = _online_load()
                for it in items:   # 同名同大小去重
                    if it.get("name") == stem and it.get("size") == length:
                        return self._send_json({"ok": True, "dup": True, "item": it})
                oid = "s_%d_%s%s" % (int(time.time() * 1000), uuid.uuid4().hex[:6], ext.lower())
                with open(os.path.join(ONLINE_DIR, oid), "wb") as f:
                    f.write(data)
                item = {"id": oid, "name": stem, "size": length, "ts": int(time.time())}
                items.insert(0, item)
                _online_save(items)
            return self._send_json({"ok": True, "item": item})
        if u.path == "/api/online/delete":
            try:
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            except Exception:
                body = {}
            oid = body.get("id") or ""
            p = self._online_disk_path(oid)
            if not p:
                return self._send_json({"ok": False, "error": "not found"}, 404)
            with _ONLINE_LOCK:
                _online_save([it for it in _online_load() if it.get("id") != oid])
            try:
                os.remove(p)
            except OSError:
                pass
            return self._send_json({"ok": True})
        if u.path == "/api/recognize":
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length <= 0 or length > API_RECOGNIZE_MAX_BODY:
                return self._send_json(
                    {"ok": False, "error": "识别请求体大小无效（上限 8MB）"}, 400)
            try:
                body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                audio_b64 = body.get("audio") or ""
                wav_bytes = base64.b64decode(audio_b64) if audio_b64 else b""
            except Exception:
                return self._send_json(
                    {"ok": False, "error": "识别请求体不是合法 JSON/base64"}, 400)
            if not wav_bytes:
                return self._send_json({"ok": False, "error": "audio 为空"}, 400)
            _log("[API·recognize] body={0}B wav={1}B".format(length, len(wav_bytes)))
            try:
                result = _http_recognize_sync(wav_bytes)
            except Exception as e:
                _log("[API·recognize] 异常: {0}".format(traceback.format_exc()))
                result = {"ok": False, "error": "识别服务异常: " + str(e)}
            return self._send_json(result)
        if u.path == "/api/search":
            try:
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            except Exception:
                body = {}
            q = (body.get("q") or "").strip()
            _log("[API·search] q={0}".format(q))
            try:
                result = _http_search_sync(q)
            except Exception as e:
                _log("[API·search] 异常: {0}".format(traceback.format_exc()))
                result = {"ok": False, "error": "搜索服务异常: " + str(e)}
            return self._send_json(result)
        return self.send_error(404)


def start_http(port):
    srv = http.server.ThreadingHTTPServer(("0.0.0.0", port), StaticHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# --------------------------------------------------------------------------
# ACRCloud 音频指纹识别（中文识别最强，1 亿+ 歌曲库）
# --------------------------------------------------------------------------
def _post_acrcloud(wav_bytes: bytes) -> dict:
    """向 ACRCloud /v1/identify 发音频，返回 JSON。
    鉴权：HMAC-SHA1(http_method + uri + access_key + data_type + sig_version + timestamp, secret)。
    字段：access_key / data_type='audio' / signature / signature_version='1' / timestamp / sample_bytes / sample。
    返回示例：{"status":{"code":0,"msg":"Success"},"metadata":{"music":[{"title":"...","artists":[{"name":"..."}], ...}]}}。
    """
    import http.client
    import hmac
    import hashlib
    import base64
    import uuid as _uuid

    timestamp = str(int(time.time()))
    string_to_sign = "POST\n/v1/identify\n{0}\naudio\n1\n{1}".format(
        ACR_ACCESS_KEY, timestamp
    )
    signature = base64.b64encode(
        hmac.new(
            ACR_ACCESS_SECRET.encode("utf-8"),
            string_to_sign.encode("utf-8"),
            hashlib.sha1,
        ).digest()
    ).decode("utf-8")

    boundary = "ACR-" + _uuid.uuid4().hex
    crlf = b"\r\n"
    body = (
        b"--" + boundary.encode() + crlf +
        b'Content-Disposition: form-data; name="access_key"' + crlf + crlf +
        ACR_ACCESS_KEY.encode("utf-8") + crlf +
        b"--" + boundary.encode() + crlf +
        b'Content-Disposition: form-data; name="data_type"' + crlf + crlf +
        b"audio" + crlf +
        b"--" + boundary.encode() + crlf +
        b'Content-Disposition: form-data; name="signature_version"' + crlf + crlf +
        b"1" + crlf +
        b"--" + boundary.encode() + crlf +
        b'Content-Disposition: form-data; name="signature"' + crlf + crlf +
        signature.encode("utf-8") + crlf +
        b"--" + boundary.encode() + crlf +
        b'Content-Disposition: form-data; name="timestamp"' + crlf + crlf +
        timestamp.encode("utf-8") + crlf +
        b"--" + boundary.encode() + crlf +
        b'Content-Disposition: form-data; name="sample_bytes"' + crlf + crlf +
        str(len(wav_bytes)).encode("utf-8") + crlf +
        b"--" + boundary.encode() + crlf +
        b'Content-Disposition: form-data; name="sample"; filename="audio.wav"' + crlf +
        b'Content-Type: audio/wav' + crlf + crlf +
        wav_bytes + crlf +
        b"--" + boundary.encode() + b"--" + crlf
    )
    conn = http.client.HTTPSConnection(ACR_HOST, timeout=20)
    headers = {
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        "Content-Length": str(len(body)),
        "User-Agent": "PHANTOM-BEATS/1.0",
        "Accept": "application/json",
    }
    conn.request("POST", "/v1/identify", body=body, headers=headers)
    resp = conn.getresponse()
    raw = resp.read().decode("utf-8", errors="ignore")
    conn.close()
    try:
        return json.loads(raw)
    except Exception as e:
        return {"status": {"code": -1, "msg": "非 JSON 响应: " + str(e)}, "_raw": raw[:300]}


def _dump_debug_wav(wav_bytes: bytes) -> None:
    """保存最近一次发送给识别 API 的 wav + 打印能量。供调试。
    同时复制一份到桌面（带时间戳），方便用户直接听。"""
    try:
        base_dir = os.path.dirname(__file__) if not getattr(sys, "frozen", False) else os.path.dirname(sys.executable)
        dbg_path = os.path.join(base_dir, "_debug_last.wav")
        with open(dbg_path, "wb") as f:
            f.write(wav_bytes)
        # 额外复制一份到桌面带时间戳
        try:
            desktop = os.path.join(os.path.expanduser("~"), "Desktop")
            if not os.path.isdir(desktop):
                # fallback：C:\桌面（有些 Windows 中文用户用这个）
                desktop = r"C:\桌面"
            ts = time.strftime("%Y%m%d-%H%M%S")
            desk_path = os.path.join(desktop, "PHANTOM_BEATS_last_capture_{0}.wav".format(ts))
            with open(desk_path, "wb") as f:
                f.write(wav_bytes)
            _log("[识别调试] 桌面复制: {0}".format(desk_path))
        except Exception as ee2:
            _log("[识别调试] 桌面复制失败: {0}".format(ee2))
        # 能量统计
        import numpy as _np
        with wave.open(dbg_path, "rb") as w:
            frames = _np.frombuffer(w.readframes(w.getnframes()), dtype=_np.int16).astype(_np.float32) / 32767.0
        if frames.size:
            pk = float(abs(frames).max())
            rms = float(_np.sqrt((frames.astype(_np.float64)**2).mean()))
            _log("[识别调试] {0} ({1} bytes) peak={2:.4f} rms={3:.4f}".format(
                dbg_path, len(wav_bytes), pk, rms))
    except Exception as ee:
        _log("[识别调试] 保存失败: {0}".format(ee))


# --------------------------------------------------------------------------
# AudD.io 音频指纹 + LRCLib 同步歌词（封装为同步函数，供 async 调用）
# --------------------------------------------------------------------------
def _post_audd(wav_bytes: bytes) -> dict:
    """用 http.client 显式 POST multipart/form-data 到 AudD，避开 urllib.request 默认行为带来的 Content-Type 冲突。
    AudD 字段名是 file（不是 audio）——这是文档明确要求的。
    return=time 让 AudD 返回采样段在歌内的起止秒，用于自动对齐歌词。
    """
    import http.client
    import uuid as _uuid
    boundary = "PB-" + _uuid.uuid4().hex
    crlf = b"\r\n"
    body = (
        b"--" + boundary.encode() + crlf +
        b'Content-Disposition: form-data; name="api_token"' + crlf + crlf +
        AUDD_API_TOKEN.encode("utf-8") + crlf +
        b"--" + boundary.encode() + crlf +
        b'Content-Disposition: form-data; name="return"' + crlf + crlf +
        b"time" + crlf +
        b"--" + boundary.encode() + crlf +
        b'Content-Disposition: form-data; name="file"; filename="audio.wav"' + crlf +
        b'Content-Type: audio/wav' + crlf + crlf +
        wav_bytes + crlf +
        b"--" + boundary.encode() + b"--" + crlf
    )
    conn = http.client.HTTPSConnection("api.audd.io", timeout=30)
    headers = {
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        "Content-Length": str(len(body)),
        "User-Agent": "PHANTOM-BEATS/1.0",
        "Accept": "application/json",
    }
    conn.request("POST", "/", body=body, headers=headers)
    resp = conn.getresponse()
    raw = resp.read().decode("utf-8", errors="ignore")
    conn.close()
    return json.loads(raw)


def _get_lrclib(track_name: str, artist_name: str, duration_s: float = 0.0) -> list:
    """查 LRCLib → 返回候选 [{syncedLyrics, plainLyrics, ...}]."""
    params = {"track_name": track_name, "artist_name": artist_name}
    if duration_s > 0:
        params["duration"] = str(int(duration_s))
    url = "https://lrclib.net/api/search?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "PHANTOM-BEATS/1.0"})
    return json.loads(urllib.request.urlopen(req, timeout=15).read().decode("utf-8", errors="ignore") or "[]")


def _get_lrclib_query(q: str) -> list:
    """手动输入歌名模糊查 LRCLib。"""
    url = "https://lrclib.net/api/search?" + urllib.parse.urlencode({"q": q})
    req = urllib.request.Request(url, headers={"User-Agent": "PHANTOM-BEATS/1.0"})
    return json.loads(urllib.request.urlopen(req, timeout=15).read().decode("utf-8", errors="ignore") or "[]")


def _lrclib_to_candidates(raw: list, max_n: int = 5) -> list:
    """LRCLib 原始搜索结果 → 规范化候选（只收带时间戳的 syncedLyrics）。
    每条：{source:'lrclib', lrc, title, artist, duration}。
    """
    out = []
    for e in (raw or []):
        lrc = e.get("syncedLyrics")
        if not lrc or "[" not in lrc:
            continue
        out.append({
            "source": "lrclib",
            "lrc": lrc,
            "title": e.get("trackName") or "",
            "artist": e.get("artistName") or "",
            "duration": int(round(e.get("duration") or 0)),
        })
        if len(out) >= max_n:
            break
    return out


_NETEASE_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
               "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")


def _netease_one_song_lyric(song: dict) -> dict:
    """对搜索结果中的一首歌取歌词。返回规范化候选 {} 或 None。"""
    sid = song.get("id")
    if not sid:
        return None
    # v3.54: lv=1 对部分新歌（如《放过你也放过我》王超然 id=2736597637）
    # 返回空歌词，lv=-1（全版本）才有数据；老歌两者返回一致
    url2 = "https://music.163.com/api/song/lyric?os=pc&id=" + str(sid) + "&lv=-1&kv=-1&tv=-1"
    req2 = urllib.request.Request(url2, headers={
        "User-Agent": _NETEASE_UA,
        "Referer": "https://music.163.com/",
    })
    with urllib.request.urlopen(req2, timeout=10) as r:
        ldata = json.loads(r.read().decode("utf-8", errors="ignore") or "{}")
    lrc_text = ((ldata.get("lrc") or {}).get("lyric")) or ""
    if not lrc_text or "[" not in lrc_text:
        return None
    return {
        "source": "netease",
        "lrc": lrc_text,
        "title": song.get("name") or "",
        "artist": " / ".join([a.get("name", "") for a in (song.get("artists") or [])]),
        "duration": int(round((song.get("duration") or 0) / 1000.0)),
    }


def _netease_search_songs(query: str, search_type: int = 1, limit: int = 5) -> list:
    """网易云搜索 → 原始 songs 列表。
    search_type=1 按歌名/歌手；type=1006 按【歌词内容】模糊搜索。
    失败抛异常（由调用方决定如何兜底）。
    """
    url1 = ("https://music.163.com/api/search/get?s=" + urllib.parse.quote(query)
            + "&type=" + str(int(search_type)) + "&limit=" + str(int(limit)))
    req = urllib.request.Request(url1, headers={
        "User-Agent": _NETEASE_UA,
        "Referer": "https://music.163.com/",
    })
    with urllib.request.urlopen(req, timeout=10) as r:
        data = json.loads(r.read().decode("utf-8", errors="ignore") or "{}")
    return ((data.get("result") or {}).get("songs")) or []


def _songs_to_lyric_cands(songs: list) -> list:
    """对一批搜索结果歌曲并发取歌词 → 规范化候选。
    v3.54：单首失败（限流/无版权歌词）自动跳过，不再毁掉整批结果。"""
    if not songs:
        return []
    out = []
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=min(3, len(songs))) as ex:
        futs = [ex.submit(_netease_one_song_lyric, s) for s in songs]
        for f in futs:
            try:
                cand = f.result(timeout=20)
            except Exception:
                continue
            if cand and cand.get("lrc"):
                out.append(cand)
    return out


def _get_netease_candidates(track_name: str, artist_name: str, limit: int = 3) -> list:
    """网易云按歌名/歌手多候选歌词。
    走 1) search/get?s=...&type=1&limit=N 找 N 首歌
       2) 并发对每首取 lyric → 多版本候选
    任意一步整体失败返回 []（不抛异常）。
    """
    try:
        q = ((track_name or "") + " " + (artist_name or "")).strip()
        if not q:
            return []
        return _songs_to_lyric_cands(_netease_search_songs(q, 1, limit))
    except Exception as e:
        _log("[网易云] 候选查询失败: {0}".format(e))
        return []


def _netease_lyric_text_candidates(phrase: str, limit: int = 5) -> list:
    """用户直接输入一句歌词 → 网易云 type=1006 歌词内容模糊搜歌 → 取歌词候选。
    任何失败返回 []（不影响其他源）。
    """
    phrase = (phrase or "").strip()
    if not phrase:
        return []
    try:
        return _songs_to_lyric_cands(_netease_search_songs(phrase, 1006, limit))
    except Exception as e:
        _log("[网易云·歌词搜索] 失败: {0}".format(e))
        return []


def _dedup_candidates(cands: list) -> list:
    """按 (来源, 歌名, 歌手) 去重，保持先后顺序。"""
    seen, out = set(), []
    for c in cands:
        key = (c.get("source"),
               (c.get("title") or "").strip().lower(),
               (c.get("artist") or "").strip().lower())
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


def _pick_recommended_idx(cands: list, duration_s: float) -> int:
    """挑推荐版本：LRCLib 优先；有时长信息时选与指纹时长最接近的（容差 5%/8s）。"""
    if not cands:
        return -1
    lr = [i for i, c in enumerate(cands) if c.get("source") == "lrclib"]
    if lr:
        if duration_s and duration_s > 0:
            best_i = min(lr, key=lambda i: abs((cands[i].get("duration") or 0) - duration_s))
            if abs((cands[best_i].get("duration") or 0) - duration_s) <= max(8.0, duration_s * 0.05):
                return best_i
        return lr[0]
    return 0


def _gather_lyric_candidates(title: str, artist: str, duration_s: float,
                             lrclib_raw: list, extra: list = None,
                             netease_cands=None) -> tuple:
    """聚合 LRCLib(多条) + 网易云歌名搜(最多3首) + 额外候选(如歌词内容搜)
       → (候选列表, 推荐下标)。
    带时间戳的优先；一个时间戳版本都没有时，才降级放纯文本歌词（与旧兜底一致）。
    v3.54：netease_cands 可由调用方并发预取后传入（手动搜索三路并发，
    避免串行在歌词内容搜之后被网易云限流）；不传则维持旧行为内部现取。"""
    if netease_cands is None:
        netease_cands = _get_netease_candidates(title, artist)
    # 剔除异常歌词：有时间戳但全是 [00:00.00] 的，加载即堆0秒、滚不出来
    raw_cands = [c for c in (_lrclib_to_candidates(lrclib_raw)
                             + (netease_cands or [])
                             + (extra or []))
                 if _is_playable_synced_lrc(c.get("lrc", ""))]
    cands = _dedup_candidates(raw_cands)[:8]
    if not cands:
        plain = []
        for e in (lrclib_raw or [])[:3]:
            p = e.get("plainLyrics")
            if p:
                plain.append({
                    "source": "lrclib", "lrc": p,
                    "title": e.get("trackName") or title,
                    "artist": e.get("artistName") or artist,
                    "duration": int(round(e.get("duration") or 0)),
                })
        cands = _dedup_candidates(plain)[:3]
    return cands, _pick_recommended_idx(cands, duration_s)


# --------------------------------------------------------------------------
# 候选集暂存：识别/搜索后把全部候选（含完整 lrc）存内存，用户点选时再下发
# 前端收到的 lyric_choice 只有元数据（不含 lrc 正文），轻量
# --------------------------------------------------------------------------
_CAND = {}                  # token -> record
_CAND_MAX = 16


def _store_candidate_set(title, artist, album, duration, offset,
                         src_prefix, cands, rec_i) -> str:
    for i, c in enumerate(cands):
        c["cid"] = str(i)
        c["recommended"] = (i == rec_i)
    token = uuid.uuid4().hex[:10]
    _CAND[token] = {
        "offset": offset, "title": title, "artist": artist, "album": album,
        "duration": duration, "src_prefix": src_prefix,
        "cands": cands, "rec": str(rec_i) if rec_i >= 0 else None,
    }
    if len(_CAND) > _CAND_MAX:
        for k in list(_CAND.keys())[:len(_CAND) - _CAND_MAX]:
            del _CAND[k]
    return token


def _candidate_choice_result(token: str, rec: dict) -> dict:
    """lyric_choice 推送：候选元数据列表（无 lrc 正文）。"""
    return {
        "type": "lyric_choice", "token": token,
        "title": rec["title"], "artist": rec["artist"], "album": rec["album"],
        "duration": rec["duration"], "recommended_cid": rec["rec"],
        "candidates": [{
            "cid": c["cid"], "source": c["source"],
            "title": c["title"], "artist": c["artist"],
            "duration": c["duration"], "recommended": c["recommended"],
        } for c in rec["cands"]],
    }


def _norm_search_text(s: str) -> str:
    """v3.46i 搜索词/歌名归一化：小写并去掉空白标点，用于匹配校验。"""
    return re.sub(r'[\s()（）\[\]【】\-—_·.,，。!！?？\'"]', '', (s or '').lower())


def _candidate_lyrics_msg(rec: dict, c: dict, auto: bool = False) -> dict:
    """把某条候选转成标准 lyrics 推送（前端走现有接收路径）。
    rec["offset"] 是识别反推出的【歌曲起点·音频时钟】；前端需要的是
    【此刻歌曲内进度】→ 构造消息瞬间外推 audio_now-offset。
    无论识别完成几秒后下发/用户多久后点选，都精确对齐当前播放。"""
    src = rec.get("src_prefix", "") + c.get("source", "?") + ("_auto" if auto else "")
    return {
        "type": "lyrics",
        "source": src,
        "title": c.get("title") or rec["title"],
        "artist": c.get("artist") or rec["artist"],
        "album": rec.get("album", ""),
        "songlink": "",
        "lrc": c.get("lrc", ""),
        "duration": c.get("duration") or rec["duration"],
        "audio_offset_sec": audio_time_seconds() - rec["offset"],
    }


async def recognize_song(ref_at: float = None) -> dict:
    """指纹识别当前播放歌曲 → 拿 title/artist → 查 LRCLib 歌词。
    优先 ACRCloud（中文识别最强），未配则走 AudD，都未配报需配置提示。
    ref_at: 用户点击识别/自动触发瞬间的音频时钟(秒)——时间点在录音、网络
    识别（约5秒）等一切耗时之前锁定，结果只反推歌曲起点，不受处理时长影响。
    返回 {'type':'lyrics'/'recognize_failed', ...}。
    """
    if not _audio_buffer:
        return {"type": "recognize_failed", "msg": "音频缓冲还没收到数据，等歌响起来再加一次"}
    if not ACR_HOST or not ACR_ACCESS_KEY or not ACR_ACCESS_SECRET:
        if not AUDD_API_TOKEN:
            return {"type": "recognize_failed",
                    "msg": "未配置识别 API（设环境变量 ACR_HOST/ACR_ACCESS_KEY/ACR_ACCESS_SECRET 或 AUDD_API_TOKEN）"}

    # ★ 从用户点击/自动触发这一刻开始计时（wav 在此后几毫秒内截取，终点≈此刻）
    click_at = float(ref_at) if ref_at is not None else audio_time_seconds()

    wav_bytes = await asyncio.to_thread(audio_buffer_to_wav, RECORD_SECONDS)
    if not wav_bytes:
        return {"type": "recognize_failed", "msg": "音频缓冲为空"}

    # ===== ACRCloud 优先（中文最强）=====
    if ACR_HOST and ACR_ACCESS_KEY and ACR_ACCESS_SECRET:
        try:
            acr = await asyncio.to_thread(_post_acrcloud, wav_bytes)
        except Exception as e:
            _log("[ACR] 调用失败: {0}".format(e))
            acr = None

        _log("[ACR] 原始响应: {0}".format(json.dumps(acr, ensure_ascii=False)[:600] if acr else "无响应"))
        _dump_debug_wav(wav_bytes)

        if acr and isinstance(acr.get("status"), dict) and acr["status"].get("code") == 0:
            musics = (acr.get("metadata") or {}).get("music") or []
            if musics:
                m0 = musics[0]
                title = (m0.get("title") or "").strip()
                artists = m0.get("artists") or []
                artist = (artists[0].get("name") or "").strip() if artists else ""
                album_obj = m0.get("album") or {}
                album = (album_obj.get("name") or "").strip() if isinstance(album_obj, dict) else ""
                duration_ms = m0.get("duration_ms") or 0
                # 对齐：play_offset_ms = 当前播放到的歌曲位置（毫秒），
                # 对应识别瞬间(click)。直接锚定，不做外推——
                # ACR 常只在 clip 的一段(如前10s)上匹配，对未匹配尾部
                # 线性外推会把歌曲位置系统性算大（实测约 +3.3s，歌词超前）。
                play_offset_ms = m0.get("play_offset_ms")
                db_begin_ms = m0.get("db_begin_time_offset_ms")
                sample_begin_ms = m0.get("sample_begin_time_offset_ms")
                offset = click_at
                if isinstance(play_offset_ms, (int, float)) and play_offset_ms >= 0:
                    offset = click_at - float(play_offset_ms) / 1000.0
                elif isinstance(db_begin_ms, (int, float)) and db_begin_ms >= 0:
                    # 无 play_offset 时退回内容字段对（clip覆盖[click_at-15,click_at]）
                    sb_ms = sample_begin_ms if (
                        isinstance(sample_begin_ms, (int, float))
                        and sample_begin_ms >= 0) else 0
                    offset = (click_at - RECORD_SECONDS
                              + float(sb_ms) / 1000.0
                              - float(db_begin_ms) / 1000.0)

                if not title:
                    return {"type": "recognize_failed", "msg": "ACRCloud 未返回歌名"}

                # 多源聚合候选歌词（LRCLib精确/模糊 + 网易云歌名 + 网易云歌词内容搜）
                # v3.46j 搜索用清洗歌名（去括号/DJ后缀），展示仍用原名
                search_title = _clean_song_title(title) or title
                lrclib_raw, lyr_extra = await _fetch_lyric_sources(
                    search_title, artist, duration_ms / 1000.0)
                cands, rec_i = await asyncio.to_thread(
                    _gather_lyric_candidates, search_title, artist,
                    duration_ms / 1000.0, lrclib_raw, lyr_extra)
                if cands:
                    token = _store_candidate_set(
                        title, artist, album, duration_ms / 1000.0,
                        offset, "acr_", cands, rec_i)
                    _log("[识别·ACR] {0} - {1} | 候选 {2} 条 推荐cid={3} | offset={4:.1f}s".format(
                        title, artist, len(cands), rec_i, offset))
                    return _candidate_choice_result(token, _CAND[token])
                # 识别到歌但拿不到歌词
                _log("[识别·ACR] {0} - {1} | 歌词查询为空 | offset={2:.1f}s".format(title, artist, offset))
                return {
                    "type": "lyrics",
                    "source": "acr",
                    "title": title,
                    "artist": artist,
                    "album": album,
                    "songlink": "",
                    "lrc": "",
                    "duration": duration_ms / 1000.0,
                    "audio_offset_sec": offset,
                }
        else:
            err_msg = ""
            if isinstance(acr, dict) and isinstance(acr.get("status"), dict):
                err_msg = acr["status"].get("msg", "")
            _log("[ACR] 未识别: {0}".format(err_msg or "无匹配结果"))

    # ===== AudD 兑底 =====
    if not AUDD_API_TOKEN:
        # ACR 未配且 AudD 也未配
        return {"type": "recognize_failed", "msg": "未识别到歌曲；可手动输歌名"}
    try:
        audd = await asyncio.to_thread(_post_audd, wav_bytes)
    except Exception as e:
        _log("[AudD] 调用失败: {0}".format(e))
        return {"type": "recognize_failed", "msg": "AudD 调用失败: " + str(e)}

    if audd.get("status") != "success" or not audd.get("result"):
        err = audd.get("error", {}).get("error_message", "未识别到歌曲")
        _log("[AudD] 未识别: {0}".format(err))
        return {"type": "recognize_failed", "msg": err}

    track = audd["result"]
    title = (track.get("title") or "").strip()
    artist = (track.get("artist") or "").strip()
    songlink = track.get("song_link") or ""
    if not title:
        return {"type": "recognize_failed", "msg": "AudD 未返回歌名"}

    offset = click_at
    tinfo = track.get("time") or {}
    if isinstance(tinfo, dict) and "start" in tinfo:
        try:
            clip_start_in_song = float(tinfo["start"])
            offset = click_at - RECORD_SECONDS - clip_start_in_song
        except (ValueError, TypeError):
            pass

    # 多源聚合候选歌词（LRCLib精确/模糊 + 网易云歌名 + 网易云歌词内容搜）
    # v3.46j 搜索用清洗歌名（去括号/DJ后缀），展示仍用原名
    search_title = _clean_song_title(title) or title
    lrclib_raw, lyr_extra = await _fetch_lyric_sources(search_title, artist, 0.0)
    cands, rec_i = await asyncio.to_thread(
        _gather_lyric_candidates, search_title, artist, 0.0, lrclib_raw, lyr_extra)
    if cands:
        token = _store_candidate_set(
            title, artist, track.get("album", ""), 0,
            offset, "audd_", cands, rec_i)
        _log("[识别·AudD] {0} - {1} | 候选 {2} 条 | offset={3:.1f}s".format(
            title, artist, len(cands), offset))
        return _candidate_choice_result(token, _CAND[token])
    _log("[识别·AudD] {0} - {1} | 歌词查询为空，低置信不自动采用 | offset={2:.1f}s".format(title, artist, offset))
    # v3.45 兜底误匹配保护：只有 AudD 匹配且各歌词源全空时，识别往往是错的
    # （实测中文歌被匹配成英文爵士杂曲）→ 不替换当前歌词，交用户手动确认
    return {
        "type": "recognize_unverified",
        "source": "audd",
        "title": title,
        "artist": artist,
        "album": track.get("album", ""),
        "songlink": songlink,
        "audio_offset_sec": offset,
        "msg": "AudD 低置信匹配到《{0} - {1}》但所有歌词库均无收录，"
               "为防误匹配未自动采用；如确认是这首歌请手动搜索歌名".format(title, artist),
    }


# --------------------------------------------------------------------------
# v4.06 局域网 API 核心：手机 PWA 播放器识别 / 搜索走电脑（替代欠费 SCF）
# 返回格式与 tencent_worker.js 的 handleRecognize/handleSearch 一致：
#   choice:  {ok,type:'choice',title,artist,album,duration,
#             anchor:{by:'acr'|'audd'|'manual',songSecAtClick},
#             recommended_cid, candidates:[{cid,title,artist,source,lrc,duration,recommended}]}
#   failed:  {ok:true,type:'failed',msg}
#   unverified: {ok:true,type:'unverified',by,title,artist,msg}
# --------------------------------------------------------------------------
def _http_gather_net(title: str, artist: str, duration_s: float):
    """同步并发取歌词源（LRCLib 精确 + 网易云歌词内容搜，LRCLib 空再模糊兜底），
    返回 (lrclib_raw, extra_cands) —— 与 async 版 _fetch_lyric_sources 等价。"""
    lrclib_raw, extra = [], []
    try:
        f1 = _HTTP_POOL.submit(_get_lrclib, title, artist, duration_s)
        f2 = _HTTP_POOL.submit(_netease_lyric_text_candidates, title)
        try:
            lrclib_raw = f1.result(timeout=15) or []
        except Exception as e:
            _log("[API·LRCLib] {0}".format(e)); lrclib_raw = []
        try:
            lyr_cands = f2.result(timeout=15) or []
        except Exception as e:
            _log("[API·网易云歌词] {0}".format(e)); lyr_cands = []
    except Exception as e:
        _log("[API·歌词源] 异常: {0}".format(e))
        lrclib_raw, lyr_cands = [], []
    if not lrclib_raw:
        try:
            lrclib_raw = _get_lrclib_query(title) or []
        except Exception as e:
            _log("[API·LRCLib模糊] {0}".format(e)); lrclib_raw = []
    extra = [c for c in (lyr_cands or [])
             if _title_loosely_same(c.get("title"), title)]
    return lrclib_raw, extra


def _http_choice(matched: dict, cands: list, rec_i: int) -> dict:
    """候选集 → SCF choice 响应（候选含完整 lrc，前端 _match.cands 本地换版直接可用）。"""
    for i, c in enumerate(cands):
        c["cid"] = str(i)
        c["recommended"] = (i == rec_i)
    return {
        "ok": True, "type": "choice",
        "title": matched.get("title") or "",
        "artist": matched.get("artist") or "",
        "album": matched.get("album") or "",
        "duration": (matched.get("durationMs") or 0) / 1000.0,
        "anchor": {
            "by": matched.get("by") or "manual",
            "songSecAtClick": matched.get("songSecAtClick") or 0,
        },
        "recommended_cid": str(rec_i) if rec_i >= 0 else "0",
        "candidates": cands,
    }


def _http_recognize_sync(wav_bytes: bytes) -> dict:
    """局域网 /api/recognize：ACRCloud 优先 → AudD 兜底 → 歌词候选聚合。
    songSecAtClick = 识别瞬间（片段末尾）的歌曲内位置，语义与 SCF 一致：
      前端按 songSecNow = songSecAtClick + (now - t0) 推进。"""
    matched = None
    if ACR_HOST and ACR_ACCESS_KEY and ACR_ACCESS_SECRET:
        try:
            acr = _post_acrcloud(wav_bytes)
        except Exception as e:
            _log("[API·ACR] 调用失败: {0}".format(e))
            acr = None
        _log("[API·ACR] 原始响应: {0}".format(
            json.dumps(acr, ensure_ascii=False)[:600] if acr else "无响应"))
        if acr and isinstance(acr.get("status"), dict) and acr["status"].get("code") == 0:
            musics = (acr.get("metadata") or {}).get("music") or []
            if musics:
                m0 = musics[0]
                title = (m0.get("title") or "").strip()
                artists = m0.get("artists") or []
                artist = (artists[0].get("name") or "").strip() if artists else ""
                album_obj = m0.get("album") or {}
                album = (album_obj.get("name") or "").strip() if isinstance(album_obj, dict) else ""
                duration_ms = m0.get("duration_ms") or 0
                # 片段=点击前15s；play_offset_ms=点击瞬间歌曲位置（ACR 锚定，不外推）
                song_sec = None
                if isinstance(m0.get("play_offset_ms"), (int, float)) and m0["play_offset_ms"] >= 0:
                    song_sec = float(m0["play_offset_ms"]) / 1000.0
                elif isinstance(m0.get("db_begin_time_offset_ms"), (int, float)) and m0["db_begin_time_offset_ms"] >= 0:
                    sb = m0.get("sample_begin_time_offset_ms")
                    sb = float(sb) / 1000.0 if isinstance(sb, (int, float)) and sb >= 0 else 0.0
                    song_sec = RECORD_SECONDS - sb + float(m0["db_begin_time_offset_ms"]) / 1000.0
                if title:
                    matched = {
                        "title": title, "artist": artist, "album": album,
                        "durationMs": duration_ms, "by": "acr",
                        "songSecAtClick": song_sec if song_sec is not None else 0.0,
                    }

    if not matched and AUDD_API_TOKEN:
        try:
            audd = _post_audd(wav_bytes)
        except Exception as e:
            _log("[API·AudD] 调用失败: {0}".format(e))
            audd = None
        if audd and audd.get("status") == "success" and audd.get("result"):
            t = audd["result"]
            title = (t.get("title") or "").strip()
            artist = (t.get("artist") or "").strip()
            album = (t.get("album") or "").strip()
            song_sec = 0.0
            tinfo = t.get("time") or {}
            if isinstance(tinfo, dict) and isinstance(tinfo.get("start"), (int, float)):
                song_sec = float(tinfo["start"]) + RECORD_SECONDS
            if title:
                matched = {
                    "title": title, "artist": artist, "album": album,
                    "durationMs": 0, "by": "audd", "songSecAtClick": song_sec,
                }

    if not matched:
        return {"ok": True, "type": "failed",
                "msg": "未识别到歌曲；可手动输歌名或一句歌词"}

    search_title = _clean_song_title(matched["title"]) or matched["title"]
    lrclib_raw, extra = _http_gather_net(
        search_title, matched["artist"], matched["durationMs"] / 1000.0)
    try:
        cands, rec_i = _gather_lyric_candidates(
            search_title, matched["artist"], matched["durationMs"] / 1000.0,
            lrclib_raw, extra)
    except Exception as e:
        _log("[API·聚合] {0}".format(e))
        cands, rec_i = [], -1
    if not cands:
        return {"ok": True, "type": "unverified", "by": matched["by"],
                "title": matched["title"], "artist": matched["artist"],
                "msg": (("AudD" if matched["by"] == "audd" else "识别") +
                        " 低置信匹配到《" + matched["title"] + " - " +
                        matched["artist"] + "》但所有歌词库均无收录，"
                        "为防误匹配未自动采用；如确认是这首歌请手动搜索歌名")}
    return _http_choice(matched, cands, rec_i)


def _http_search_sync(q: str) -> dict:
    """局域网 /api/search：LRCLib 模糊 + 网易云歌词内容搜 + 网易云歌名搜
    三路并发 → SCF choice 响应（推荐版优先选歌名与搜索词吻合的候选）。"""
    q = (q or "").strip()
    if not q:
        return {"ok": True, "type": "failed", "msg": "搜索内容为空"}
    parts = q.split(None, 1)
    t_name, a_name = parts[0], (parts[1] if len(parts) > 1 else "")
    raw, lyr_cands, name_cands = [], [], []
    try:
        f1 = _HTTP_POOL.submit(_get_lrclib_query, q)
        f2 = _HTTP_POOL.submit(_netease_lyric_text_candidates, q)
        f3 = _HTTP_POOL.submit(_get_netease_candidates, t_name, a_name)
        for f, name, slot in ((f1, "LRCLib", 0), (f2, "网易云歌词", 1), (f3, "网易云歌名", 2)):
            try:
                v = f.result(timeout=15) or []
                if slot == 0:
                    raw = v
                elif slot == 1:
                    lyr_cands = v
                else:
                    name_cands = v
            except Exception as e:
                _log("[API·搜索] {0} 源异常: {1}".format(name, e))
    except Exception as e:
        _log("[API·搜索] 并发异常: {0}".format(e))
    try:
        cands, rec_i = _gather_lyric_candidates(
            t_name, a_name, 0.0, raw, lyr_cands, name_cands)
    except Exception as e:
        _log("[API·搜索聚合] {0}".format(e))
        cands, rec_i = [], -1
    if not cands:
        return {"ok": True, "type": "failed",
                "msg": "没找到歌词（LRCLib + 网易云都没有），换个词试试"}
    # 推荐版优先选歌名与搜索词吻合的候选（与 WS lookup_lyrics_by_name 一致）
    for i, c in enumerate(cands):
        if _title_loosely_same(q, c.get("title") or ""):
            rec_i = i
            break
    top_title = (raw[0].get("trackName") if raw else "") or t_name
    top_artist = (raw[0].get("artistName") if raw else "") or a_name
    matched = {"title": top_title, "artist": top_artist, "album": "",
               "durationMs": 0, "songSecAtClick": 0, "by": "manual"}
    return _http_choice(matched, cands, rec_i)


def _clean_song_title(title: str) -> str:
    """v3.46j 识别歌名清洗：剔除与歌词搜索无关的版本修饰，提升歌词命中率。
    "心墙DjProgHouse2020" → "心墙"；"明天你是否依然爱我 (雷鬼版)" → "明天你是否依然爱我"。
    只在搜索歌词时使用，界面展示仍用 ACR 原始歌名。"""
    t = title or ""
    # 1. 去掉各种括号及其内容：(雷鬼版)（DJ版）[Cover]【Live】
    t = re.sub(r"[\(（\[【][^\)）\]】]*[\)）\]】]", " ", t)
    # 2. 结尾黏连的 DJ 串：心墙DjProgHouse2020 → 心墙（仅当中文字符或分隔符后紧跟 Dj）
    t = re.sub(r"(?:(?<=[一-鿿])|[\s\-_])[Dd][Jj][\s\-_]*[A-Za-z0-9]*$", "", t)
    # 3. 结尾英文版本词（前面须为中文或分隔符，防误伤英文歌名）
    t = re.sub(r"(?i)(?:(?<=[一-鿿])|[\s\-_])(?:re-?mix|bootleg|extended|radio edit|mix|edit|version|ver\.?|cover|live|acoustic|remastered?)[A-Za-z0-9 ]*$", "", t)
    # 4. 结尾中文版本词（括号外）：抖音版/DJ版/完整版/加速版/降调版/女声版 等
    t = re.sub(r"[\s\-_]*(?:抖音版|[Dd][Jj]版|完整版|剪辑版|加速版|降调版|烟嗓版|女声版|男声版|铃声版|热播版|伴奏版|片段)$", "", t)
    # 5. 收敛空白与分隔符
    t = re.sub(r"\s+", " ", t).strip(" -_—")
    return t.strip()


def _title_loosely_same(a: str, b: str) -> bool:
    """识别后把歌名当短语跑歌词内容搜(type=1006)时的结果过滤：
    曲名去标点空白后相等或互相包含才收（允许翻唱/歌手不同），
    排除歌词里碰巧出现该词的不相关歌曲。"""
    _punct = r"[\s\(\)（）\[\]【】·\-—_~,'\"!！?？:：;；、&<>]+"
    na = re.sub(_punct, "", (a or "").lower())
    nb = re.sub(_punct, "", (b or "").lower())
    if not na or not nb:
        return False
    return na in nb or nb in na


async def _fetch_lyric_sources(title: str, artist: str, duration_s: float):
    """识别路径（ACR/AudD 共用）并发取歌词源：
       ① LRCLib 精确(歌名+歌手+时长)，为空再用纯歌名模糊搜兜底；
       ② 网易云歌词内容搜(type=1006，把歌名当一句词搜) → 曲名匹配过滤。
    v3.30 前识别路径只有 LRCLib精确 + 网易云歌名搜，实测《烟雨成思》
    《与你到永久》等识别时两路全空、但同名手动搜（含 type=1006）能中。
    返回 (lrclib_raw, extra_cands)。"""
    lrclib_raw, lyr_cands = await asyncio.gather(
        asyncio.to_thread(_get_lrclib, title, artist, duration_s),
        asyncio.to_thread(_netease_lyric_text_candidates, title),
        return_exceptions=True)
    if isinstance(lrclib_raw, BaseException):
        _log("[LRCLib] {0}".format(lrclib_raw)); lrclib_raw = []
    if isinstance(lyr_cands, BaseException):
        _log("[网易云·歌词搜索] {0}".format(lyr_cands)); lyr_cands = []
    if not lrclib_raw:
        try:
            lrclib_raw = await asyncio.to_thread(_get_lrclib_query, title)
        except Exception as e:
            _log("[LRCLib] 模糊兜底失败: {0}".format(e)); lrclib_raw = []
    extra = [c for c in (lyr_cands or [])
             if _title_loosely_same(c.get("title"), title)]
    return lrclib_raw, extra


async def lookup_lyrics_by_name(query: str) -> dict:
    """手动输入【歌名/歌手 或 一句歌词】→ 多源多候选查歌词：
       LRCLib 模糊搜 + 网易云按歌名搜 + 网易云按【歌词内容】搜（type=1006）。
    立即播放推荐版本，并把全部候选交给用户自选（与识别同一套选择机制）。
    """
    query = (query or "").strip()
    if not query:
        return {"type": "recognize_failed", "msg": "搜索内容为空"}

    # 拆出歌手用于网易云歌名检索：约定 "歌名 歌手" 空格分隔
    parts = query.split(None, 1)
    t_name = parts[0] if parts else query
    a_name = parts[1] if len(parts) > 1 else ""

    # 三路并发：LRCLib 模糊搜 + 网易云【歌词内容】搜 + 网易云【歌名】搜
    # v3.54：①任一源异常（如 LRCLib 503）降级为空，不再拖垮整条搜索；
    #        ②歌名搜从聚合函数里的串行调用提为并发——串行排在歌词内容搜
    #          的取词请求之后，实测会被网易云限流（搜《放过你也放过我》
    #          歌名搜全军覆没，只回歌词里含这句话的《怎样才算爱》等无关歌）
    try:
        raw_task = asyncio.to_thread(_get_lrclib_query, query)
    except Exception:
        raw_task = None
    try:
        raw, lyr_cands, name_cands = await asyncio.gather(
            raw_task if raw_task else asyncio.sleep(0, result=[]),
            asyncio.to_thread(_netease_lyric_text_candidates, query),
            asyncio.to_thread(_get_netease_candidates, t_name, a_name),
            return_exceptions=True)
        if isinstance(raw, Exception):
            _log("[手动搜索] LRCLib 源异常: {0}".format(raw))
            raw = []
        if isinstance(lyr_cands, Exception):
            _log("[手动搜索] 网易云歌词源异常: {0}".format(lyr_cands))
            lyr_cands = []
        if isinstance(name_cands, Exception):
            _log("[手动搜索] 网易云歌名源异常: {0}".format(name_cands))
            name_cands = []
    except Exception as e:
        _log("[手动搜索] 搜索异常: {0}".format(e))
        raw, lyr_cands, name_cands = [], [], []

    at = audio_time_seconds()
    cands, rec_i = await asyncio.to_thread(
        _gather_lyric_candidates, t_name, a_name, 0.0, raw, lyr_cands,
        name_cands)
    if cands:
        # v3.54：推荐版优先选「歌名与搜索词吻合」的候选——旧逻辑只按源优先
        #（LRCLib 优先），LRCLib 挂掉时会把歌词内容搜到的无关歌（如搜
        # 《放过你也放过我》却推荐《怎样才算爱》）当推荐，触发 mismatch 后
        # 好版本被埋没在候选堆里
        for i, c in enumerate(cands):
            if _title_loosely_same(query, c.get("title") or ""):
                rec_i = i
                break
        # 顶层展示名取 LRCLib 第一条的规范名，没有再退回用户输入
        top_title = (raw[0].get("trackName") if raw else "") or t_name
        top_artist = (raw[0].get("artistName") if raw else "") or a_name
        token = _store_candidate_set(
            top_title, top_artist, "", 0, at, "manual_", cands, rec_i)
        _log("[手动搜索] {0} | 候选 {1} 条（歌词源 {2} 条）".format(
            query, len(cands), len(lyr_cands)))
        result = _candidate_choice_result(token, _CAND[token])
        # v3.46i 推荐版歌名与搜索词无交集 → 标记不自动应用，仅给候选
        # （防止搜"往事如烟"被歌词全文搜索命中而自动切到"小城故事"）
        _recset = _CAND[token]
        rec_c = next((c for c in _recset["cands"] if c.get("cid") == _recset["rec"]),
                     _recset["cands"][0])
        nq = _norm_search_text(query)
        nt = _norm_search_text(rec_c.get("title") or top_title)
        if nq and nt and nq not in nt and nt not in nq:
            result["query_mismatch"] = True
            _log("[手动搜索] 推荐版「{0}」与搜索词「{1}」歌名不吻合，不自动应用".format(
                rec_c.get("title"), query))
        return result
    return {"type": "recognize_failed",
            "msg": "没找到歌词（LRCLib + 网易云歌名/歌词搜索都没有），换个词试试"}


async def expand_lyric_pool_by_title(title: str) -> dict:
    """只有一个歌词版本、用户点「版本更换」时调用：
    只按【歌名】（不带歌手）重新搜索一次，把匹配到的歌词池聚合起来，
    从中选出一个【不同于当前唯一版本】的合适版本播放。
    全程不录音、不走指纹。"""
    title = (title or "").strip()
    if not title:
        return {"type": "recognize_failed", "msg": "缺少歌名，无法重新搜索"}

    # LRCLib 歌名模糊搜 + 网易云歌词内容搜，两路并发（任一源失败不拖垮整条命令）
    try:
        raw_task = asyncio.to_thread(_get_lrclib_query, title)
    except Exception:
        raw_task = None
    try:
        raw, lyr_cands = await asyncio.gather(
            raw_task if raw_task else asyncio.sleep(0, result=[]),
            asyncio.to_thread(_netease_lyric_text_candidates, title),
            return_exceptions=True)
        if isinstance(raw, Exception):
            _log("[扩池重搜] LRCLib 源异常: {0}".format(raw))
            raw = []
        if isinstance(lyr_cands, Exception):
            _log("[扩池重搜] 网易云源异常: {0}".format(lyr_cands))
            lyr_cands = []
    except Exception as e:
        _log("[扩池重搜] 搜索异常: {0}".format(e))
        raw, lyr_cands = [], []

    at = audio_time_seconds()
    try:
        cands, rec_i = await asyncio.to_thread(
            _gather_lyric_candidates, title, "", 0.0, raw, lyr_cands)
    except Exception as e:
        _log("[扩池重搜] 聚合异常: {0}".format(e))
        cands, rec_i = [], -1
    if not cands:
        return {"type": "recognize_failed",
                "msg": "按歌名「{0}」重新搜索仍没有其他歌词版本".format(title)}

    top_title = (raw[0].get("trackName") if raw else "") or title
    top_artist = (raw[0].get("artistName") if raw else "") or ""
    token = _store_candidate_set(
        top_title, top_artist, "", 0, at, "manual_", cands, rec_i)
    _log("[扩池重搜] {0} | 候选 {1} 条（歌词源 {2} 条）".format(
        title, len(cands), len(lyr_cands)))
    return _candidate_choice_result(token, _CAND[token])


# --------------------------------------------------------------------------
# 自动跟随状态机（v3.29 新规则）：
#   歌词放完（到最后一行）后再等 GRACE 秒 → 自动录音识别下一首；
#   识别进行中(pending)不重复触发；
#   连续失败 FAIL_MAX 次 → 进入"纯DJ模式"：关闭自动跟随，等用户手动识别。
# --------------------------------------------------------------------------
_AUTO_LOCK = {
    "enabled": True,           # 是否开启（前端可控制）
    "grace": 30.0,             # 歌词放完后等待秒数（v3.39：20→30，延后10秒让15s识别窗口避开上一首尾声）
    "song_end_at": 0.0,        # 当前歌词最后一行对应的音频时钟(秒)；0=还没加载过歌
    "pending": False,          # 是否有识别任务正在跑（防重入 = "加载中暂停"）
    "fail_count": 0,           # 连续失败次数
    "dj_mode": False,          # 是否已转纯DJ模式
    "current": None,           # (title_lower, artist_lower) 当前已推送过的歌
}
_AUTO_FAIL_MAX = 3

# v3.52: 前端"歌词锁定"屏蔽区间（服务器音频时钟，秒）。由播放页 WS 上报，
# 当前时间落在任一区间 → 自动跟随不识别；上报带 TTL，暂停播放/关页面后自动失效。
_SUPPRESS = {"ranges": [], "expire_at": 0.0}


def _is_suppressed(now: float):
    """now 是否落在锁定屏蔽区间；返回该区间的右端点（未屏蔽返回 None）。"""
    if now >= _SUPPRESS["expire_at"]:
        if _SUPPRESS["ranges"]:
            _SUPPRESS["ranges"] = []
        return None
    hit = [hi for lo, hi in _SUPPRESS["ranges"] if lo <= now <= hi]
    return max(hit) if hit else None

# 已连接 WS 客户端注册表：自动跟随识别全局只跑一次，结果广播给所有页面
_WS_CLIENTS = set()

# v3.43: 最近一次成功歌词的消息快照（list[dict]，1条lyrics 或 lyrics+lyric_choice两条）。
# 手机/新标签常在识别之后才连接——没有快照补发，它们只能看到持续推送的波形、
# 永远收不到歌词（歌词只在识别成功那一刻推一次）。
_CURRENT_LYRICS_MSGS = []


def _store_current_lyrics(*objs):
    """更新当前歌词快照（只在识别/搜索/换版成功时调用）。
    同时记录构造瞬间的帧时钟 at0——补发在若干秒/分钟后发生，
    歌曲内进度 audio_offset_sec 必须按 (at_now−at0) 线性推进，否则新连接歌词错位。"""
    at0 = audio_time_seconds()
    _CURRENT_LYRICS_MSGS[:] = [(at0, dict(o)) for o in objs]


async def _broadcast(obj: dict):
    """把一条 JSON 消息发给全部已连接客户端；发送失败的死连接顺手剔除。"""
    if not _WS_CLIENTS:
        return
    data = json.dumps(obj)
    dead = []
    for ws in tuple(_WS_CLIENTS):
        try:
            await ws.send(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _WS_CLIENTS.discard(ws)


async def _fanout(origin, obj: dict):
    """v3.43: 手动识别/搜索/换版结果——先发给发起连接（保持原顺序），
    再广播给【其他】全部连接（origin 已在 _WS_CLIENTS 中，用 is 跳过防重复）。
    旧实现只单推给发起者：在电脑点识别，手机/其他页面歌词永远不同步。"""
    data = json.dumps(obj)
    if origin is not None:
        try:
            await origin.send(data)
        except Exception:
            pass
    dead = []
    for ws in tuple(_WS_CLIENTS):
        if ws is origin:
            continue
        try:
            await ws.send(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _WS_CLIENTS.discard(ws)


def _lrc_last_sec(lrc: str):
    """取 LRC 文本里最大的时间戳（秒）；没有任何时间戳返回 None。"""
    last = None
    for line in (lrc or "").splitlines():
        for m in re.finditer(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]", line):
            sec = int(m.group(1)) * 60 + int(m.group(2))
            g3 = m.group(3)
            if g3:
                sec += int((g3 + "00")[:3]) / 1000.0
            if last is None or sec > last:
                last = sec
    return last


def _lrc_timestamps(lrc: str) -> list:
    """提取 LRC 文本里全部时间戳（秒，不去重）。"""
    out = []
    for line in (lrc or "").splitlines():
        for m in re.finditer(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]", line):
            sec = int(m.group(1)) * 60 + int(m.group(2))
            g3 = m.group(3)
            if g3:
                sec += int((g3 + "00")[:3]) / 1000.0
            out.append(sec)
    return out


def _is_playable_synced_lrc(lrc: str) -> bool:
    """是否为"可正常播放"的同步歌词：至少有一个时间戳且不全是 0。
    全部 [00:00.00] 的歌词一加载就整体堆在0秒、根本滚不出来 → 剔除。"""
    ts = _lrc_timestamps(lrc or "")
    return bool(ts) and any(t > 0 for t in ts)


def _apply_result_song_end(result: dict) -> None:
    """根据一条 lyrics / lyric_choice 结果更新"歌词放完"时钟。
    拿不到时间戳时用时长，再没有就以当前音频时间兜底。"""
    a = _AUTO_LOCK
    kind = result.get("type")
    now = audio_time_seconds()
    if kind == "lyrics":
        # ⚠️ audio_offset_sec 在歌词消息里是"发送瞬间的歌曲内进度"（前端显示坐标），
        # 不是歌曲起点时钟！歌曲起点时钟 = 当前时钟 − 进度；放完时钟 = 起点 + 最后行。
        # 旧写法直接 进度+最后行 → 提前约 2×进度秒触发，歌词还没放完就开始识别。
        progress = float(result.get("audio_offset_sec") or 0.0)
        last_s = _lrc_last_sec(result.get("lrc", ""))
        dur = float(result.get("duration") or 0.0)
        # v3.61：last_s 和 duration 取大者（歌可能在服务器启动前就开始放，last_s 过小）
        song_len = max(last_s or 0, dur)
        if song_len > 0:
            a["song_end_at"] = now - progress + song_len
        else:
            a["song_end_at"] = now
        # v3.61：算出的放完时间在过去（歌早于服务器启动）→ 至少等 120 秒再触发，防止死循环
        if a["song_end_at"] < now:
            _log("[放完时钟] lyrics: 算出过去值 {0:.1f} < now={1:.1f}，兜底 +120s".format(
                a["song_end_at"], now))
            a["song_end_at"] = now + 120
        _log("[放完时钟] lyrics: progress={0:.1f} song_len={1} → song_end_at={2:.1f} (now={3:.1f})".format(
            progress, song_len, a["song_end_at"], now))
    elif kind == "lyric_choice":
        rec = _CAND.get(result.get("token"))
        if rec:
            c = next((x for x in rec["cands"] if x["cid"] == rec["rec"]),
                     rec["cands"][0])
            last_s = _lrc_last_sec(c.get("lrc", ""))
            dur = float(c.get("duration") or 0.0)
            # v3.61：last_s 和 duration 取大者
            song_len = max(last_s or 0, dur)
            if song_len > 0:
                a["song_end_at"] = rec["offset"] + song_len
            else:
                a["song_end_at"] = now
            # v3.61：算出的放完时间在过去（歌早于服务器启动）→ 至少等 120 秒再触发，防止死循环
            if a["song_end_at"] < now:
                _log("[放完时钟] lyric_choice: 算出过去值 {0:.1f} < now={1:.1f}，兜底 +120s".format(
                    a["song_end_at"], now))
                a["song_end_at"] = now + 120
            _log("[放完时钟] lyric_choice: offset={0:.1f} song_len={1} lrc_len={2} → song_end_at={3:.1f} (now={4:.1f})".format(
                rec["offset"], song_len, len(c.get("lrc", "") or ""), a["song_end_at"], now))
        else:
            _log("[放完时钟] lyric_choice: token={0} 不在 _CAND 中！".format(result.get("token")))


async def _ws_push_recognition(websocket, result: dict) -> None:
    """把 recognize_song / lookup_lyrics_by_name 的结果推给前端：
       lyric_choice → 先发【推荐版本歌词】（自动滚动立刻开始），再发候选元数据列表；
       其余结果(lyrics / recognize_failed) → 原样单条。
       v3.43: 全部经 _fanout——发起页 + 其他已开页面（手机/其他标签）同步，
       并更新当前歌词快照供【之后】新连接补发。"""
    if result.get("type") == "lyric_choice":
        rec = _CAND.get(result.get("token"))
        if not rec:
            await _fanout(websocket,
                {"type": "recognize_failed", "msg": "候选已过期，请重新识别/搜索"})
            return
        # v3.46i 搜索词与推荐版歌名不符：只发候选列表，不自动应用歌词
        if result.get("query_mismatch"):
            await _fanout(websocket, result)
            return
        rec_c = next((c for c in rec["cands"] if c["cid"] == rec["rec"]),
                     rec["cands"][0])
        lyrics_msg = _candidate_lyrics_msg(rec, rec_c)
        await _fanout(websocket, lyrics_msg)
        await _fanout(websocket, result)
        _store_current_lyrics(lyrics_msg, result)
        return
    await _fanout(websocket, result)
    if result.get("type") == "lyrics":
        _store_current_lyrics(result)


async def _auto_lock_worker():
    """全局唯一的自动跟随调度器（v3.32 起不再随每个 WS 连接各跑一份）。
    规则：歌词放完 + grace 30s 才触发（识别窗口=最近15s，延后避免混入上一首尾声）；pending(加载中)不重入；
    连续 3 次失败转纯DJ模式并关闭。
    识别全局只执行一次，所有事件/歌词经 _broadcast【广播】给全部页面 →
    用户开几个标签或浏览器，倒计时结束都会同步自动换歌词。"""
    a = _AUTO_LOCK
    while True:
        await asyncio.sleep(0.5)
        try:
            if not a["enabled"] or a["pending"] or a["dj_mode"]:
                continue
            if not (ACR_HOST and ACR_ACCESS_KEY and ACR_ACCESS_SECRET) and not AUDD_API_TOKEN:
                continue  # 没配置识别 API就不启
            now = audio_time_seconds()
            forced = bool(a.get("force", False))
            trigger_at = 0.0 if forced else (a["song_end_at"] + a["grace"])
            # v3.52：锁定歌词区间内不【自动】识别（手动强制识别不受限）；
            # 把放完时钟推到区间结尾+grace，出区间后也不会在锁定段刚结束就立刻识别
            if not forced:
                sup_end = _is_suppressed(now)
                if sup_end is not None:
                    if a["song_end_at"] < sup_end:
                        a["song_end_at"] = sup_end
                    continue
            if now < trigger_at:
                # 睡到触发点附近；状态可能被手动识别/配置改变，最多睡1秒就重判
                await asyncio.sleep(min(1.0, max(0.05, trigger_at - now)))
                continue

            # ★ 触发瞬间锁定时间点（后续录音/识别耗时不影响对齐基准）
            trigger_ref_at = audio_time_seconds()
            a["force"] = False
            a["pending"] = True
            try:
                await _broadcast({"type": "auto_lock_started"})
                result = await recognize_song(trigger_ref_at)
                if result.get("type") in ("lyrics", "lyric_choice"):
                    a["fail_count"] = 0
                    new_id = ((result.get("title") or "").lower(),
                              (result.get("artist") or "").lower())
                    if new_id != a["current"]:
                        # 歌切了 → 广播歌词（推荐版本自动滚动 + 候选备用），source 加 _auto 后缀
                        a["current"] = new_id
                        if result.get("type") == "lyric_choice":
                            rec = _CAND.get(result.get("token"))
                            if rec:
                                rec_c = next(
                                    (c for c in rec["cands"] if c["cid"] == rec["rec"]),
                                    rec["cands"][0])
                                lyrics_msg = _candidate_lyrics_msg(rec, rec_c, auto=True)
                                await _broadcast(lyrics_msg)
                                await _broadcast(result)
                                _store_current_lyrics(lyrics_msg, result)
                            else:
                                await _broadcast(result)
                        else:
                            result["source"] = (result.get("source") or "") + "_auto"
                            await _broadcast(result)
                            _store_current_lyrics(result)
                        _apply_result_song_end(result)
                        await _broadcast({
                            "type": "auto_lock_changed",
                            "title": result.get("title", ""),
                            "artist": result.get("artist", ""),
                            "source": result.get("source", ""),
                        })
                    else:
                        # 同一首 → 更新放完时钟，只给底栏一个静默信号
                        _apply_result_song_end(result)
                        await _broadcast({
                            "type": "auto_lock_same",
                            "title": result.get("title", ""),
                            "artist": result.get("artist", ""),
                        })
                elif result.get("type") in ("recognize_failed", "recognize_unverified"):
                    # 失败/低置信未采用：均不计入成功。下次触发点从现在起再等 grace
                    # （unverified 若不接住会因 now≥trigger 每 0.5s 重刷识别 API）
                    a["fail_count"] += 1
                    a["song_end_at"] = audio_time_seconds()
                    await _broadcast({
                        "type": "auto_lock_failed",
                        "msg": result.get("msg", ""),
                        "fail_count": a["fail_count"],
                        "fail_max": _AUTO_FAIL_MAX,
                    })
                    if a["fail_count"] >= _AUTO_FAIL_MAX:
                        # 连续 3 次 → 纯DJ模式：关闭自动跟随，直到用户手动识别
                        a["dj_mode"] = True
                        a["enabled"] = False
                        await _broadcast({
                            "type": "auto_lock_dj_mode",
                            "msg": "连续 {0} 次没识别到歌曲，已进入纯DJ模式；"
                                   "点「🎵 识别歌曲」可重新开启自动跟随".format(_AUTO_FAIL_MAX),
                        })
                # 广播下次触发的音频时钟，给所有页面同步倒计时
                await _broadcast({
                    "type": "auto_lock_tick",
                    "next_at_audio": a["song_end_at"] + a["grace"],
                })
            finally:
                a["pending"] = False
        except asyncio.CancelledError:
            raise
        except Exception as e:
            _log("[自动跟随] 调度异常: {0}".format(e))


# --------------------------------------------------------------------------
# WebSocket：推送音频帧 + 接收识别/查询请求
# --------------------------------------------------------------------------
async def ws_handler(websocket, *args):
    global audio_status, status_msg
    # 发送初始状态
    await websocket.send(json.dumps({
        "type": "status",
        "mode": audio_status,
        "msg": status_msg,
        "acr_configured": bool(ACR_HOST and ACR_ACCESS_KEY and ACR_ACCESS_SECRET),
        "audd_configured": bool(AUDD_API_TOKEN),
        "auto_lock_enabled": _AUTO_LOCK["enabled"],
        "auto_lock_grace": _AUTO_LOCK["grace"],
        "auto_lock_next_at_audio": _AUTO_LOCK["song_end_at"] + _AUTO_LOCK["grace"],
    }))

    # v3.43: 补发当前歌词——本连接晚于识别时刻建立（手机打开/新标签）时，
    # 没有这一步只能看到波形、看不到歌词。
    for at0, _o in tuple(_CURRENT_LYRICS_MSGS):
        _m = dict(_o)
        # 快照里的 audio_offset_sec 是构造瞬间的歌曲内进度；按帧时钟增量推进到
        # 【当前】真实位置（⚠️ 不能直接用 audio_time_seconds()——那是服务器启动后
        # 累计的帧时钟，与歌曲内进度是两个坐标系，直接替换会错位约 90 秒）。
        if "audio_offset_sec" in _m:
            _m["audio_offset_sec"] = _o["audio_offset_sec"] + (audio_time_seconds() - at0)
        try:
            await websocket.send(json.dumps(_m))
        except Exception:
            break

    async def reader():
        """接收客户端命令（recognize / lookup_lyrics / lyrics_offset / auto_lock_config）。"""
        async for raw in websocket:
            try:
                msg = json.loads(raw)
                kind = msg.get("type")
                if kind == "recognize":
                    a0 = _AUTO_LOCK
                    if a0["pending"]:
                        # 自动跟随的识别正在跑 → 不重复识别；
                        # 其结果经 _broadcast 同样会到本页
                        await websocket.send(json.dumps({"type": "recognize_started"}))
                    else:
                        await websocket.send(json.dumps({"type": "recognize_started"}))
                        # ★ 命令到达瞬间（≈用户点击时刻）锁定时间点
                        click_ref_at = audio_time_seconds()
                        # 占用全局 pending 锁：自动跟随 worker 在此期间不会并发触发
                        a0["pending"] = True
                        try:
                            result = await recognize_song(click_ref_at)
                            await _ws_push_recognition(websocket, result)
                            if result.get("type") in ("lyrics", "lyric_choice"):
                                a = _AUTO_LOCK
                                a["current"] = ((result.get("title") or "").lower(),
                                                (result.get("artist") or "").lower())
                                a["fail_count"] = 0
                                _apply_result_song_end(result)
                                # 用户手动识别 = 解除纯DJ模式，恢复自动跟随
                                if a["dj_mode"]:
                                    a["dj_mode"] = False
                                    a["enabled"] = True
                                    try:
                                        await websocket.send(json.dumps({
                                            "type": "auto_lock_resumed",
                                            "next_at_audio": a["song_end_at"] + a["grace"],
                                        }))
                                    except Exception:
                                        pass
                                else:
                                    # 正常手动识别：刷新前端倒计时
                                    try:
                                        await websocket.send(json.dumps({
                                            "type": "auto_lock_tick",
                                            "next_at_audio": a["song_end_at"] + a["grace"],
                                        }))
                                    except Exception:
                                        pass
                        finally:
                            a0["pending"] = False
                elif kind == "lookup_lyrics":
                    await websocket.send(json.dumps({"type": "recognize_started",
                                                     "msg": "搜索中..."}))
                    result = await lookup_lyrics_by_name(msg.get("query", ""))
                    await _ws_push_recognition(websocket, result)
                    if result.get("type") in ("lyrics", "lyric_choice"):
                        a = _AUTO_LOCK
                        a["current"] = ((result.get("title") or "").lower(),
                                        (result.get("artist") or "").lower())
                        a["fail_count"] = 0
                        _apply_result_song_end(result)
                        # 搜索成功 → 同步前端倒计时
                        try:
                            await websocket.send(json.dumps({
                                "type": "auto_lock_tick",
                                "next_at_audio": a["song_end_at"] + a["grace"],
                            }))
                        except Exception:
                            pass
                elif kind == "expand_lyric_pool":
                    # 只有1个版本时点版本更换 → 按歌名（不带歌手）重搜扩池
                    title0 = (msg.get("title") or "").strip()
                    await websocket.send(json.dumps({"type": "recognize_started",
                                                     "msg": "按歌名重新搜索..."}))
                    result = await expand_lyric_pool_by_title(title0)
                    await _ws_push_recognition(websocket, result)
                    if result.get("type") in ("lyrics", "lyric_choice"):
                        a = _AUTO_LOCK
                        a["current"] = ((result.get("title") or "").lower(),
                                        (result.get("artist") or "").lower())
                        a["fail_count"] = 0
                        _apply_result_song_end(result)
                        try:
                            await websocket.send(json.dumps({
                                "type": "auto_lock_tick",
                                "next_at_audio": a["song_end_at"] + a["grace"],
                            }))
                        except Exception:
                            pass
                elif kind == "pick_candidate":
                    # 用户从候选列表中选定一个版本 → 下发该版本完整歌词（沿用识别时偏移）
                    rec = _CAND.get(msg.get("token"))
                    cid = str(msg.get("cid", ""))
                    if not rec:
                        await websocket.send(json.dumps({
                            "type": "recognize_failed",
                            "msg": "候选已过期，请重新识别/搜索"}))
                    else:
                        chosen = next((c for c in rec["cands"] if c["cid"] == cid), None)
                        if not chosen:
                            await websocket.send(json.dumps({
                                "type": "recognize_failed", "msg": "该候选不存在"}))
                        else:
                            lyrics_msg = _candidate_lyrics_msg(rec, chosen)
                            # v3.43: fanout 给全部页面 + 更新快照（用户在一端换版本，手机同步换）
                            await _fanout(websocket, lyrics_msg)
                            _tok = msg.get("token")
                            _prev = tuple(_CURRENT_LYRICS_MSGS)
                            if (len(_prev) == 2 and
                                    _prev[1].get("type") == "lyric_choice" and
                                    _prev[1].get("token") == _tok):
                                # 候选元数据仍有效 → 一并保留（新连接补发后版本下拉不丢）
                                _store_current_lyrics(lyrics_msg, _prev[1])
                            else:
                                _store_current_lyrics(lyrics_msg)
                            a = _AUTO_LOCK
                            a["current"] = ((chosen.get("title") or "").lower(),
                                            (chosen.get("artist") or "").lower())
                            _apply_result_song_end(lyrics_msg)
                            # 选定版本 → 同步前端倒计时
                            try:
                                await websocket.send(json.dumps({
                                    "type": "auto_lock_tick",
                                    "next_at_audio": a["song_end_at"] + a["grace"],
                                }))
                            except Exception:
                                pass
                elif kind == "lyrics_offset":
                    global lyrics_offset_sec
                    lyrics_offset_sec = float(msg.get("offset", 0.0))
                    await websocket.send(json.dumps({"type": "lyrics_offset_ack",
                                                     "offset": lyrics_offset_sec}))
                elif kind == "auto_lock_config":
                    a = _AUTO_LOCK
                    a["enabled"] = bool(msg.get("enabled", True))
                    if a["enabled"]:
                        # 手动重新开启 → 清掉失败计数和DJ状态
                        a["dj_mode"] = False
                        a["fail_count"] = 0
                    await websocket.send(json.dumps({
                        "type": "auto_lock_ack",
                        "enabled": a["enabled"],
                        "grace": a["grace"],
                        "next_at_audio": a["song_end_at"] + a["grace"],
                    }))
                elif kind == "auto_lock_force":
                    # 用户手动强制立即识别（绕过锁定屏蔽）
                    a["force"] = True
                elif kind == "auto_lock_suppress":
                    # v3.52：播放页上报锁定歌词屏蔽区间（服务器音频时钟）
                    now = audio_time_seconds()
                    ttl = max(1.0, min(60.0, float(msg.get("ttl", 20))))
                    ranges = []
                    for r in (msg.get("ranges") or []):
                        try:
                            lo, hi = float(r[0]), float(r[1])
                            if hi > lo:
                                ranges.append([lo, hi])
                        except Exception:
                            pass
                    ranges.sort()
                    new_sig = json.dumps(ranges)
                    if new_sig != json.dumps(_SUPPRESS["ranges"]):
                        _log("[锁定] 屏蔽区间已更新: {0} | 有效至 now+{1:.0f}s".format(
                            new_sig, ttl))
                    _SUPPRESS["ranges"] = ranges
                    _SUPPRESS["expire_at"] = now + ttl
            except Exception as e:
                _log("[WS] 客户端消息处理失败: {0}".format(e))

    reader_task = asyncio.create_task(reader())
    _WS_CLIENTS.add(websocket)
    try:
        while True:
            with lock:
                frame = dict(latest)
            frame["type"] = "frame"
            frame["at"] = audio_time_seconds()  # 当前累计播放时长(秒)
            await websocket.send(json.dumps(frame))
            await asyncio.sleep(1 / 45.0)
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        _WS_CLIENTS.discard(websocket)
        reader_task.cancel()


# 歌词时间偏移（秒），供客户端调±5s 按钮用；广播给前端同步用
lyrics_offset_sec = 0.0


# --------------------------------------------------------------------------
# 主入口
# --------------------------------------------------------------------------
def main():
    global PORT, WS_PORT
    ap = argparse.ArgumentParser(description="幻彩律动 音频引擎")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--device", type=str, default=None,
                    help="回环设备索引或名称(默认: 系统默认输出设备)")
    ap.add_argument("--list", action="store_true", help="列出音频设备后退出")
    ap.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    ap.add_argument("--no-http", action="store_true",
                    help="不启动 HTTP 静态服务（只跑 WebSocket）")
    args = ap.parse_args()
    PORT = args.port
    WS_PORT = PORT + 1

    # frozen 模式（PyInstaller 打包后的 exe）默认不开 HTTP，避免和 Electron/浏览器抢 8000
    enable_http = (not _IS_FROZEN) and (not args.no_http)

    _log("[启动] frozen={0} port={1} ws_port={2} http={3} device={4}".format(
        _IS_FROZEN, PORT, WS_PORT, enable_http, args.device))
    _log("[配置] ACRCloud={0} AudD={1}".format(
        "on" if (ACR_HOST and ACR_ACCESS_KEY and ACR_ACCESS_SECRET) else "off",
        "on" if AUDD_API_TOKEN else "off"))

    if args.list:
        try:
            print(sd.query_devices())
        except Exception as e:
            print("列举设备失败:", e)
        return

    # ---- 端口预检 ----
    if enable_http and not port_free(HOST, PORT):
        msg = ("[端口冲突] HTTP 端口 {0} 已被占用（很可能另一个 PHANTOM BEATS "
               "或音频服务正在运行）。请先关闭先前的实例，或用 --port 指定其他端口。").format(PORT)
        print(msg)
        _log(msg)
        sys.exit(0)
    if not port_free(HOST, WS_PORT):
        msg = ("[端口冲突] WebSocket 端口 {0} 已被占用（另一个 PHANTOM BEATS "
               "或独立 audio_server 正在运行）。请先关闭先前的实例后重试。").format(WS_PORT)
        print(msg)
        _log(msg)
        sys.exit(0)

    # 启动音频
    dev = None
    if args.device is not None:
        try:
            dev = int(args.device)
        except ValueError:
            # 按名称匹配
            try:
                for i, d in enumerate(sd.query_devices()):
                    if args.device.lower() in d["name"].lower():
                        dev = i
                        break
            except Exception:
                pass
    stream = start_audio(dev)

    # 启动 HTTP（如果启用）
    if enable_http:
        try:
            start_http(PORT)
        except OSError as e:
            msg = "[端口冲突] HTTP {0} 启动失败: {1}".format(PORT, e)
            print(msg)
            _log(msg)
            sys.exit(0)

    async def _run():
        try:
            async with websockets.serve(ws_handler, HOST, WS_PORT):
                url = "http://localhost:{0}".format(PORT)
                ws_url = "ws://localhost:{0}".format(WS_PORT)
                print("=" * 56)
                print("  幻彩律动 PHANTOM BEATS 已启动")
                print("  打开浏览器访问(页面): {0}".format(url if enable_http else "(已禁用)"))
                print("  WebSocket(音频流):    {0}".format(ws_url))
                print("  音源选择「系统音频」即可跟随任意软件的声音律动")
                print("=" * 56)
                _log("[就绪] HTTP={0} WS={1}".format(enable_http, ws_url))
                if enable_http and not args.no_open:
                    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
                # 全局自动跟随调度器（识别一次，广播给所有页面）
                asyncio.create_task(_auto_lock_worker())
                await asyncio.Future()  # 永久运行
        except OSError as e:
            # 兜底捕获 bind 失败（理论上预检已挡住，但防止 race）
            msg = "[端口冲突] WebSocket {0} 启动失败: {1}".format(WS_PORT, e)
            print(msg)
            _log(msg)
            sys.exit(0)

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        print("\n[退出] 正在停止…")
        _log("[退出] KeyboardInterrupt")
    finally:
        if stream is not None:
            try:
                stream.stop()
                stream.close()
            except Exception:
                pass


if __name__ == "__main__":
    main()
