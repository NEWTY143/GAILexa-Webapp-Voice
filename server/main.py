"""
GAILexa Whisper service — speech-to-text with automatic language detection.

POST /transcribe  (multipart form, field "audio": webm/ogg/wav clip)
  → { "text": "...", "language": "hi" | "en" | ..., "probability": 0.98 }

The model is loaded lazily on the first request so /health responds
immediately after deploy while the model downloads in the background
of the first transcription.
"""

import os
import tempfile

from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware

MODEL_SIZE = os.getenv("WHISPER_MODEL", "tiny")  # tiny = lightest, best for free tier

app = FastAPI(title="GAILexa Whisper")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten to your site URL in production if desired
    allow_methods=["*"],
    allow_headers=["*"],
)

_model = None


def get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        _model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
    return _model


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_SIZE}


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    suffix = os.path.splitext(audio.filename or "clip.webm")[1] or ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as f:
        f.write(await audio.read())
        path = f.name

    try:
        segments, info = get_model().transcribe(
            path,
            beam_size=1,  # greedy decoding — ~3-4x less CPU than beam_size=5
            best_of=1,
            condition_on_previous_text=False,  # skips context re-processing
            vad_filter=True,  # trims silence so less audio is processed
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        return {
            "text": text,
            "language": info.language,
            "probability": round(info.language_probability, 3),
        }
    finally:
        os.unlink(path)
