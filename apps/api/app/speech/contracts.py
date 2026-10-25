from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class StreamingTranscriptionEvent:
    kind: str
    text: str = ""
    message: str = ""
    final_kind: str = ""


@dataclass(frozen=True)
class StreamingSynthesisEvent:
    kind: str
    audio: bytes = b""
    sample_rate: int = 0
    message: str = ""


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    language: str
    provider: str


@dataclass(frozen=True)
class SynthesisResult:
    audio: bytes
    mime_type: str
    provider: str


class SpeechToTextProvider(Protocol):
    name: str

    async def transcribe(self, audio: bytes, mime_type: str, language: str) -> TranscriptionResult:
        """Return text without persisting the original audio."""


class StreamingSpeechToTextProvider(Protocol):
    name: str

    async def transcribe_stream(self, audio_queue, language: str):
        """Yield incremental transcription events from a queue of PCM frames."""


class TextToSpeechProvider(Protocol):
    name: str

    async def synthesize(
        self,
        text: str,
        voice: str,
        speed: float,
        style: str,
        emotion_vector: tuple[float, ...] | list[float] | None = None,
        num_step: int | None = None,
    ) -> SynthesisResult:
        """Return audio bytes without persisting a permanent public resource."""


class StreamingTextToSpeechProvider(Protocol):
    name: str

    async def synthesize_stream(
        self,
        text: str,
        voice: str,
        speed: float,
        style: str,
        emotion_vector: tuple[float, ...] | list[float] | None = None,
        num_step: int | None = None,
    ):
        """Yield PCM audio chunks as they are synthesized."""
