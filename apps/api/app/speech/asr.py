import asyncio
import contextlib
import json
from urllib.parse import quote

import httpx

from ..config import settings
from .contracts import SpeechToTextProvider, StreamingTranscriptionEvent, TranscriptionResult
from .errors import SpeechProviderNotConfigured, SpeechProviderRejected, SpeechProviderUnavailable, TranscriptionEmpty


_asr_client: httpx.AsyncClient | None = None


def get_asr_client() -> httpx.AsyncClient:
    global _asr_client
    client_type = httpx.AsyncClient
    if (
        _asr_client is None
        or type(_asr_client) is not client_type
        or getattr(_asr_client, "is_closed", False)
    ):
        _asr_client = httpx.AsyncClient(
            timeout=httpx.Timeout(300, connect=5, read=300, write=60, pool=5),
            limits=httpx.Limits(max_connections=4, max_keepalive_connections=2, keepalive_expiry=120),
        )
    return _asr_client


async def close_asr_client() -> None:
    global _asr_client
    if _asr_client is not None and not getattr(_asr_client, "is_closed", False):
        await _asr_client.aclose()
    _asr_client = None


class MockSpeechToTextProvider:
    name = "mock"

    async def transcribe(self, audio: bytes, mime_type: str, language: str) -> TranscriptionResult:
        # The mock keeps the whole audio pipeline usable before a vendor is selected.
        return TranscriptionResult(
            text="（模拟转写）请在发送前编辑这段文字",
            language=language,
            provider=self.name,
        )


class OpenAICompatibleSpeechToTextProvider:
    name = "cloud"

    async def transcribe(self, audio: bytes, mime_type: str, language: str) -> TranscriptionResult:
        if not settings.asr_base_url or not settings.asr_api_key or not settings.asr_model:
            raise SpeechProviderNotConfigured("语音识别服务尚未配置")
        url = f"{settings.asr_base_url.rstrip('/')}/audio/transcriptions"
        headers = {"Authorization": f"Bearer {settings.asr_api_key}"}
        files = {"file": ("recording", audio, mime_type)}
        data = {"model": settings.asr_model, "language": language}
        try:
            response = await get_asr_client().post(url, headers=headers, files=files, data=data)
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout, httpx.NetworkError) as exc:
            raise SpeechProviderUnavailable("无法连接语音识别服务") from exc
        if response.status_code >= 400:
            detail = response.text[:240]
            raise SpeechProviderRejected(f"语音识别服务返回 HTTP {response.status_code}：{detail}")
        try:
            payload = response.json()
        except (ValueError, json.JSONDecodeError) as exc:
            raise SpeechProviderRejected("语音识别服务返回了无效结果") from exc
        text = payload.get("text") if isinstance(payload, dict) else None
        if not isinstance(text, str) or not text.strip():
            raise TranscriptionEmpty("语音识别没有返回文字")
        return TranscriptionResult(text=text.strip()[:12000], language=language, provider=self.name)


