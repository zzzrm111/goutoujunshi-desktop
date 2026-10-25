import io
import json
import math
import struct
import wave

import httpx

from ..config import settings
from .contracts import StreamingSynthesisEvent, SynthesisResult, TextToSpeechProvider
from .errors import SpeechProviderNotConfigured, SpeechProviderRejected, SpeechProviderUnavailable, SynthesisEmpty


_tts_client: httpx.AsyncClient | None = None


def _voicestudio_style_payload(
    model: str,
    style: str,
    emotion_vector: tuple[float, ...] | list[float] | None = None,
) -> dict[str, object]:
    """Map app-level delivery directions onto VoiceStudio engine capabilities.

    OmniVoice's `instruct` is a closed voice-design vocabulary (gender, age,
    pitch, whisper, accents/dialects). Free-form emotional prose is rejected
    before any audio is generated, so current OmniVoice requests must not
    forward it. Engines with native emotion controls can consume the full
    direction through their own `emo_text` / free-form `instruct` path.
    """
    cleaned = " ".join((style or "").split())[:500]
    if not cleaned:
        return {}
    engine = (model or "").strip().lower()
    if engine.startswith("indextts") or "indextts" in engine:
        # The text-emotion branch loads a second Qwen encoder and is too slow
        # for live chat on 8 GB laptops. Use the app's bounded vector, and
        # otherwise let IndexTTS use its neutral/default delivery.
        if emotion_vector is not None and len(emotion_vector) == 8:
            return {"emo_vector": [float(v) for v in emotion_vector], "emo_alpha": 1.0}
        return {}
    if engine.startswith("cosyvoice") or "cosyvoice" in engine:
        return {"instruct": cleaned}
    # OmniVoice family: keep only a legal, conservative tone hint.
    if "omnivoice" in engine:
        tags: list[str] = []
        if any(token in cleaned for token in ("耳语", "悄悄", "轻声")):
            tags.append("whisper")
        if any(token in cleaned for token in (
            "生气",
            "克制",
            "冷淡",
            "不高兴",
            "冷静",
            "委屈",
            "难过",
            "温柔",
            "关心",
            "心疼",
        )):
            tags.append("low pitch")
        elif any(token in cleaned for token in (
            "轻快",
            "开心",
            "高兴",
            "撒娇",
            "吃醋",
            "试探",
        )):
            tags.append("high pitch")
        else:
            tags.append("moderate pitch")
        return {"instruct": ", ".join(tags)} if tags else {}
    return {"instruct": cleaned}


def get_tts_client() -> httpx.AsyncClient:
    global _tts_client
    client_type = httpx.AsyncClient
    if (
        _tts_client is None
        or type(_tts_client) is not client_type
        or getattr(_tts_client, "is_closed", False)
    ):
        _tts_client = httpx.AsyncClient(
            timeout=httpx.Timeout(300, connect=5, read=300, write=30, pool=5),
            limits=httpx.Limits(max_connections=8, max_keepalive_connections=4, keepalive_expiry=120),
        )
    return _tts_client


async def close_tts_client() -> None:
    global _tts_client
    if _tts_client is not None and not getattr(_tts_client, "is_closed", False):
        await _tts_client.aclose()
    _tts_client = None


def build_mock_wav() -> bytes:
    """Create a short valid tone so the local TTS path is testable without a vendor."""
    sample_rate = 16_000
    duration = 0.18
    samples = int(sample_rate * duration)
    frames = bytearray()
    for index in range(samples):
        amplitude = int(700 * math.sin(2 * math.pi * 440 * index / sample_rate))
        frames.extend(struct.pack("<h", amplitude))
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(bytes(frames))
    return output.getvalue()


class MockTextToSpeechProvider:
    name = "mock"

    async def synthesize(
        self,
        text: str,
        voice: str,
        speed: float,
        style: str,
        emotion_vector: tuple[float, ...] | list[float] | None = None,
        num_step: int | None = None,
    ) -> SynthesisResult:
        if not text.strip():
            raise SynthesisEmpty("没有可合成的文字")
        return SynthesisResult(audio=build_mock_wav(), mime_type="audio/wav", provider=self.name)


class OpenAICompatibleTextToSpeechProvider:
    name = "cloud"

    async def synthesize(
        self,
        text: str,
        voice: str,
        speed: float,
        style: str,
        emotion_vector: tuple[float, ...] | list[float] | None = None,
        num_step: int | None = None,
    ) -> SynthesisResult:
        if not settings.tts_base_url or not settings.tts_api_key or not settings.tts_model:
            raise SpeechProviderNotConfigured("语音合成服务尚未配置")
        url = f"{settings.tts_base_url.rstrip('/')}/audio/speech"
        headers = {"Authorization": f"Bearer {settings.tts_api_key}"}
        payload = {
            "model": settings.tts_model,
            "input": text,
            "voice": voice,
            "speed": speed,
            "response_format": "mp3",
        }
        if style:
            payload["instructions"] = style
        try:
            response = await get_tts_client().post(url, headers=headers, json=payload)
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout, httpx.NetworkError) as exc:
            raise SpeechProviderUnavailable("无法连接语音合成服务") from exc
        if response.status_code >= 400:
            detail = response.text[:240]
            raise SpeechProviderRejected(f"语音合成服务返回 HTTP {response.status_code}：{detail}")
        if not response.content:
            raise SynthesisEmpty("语音合成服务没有返回音频")
        return SynthesisResult(audio=response.content, mime_type=response.headers.get("content-type", "audio/mpeg").split(";", 1)[0], provider=self.name)


