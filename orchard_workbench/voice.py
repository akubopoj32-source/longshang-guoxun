"""Optional speech-to-text boundary for voice inspection notes.

Transcription uses an explicitly configured audio model on the same
Chat Completions endpoint as image extraction.
"""

import base64
import json
import os
import re
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .extraction import ModelUnavailable

# Whisper-style containers the Chat Completions audio part accepts.
FORMATS = {
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
    "audio/amr": "amr",
    "audio/3gpp": "3gp",
}
MAX_AUDIO_BYTES = 8 * 1024 * 1024
MAX_TRANSCRIPT = 2000

TRANSCRIBE_PROMPT = (
    "你是果园巡查的语音转写器。把音频中的话转成简体中文文字。"
    "只转写听到的内容，不要解释、不要补充、不要纠正事实。"
    "保留地点、数量、时间和不确定说法（如「疑似」「大概」）的原样表述。"
    "听不清的片段用「（听不清）」标注。只返回转写文字本身。"
)


def transcription_enabled():
    return bool(os.getenv("ORCHARD_MODEL_URL") and os.getenv("ORCHARD_VOICE_MODEL", "").strip())


def parse_audio(data):
    """Validate a data URI and return (mime, base64 payload, audio format)."""
    if not data:
        return None
    if not isinstance(data, str):
        raise ValueError("语音格式不正确。")
    header, separator, payload = data.partition(",")
    if not separator or not header.startswith("data:") or not header.endswith(";base64"):
        raise ValueError("语音格式不正确。")
    mime = header[len("data:"):-len(";base64")].strip().lower()
    audio_format = FORMATS.get(mime)
    if not audio_format:
        supported = "、".join(sorted(set(FORMATS.values())))
        raise ValueError(f"暂不支持这种语音格式，请使用 {supported}。")
    try:
        binary = base64.b64decode(payload, validate=True)
    except ValueError as error:
        raise ValueError("无法读取语音文件。") from error
    if not binary:
        raise ValueError("语音文件为空。")
    if len(binary) > MAX_AUDIO_BYTES:
        raise ValueError("语音超过 8 MB，请缩短录音时长。")
    return mime, payload, audio_format


def clean_transcript(text):
    if not isinstance(text, str):
        raise ValueError("转写结果格式不正确。")
    cleaned = re.sub(r"^\s*\x60\x60\x60(?:text)?\s*|\s*\x60\x60\x60\s*$", "", text.strip())
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        raise ValueError("没有识别到语音内容，请重试或改用文字输入。")
    if len(cleaned) > MAX_TRANSCRIPT:
        cleaned = cleaned[:MAX_TRANSCRIPT]
    return cleaned


def transcribe(data, hint=""):
    """Return (transcript, None) or raise ValueError / ModelUnavailable."""
    parsed = parse_audio(data)
    if parsed is None:
        raise ValueError("请先录音。")
    mime, payload, audio_format = parsed

    if not transcription_enabled():
        raise ModelUnavailable(
            "语音转写需要已配置的语音模型。可在当前页面重试，或手动录入文字。",
            503,
        )

    model = os.environ["ORCHARD_VOICE_MODEL"].strip()
    if model == "qwen3-asr-flash" or model.startswith("qwen3-asr-flash-"):
        messages = [{"role": "system", "content": [{"type": "text", "text": hint}]}] if hint else []
        content = [{"type": "input_audio", "input_audio": {"data": f"data:{mime};base64,{payload}"}}]
        options = {"asr_options": {"enable_itn": False}}
    else:
        messages = [{"role": "system", "content": TRANSCRIBE_PROMPT}]
        content = [{"type": "input_audio", "input_audio": {"data": payload, "format": audio_format}}]
        if hint:
            content.append({"type": "text", "text": f"场景提示：{hint}"})
        options = {"temperature": 0}
    messages.append({"role": "user", "content": content})
    payload_body = {"model": model, "messages": messages, "stream": False, **options}
    headers = {"Content-Type": "application/json"}
    if key := os.getenv("ORCHARD_MODEL_KEY"):
        headers["Authorization"] = "Bearer " + key

    try:
        request = Request(os.environ["ORCHARD_MODEL_URL"],
                          json.dumps(payload_body, ensure_ascii=False).encode("utf-8"),
                          headers)
        with urlopen(request, timeout=60) as response:
            raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("transcription response exceeds size limit")
        envelope = json.loads(raw)
        message = envelope["choices"][0]["message"]["content"]
        if isinstance(message, list):
            message = "".join(part.get("text", "") for part in message if isinstance(part, dict))
    except HTTPError as error:
        if error.code in (401, 403):
            raise ModelUnavailable("语音转写服务拒绝访问，请检查模型密钥。") from error
        if error.code == 429:
            raise ModelUnavailable("语音转写服务暂时限流，请稍后重试。", 503) from error
        if error.code in (400, 404, 415, 422):
            raise ModelUnavailable(
                "当前模型服务不接受这段音频，请检查语音模型和音频格式，或改用文字输入。", 422) from error
        raise ModelUnavailable("语音转写服务暂时不可用，请稍后重试。") from error
    except (URLError, TimeoutError, OSError) as error:
        if isinstance(error, TimeoutError) or isinstance(getattr(error, "reason", None), TimeoutError):
            raise ModelUnavailable("等待语音转写超时，请重试。", 504) from error
        raise ModelUnavailable("无法连接语音转写服务，请检查服务地址和网络。") from error
    except (ValueError, KeyError, IndexError, TypeError, AttributeError) as error:
        raise ModelUnavailable("语音转写未返回可用结果，请重试或改用文字输入。") from error

    return clean_transcript(message), None
