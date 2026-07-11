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


# ---------------------------------------------------------------------------
# Text-to-speech — ONE consistent, natural female voice character.
#   English → en-IN "Neerja"   |   Hindi → hi-IN "Swara"
# Microsoft Edge neural voices via edge-tts: free, no API key, and they
# sound like a person reading the text — never a robotic or male voice.
# ---------------------------------------------------------------------------

from fastapi.responses import StreamingResponse
from pydantic import BaseModel

TTS_VOICES = {
    "en": "en-IN-NeerjaNeural",
    "hi": "hi-IN-SwaraNeural",
}
TTS_MAX_CHARS = 3000  # safety cap; the app already summarizes long answers


class TtsRequest(BaseModel):
    text: str
    lang: str | None = "en"  # "en" | "hi"

@app.get("/")
def root():
    return {
        "service": "GAILexa Voice API",
        "status": "running",
        "note": "This is the backend. Open https://gailexa-web-vmyi.onrender.com for the GAILexa website.",
    }
  
@app.post("/tts")
async def tts(req: TtsRequest):
    import edge_tts

    text = (req.text or "").strip()[:TTS_MAX_CHARS]
    if not text:
        return {"error": "empty text"}

    voice = TTS_VOICES.get((req.lang or "en").lower()[:2], TTS_VOICES["en"])
    # Slightly unhurried pace for a warm, human read-aloud feel
    communicate = edge_tts.Communicate(text, voice, rate="-5%")

    async def stream():
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                yield chunk["data"]

    return StreamingResponse(stream(), media_type="audio/mpeg")


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