class VoiceStudioTextToSpeechProvider:
    name = "voicestudio"

    async def open_stream(self):
        """Open one reusable VoiceStudio TTS socket for a live call."""
        if not settings.tts_base_url or not settings.tts_model:
            raise SpeechProviderNotConfigured("VoiceStudio 语音合成服务尚未配置")
        ws_url = settings.tts_base_url.rstrip("/").replace("http://", "ws://").replace("https://", "wss://")
        ws_url = f"{ws_url}/ws/tts"
        import websockets

        try:
            return await websockets.connect(
                ws_url,
                max_size=16 * 1024 * 1024,
                ping_interval=20,
                ping_timeout=20,
                open_timeout=10,
            )
        except (OSError, TimeoutError, websockets.WebSocketException) as exc:
            raise SpeechProviderUnavailable("无法连接 VoiceStudio 流式语音合成服务") from exc

    async def synthesize_on_stream(
        self,
        websocket,
        text: str,
        voice: str,
        speed: float,
        style: str,
        request_id: int = 0,
        emotion_vector: tuple[float, ...] | list[float] | None = None,
        num_step: int | None = None,
    ):
        if not text.strip():
            return
        resolved_voice = voice.strip()
        if resolved_voice in {"", "default"}:
            resolved_voice = settings.tts_voice.strip() or "default"
        sample_rate = 24_000
        payload = {
            "text": text,
            "voice": resolved_voice,
            "speed": speed,
            "language": "zh",
            "response_format": "pcm16",
            "request_id": request_id,
        }
        if num_step is not None:
            payload["num_step"] = int(num_step)
        payload.update(_voicestudio_style_payload(settings.tts_model, style, emotion_vector))
        await websocket.send(json.dumps(payload, ensure_ascii=False))
        async for message in websocket:
            if isinstance(message, bytes):
                if message:
                    yield StreamingSynthesisEvent(kind="chunk", audio=message, sample_rate=sample_rate)
                continue
            try:
                payload = json.loads(message)
            except (TypeError, json.JSONDecodeError):
                continue
            if not isinstance(payload, dict):
                continue
            event_type = str(payload.get("type", ""))
            if event_type == "start":
                try:
                    sample_rate = int(payload.get("sample_rate") or sample_rate)
                except (TypeError, ValueError):
                    sample_rate = 24_000
                yield StreamingSynthesisEvent(kind="start", sample_rate=sample_rate)
            elif event_type == "done":
                yield StreamingSynthesisEvent(kind="done", sample_rate=sample_rate)
                return
            elif event_type == "error":
                detail = str(payload.get("detail") or "VoiceStudio 流式语音合成失败")
                yield StreamingSynthesisEvent(kind="error", message=detail[:240])
                return

    async def synthesize(
        self,
        text: str,
        voice: str,
        speed: float,
        style: str,
        emotion_vector: tuple[float, ...] | list[float] | None = None,
        num_step: int | None = None,
    ) -> SynthesisResult:
        if not text.strip():
            raise SynthesisEmpty("没有可合成的文字")
        if not settings.tts_base_url or not settings.tts_model:
            raise SpeechProviderNotConfigured("VoiceStudio 语音合成服务尚未配置")
        resolved_voice = voice.strip()
        if resolved_voice in {"", "default"}:
            resolved_voice = settings.tts_voice.strip() or "default"
        url = f"{settings.tts_base_url.rstrip('/')}/v1/audio/speech"
        payload = {
            "model": settings.tts_model,
            "input": text,
            "voice": resolved_voice,
            "speed": speed,
            "response_format": "wav",
            "language": "zh",
        }
        if num_step is not None:
            payload["num_step"] = int(num_step)
        payload.update(_voicestudio_style_payload(settings.tts_model, style, emotion_vector))
        try:
            response = await get_tts_client().post(url, json=payload)
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout, httpx.NetworkError) as exc:
            raise SpeechProviderUnavailable("无法连接 VoiceStudio 本地语音服务") from exc
        if response.status_code >= 400:
            detail = response.text[:240]
            raise SpeechProviderRejected(f"VoiceStudio 返回 HTTP {response.status_code}：{detail}")
        if not response.content:
            raise SynthesisEmpty("VoiceStudio 没有返回音频")
        return SynthesisResult(
            audio=response.content,
            mime_type=response.headers.get("content-type", "audio/wav").split(";", 1)[0],
            provider=self.name,
        )

    async def synthesize_stream(
        self,
        text: str,
        voice: str,
        speed: float,
        style: str,
        emotion_vector: tuple[float, ...] | list[float] | None = None,
        num_step: int | None = None,
    ):
        if not settings.tts_base_url or not settings.tts_model:
            raise SpeechProviderNotConfigured("VoiceStudio 语音合成服务尚未配置")
        try:
            async with await self.open_stream() as websocket:
                async for event in self.synthesize_on_stream(
                    websocket, text, voice, speed, style,
                    emotion_vector=emotion_vector, num_step=num_step,
                ):
                    yield event
        except (OSError, TimeoutError) as exc:
            raise SpeechProviderUnavailable("无法连接 VoiceStudio 流式语音合成服务") from exc


def get_tts_provider() -> TextToSpeechProvider:
    if settings.tts_provider == "mock":
        return MockTextToSpeechProvider()
    if settings.tts_provider == "cloud":
        return OpenAICompatibleTextToSpeechProvider()
    if settings.tts_provider == "voicestudio":
        return VoiceStudioTextToSpeechProvider()
    raise SpeechProviderNotConfigured(f"不支持的语音合成服务：{settings.tts_provider}")