class VoiceStudioSpeechToTextProvider:
    name = "voicestudio"

    async def transcribe(self, audio: bytes, mime_type: str, language: str) -> TranscriptionResult:
        if not settings.asr_base_url:
            raise SpeechProviderNotConfigured("VoiceStudio 语音识别服务尚未配置")
        url = f"{settings.asr_base_url.rstrip('/')}/v1/audio/transcriptions"
        files = {"file": ("recording." + self._extension(mime_type), audio, mime_type)}
        normalized_language = self._language_code(language)
        data = {"model": settings.asr_model or "faster-whisper", "language": normalized_language}
        try:
            response = await get_asr_client().post(url, files=files, data=data)
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout, httpx.NetworkError) as exc:
            raise SpeechProviderUnavailable("无法连接 VoiceStudio 语音识别服务") from exc
        if response.status_code >= 400:
            detail = response.text[:240]
            raise SpeechProviderRejected(f"VoiceStudio 返回 HTTP {response.status_code}：{detail}")
        try:
            payload = response.json()
        except (ValueError, json.JSONDecodeError) as exc:
            raise SpeechProviderRejected("VoiceStudio 返回了无效的识别结果") from exc
        text = payload.get("text") if isinstance(payload, dict) else None
        if not isinstance(text, str) or not text.strip():
            raise TranscriptionEmpty("语音识别没有返回文字")
        return TranscriptionResult(text=text.strip()[:12000], language=language, provider=self.name)

    async def transcribe_stream(self, audio_queue, language: str, model: str = ""):
        if not settings.asr_base_url:
            raise SpeechProviderNotConfigured("VoiceStudio 语音识别服务尚未配置")
        ws_url = settings.asr_base_url.rstrip("/").replace("http://", "ws://").replace("https://", "wss://")
        ws_url = f"{ws_url}/ws/transcribe?pcm=1&sr=16000"
        selected_model = model.strip() or settings.asr_realtime_model.strip()
        if selected_model:
            ws_url = f"{ws_url}&model={quote(selected_model, safe='')}"
        elif settings.asr_model:
            ws_url = f"{ws_url}&model={quote(settings.asr_model, safe='')}"
        try:
            import websockets
            async with websockets.connect(
                ws_url,
                max_size=16 * 1024 * 1024,
                ping_interval=20,
                ping_timeout=20,
                open_timeout=10,
            ) as upstream:
                await upstream.send(json.dumps({"type": "input_audio.start", "format": "pcm16", "sample_rate": 16000}))

                async def forward_audio() -> None:
                    while True:
                        chunk = await audio_queue.get()
                        if chunk is None:
                            with contextlib.suppress(Exception):
                                await upstream.send("EOF")
                            return
                        if chunk:
                            with contextlib.suppress(Exception):
                                await upstream.send(chunk)

                forward_task = asyncio.create_task(forward_audio())
                try:
                    async for message in upstream:
                        if isinstance(message, bytes):
                            continue
                        try:
                            payload = json.loads(message)
                        except (TypeError, json.JSONDecodeError):
                            continue
                        if not isinstance(payload, dict):
                            continue
                        event_type = str(payload.get("type", ""))
                        if event_type == "partial":
                            yield StreamingTranscriptionEvent(kind="partial", text=str(payload.get("text", "")))
                        elif event_type == "final":
                            yield StreamingTranscriptionEvent(
                                kind="final",
                                text=str(payload.get("text", "")),
                                final_kind=str(payload.get("final_kind", "")),
                            )
                            return
                        elif event_type == "error":
                            yield StreamingTranscriptionEvent(kind="error", message=str(payload.get("message") or payload.get("detail") or "VoiceStudio 流式识别失败")[:240])
                            return
                finally:
                    if not forward_task.done():
                        forward_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await forward_task
        except (OSError, TimeoutError, websockets.WebSocketException) as exc:
            raise SpeechProviderUnavailable("无法连接 VoiceStudio 流式语音识别服务") from exc

    @staticmethod
    def _extension(mime_type: str) -> str:
        return {
            "audio/webm": "webm",
            "audio/ogg": "ogg",
            "audio/wav": "wav",
            "audio/mpeg": "mp3",
            "audio/mp4": "m4a",
            "audio/x-m4a": "m4a",
            "audio/aac": "aac",
        }.get(mime_type, "wav")

    @staticmethod
    def _language_code(language: str) -> str:
        normalized = language.strip().lower().replace("_", "-")
        return normalized.split("-", 1)[0] or "zh"


def get_asr_provider() -> SpeechToTextProvider:
    if settings.asr_provider == "mock":
        return MockSpeechToTextProvider()
    if settings.asr_provider == "cloud":
        return OpenAICompatibleSpeechToTextProvider()
    if settings.asr_provider == "voicestudio":
        return VoiceStudioSpeechToTextProvider()
    raise SpeechProviderNotConfigured(f"不支持的语音识别服务：{settings.asr_provider}")
