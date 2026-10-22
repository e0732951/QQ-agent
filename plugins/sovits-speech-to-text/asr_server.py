"""Resident FunASR server for the sovits-speech-to-text plugin.

Loads the Chinese Paraformer that ships with GPT-SoVITS once, then transcribes
local audio files. Stdlib HTTP only, so the GPT-SoVITS runtime can run it as-is.

Environment:
  ASR_MODEL / ASR_VAD / ASR_PUNC   absolute model directories
  ASR_DEVICE                       auto | cuda | cpu
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(os.environ.get("ASR_WORKDIR") or Path(__file__).resolve().parent)
MODEL_DIR = Path(os.environ["ASR_MODEL"])
VAD_DIR = Path(os.environ["ASR_VAD"])
REQUESTED_DEVICE = os.environ.get("ASR_DEVICE", "auto").strip().lower() or "auto"

_lock = threading.Lock()
_model = None
_device = "cpu"


def pick_device() -> str:
    if REQUESTED_DEVICE == "cpu":
        return "cpu"
    import torch

    if not torch.cuda.is_available():
        return "cpu"
    if REQUESTED_DEVICE == "cuda":
        return "cuda"
    free, _total = torch.cuda.mem_get_info()
    # TTS already keeps several GB on this card. Paraformer only gets the GPU
    # when more than 4 GB is still free, otherwise it stays on CPU.
    return "cuda" if free > 4_000_000_000 else "cpu"


def load_model():
    global _model, _device
    os.chdir(ROOT)
    _device = pick_device()
    from funasr import AutoModel

    # This FunASR build does not register CTTransformer, so the bundled
    # punctuation model cannot be loaded. Paraformer text is still readable.
    _model = AutoModel(
        model=str(MODEL_DIR),
        vad_model=str(VAD_DIR),
        device=_device,
        disable_update=True,
    )
    print(f"FunASR ready on {_device}", flush=True)


def ffmpeg_to_wav(src: Path) -> Path:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("找不到 ffmpeg，无法解码这种语音格式")
    dst = src.with_suffix(".asr16k.wav")
    subprocess.run(
        [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-ac", "1", "-ar", "16000", str(dst)],
        check=True,
    )
    return dst


def prepare(path: Path) -> Path:
    if path.suffix.lower() in {".wav", ".mp3", ".flac", ".ogg", ".m4a"}:
        return path
    return ffmpeg_to_wav(path)


def transcribe(path: Path) -> str:
    audio = prepare(path)
    try:
        with _lock:
            result = _model.generate(input=str(audio))
    finally:
        if audio != path:
            try:
                audio.unlink()
            except OSError:
                pass
    if not result:
        return ""
    text = result[0].get("text", "") if isinstance(result[0], dict) else str(result[0])
    return " ".join(str(text).split()).strip()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"[asr] {self.address_string()} {fmt % args}", flush=True)

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._json(200, {"ok": True, "device": _device})
            return
        if parsed.path == "/control":
            command = parse_qs(parsed.query).get("command", [""])[0]
            if command == "exit":
                self._json(200, {"ok": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if urlparse(self.path).path != "/asr":
            self._json(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw.decode("utf-8") or "{}")
            path = Path(str(body.get("path") or "")).expanduser()
            if not path.is_file():
                self._json(400, {"ok": False, "error": f"文件不存在：{path}"})
                return
            text = transcribe(path)
            self._json(200, {"ok": True, "text": text})
        except Exception as exc:
            traceback.print_exc()
            self._json(500, {"ok": False, "error": str(exc)})


def main() -> None:
    host = os.environ.get("ASR_HOST", "127.0.0.1")
    port = int(os.environ.get("ASR_PORT", "9881"))
    for label, folder in (("ASR", MODEL_DIR), ("VAD", VAD_DIR)):
        if not folder.is_dir():
            raise SystemExit(f"找不到{label}模型目录：{folder}")
    load_model()
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"listening on http://{host}:{port}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
