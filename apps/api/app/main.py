import json
import asyncio
import base64
import binascii
import contextlib
import inspect
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import httpx
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .config import settings
from .db import Base, SessionLocal, engine
from .models import AdultConsent, AgentMemory, AgentProfile, Attachment, MemoryConsent, MemoryOperation, MemoryRecord, MessageRecord, RelationshipEvent, RelationshipRule, RelationshipState, SessionRecord, SkillInvocation
from .provider import ModelEmptyResponse, ModelNotConfigured, ModelProviderRejected, ModelProviderUnavailable, ModelStreamInterrupted, judge_relationship, stream_chat
from .schemas import (
    MemoryConsentUpdate,
    MemoryCreate,
    MemoryOut,
    MemoryPauseUpdate,
    MemoryStatus,
    MemoryUpdate,
    AdultConsentUpdate,
    AdultStatus,
    AttachmentAnalysisOut,
    AttachmentOut,
    AgentProfileOut,
    AgentProfileUpdate,
    AgentMemoryCreate,
    AgentMemoryOut,
    MessageCreate,
    MessageOut,
    RelationshipStateOut,
    RelationshipStateUpdate,
    RelationshipEventOut,
    RelationshipRuleCreate,
    RelationshipRuleOut,
    RelationshipRuleUpdate,
    SessionCreate,
    SessionDetail,
    SessionOut,
    SpeechSynthesisRequest,
    SpeechTranscriptionOut,
)
from .speech.asr import get_asr_provider
from .speech.errors import SpeechProviderNotConfigured, SpeechProviderRejected, SpeechProviderUnavailable, SynthesisEmpty, TranscriptionEmpty
from .speech_styles import build_speech_style
from .speech.tts import get_tts_provider
from .vision import VisionEmptyResponse, VisionNotConfigured, VisionProviderRejected, VisionProviderUnavailable, analyze_image
from .skills import assess_relationship_effect, build_core_context, build_profile_context, build_relationship_context, extract_memory_candidate, load_skill, load_specialist_context, match_relationship_rule, relationship_effect_for_kind, relationship_effect_for_rule, select_specialist_ids, trim_history

if settings.database_auto_create:
    Base.metadata.create_all(bind=engine)

app = FastAPI(title="Companion Agent API", version="0.1.0")


app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type"],
)

MAX_AUDIO_BYTES = 10 * 1024 * 1024
MAX_AUDIO_DURATION_MS = 60_000
ALLOWED_AUDIO_TYPES = {
    "audio/aac",
    "audio/mp4",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
    "audio/x-m4a",
}
MAX_IMAGE_BYTES = 10 * 1024 * 1024
ALLOWED_IMAGE_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
}
IMAGE_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
ATTACHMENT_ROOT = Path(settings.attachment_dir).resolve()
MAX_REALTIME_TURN_BYTES = 10 * 1024 * 1024
MAX_REALTIME_TURN_MS = 60_000

session_generation_locks: dict[str, asyncio.Lock] = {}
session_generation_tasks: dict[str, asyncio.Task[None]] = {}
relationship_judgement_tasks: set[asyncio.Task[None]] = set()
relationship_judgement_generations: dict[str, int] = {}
relationship_state_revision = 0


def get_generation_lock(session_id: str) -> asyncio.Lock:
    lock = session_generation_locks.get(session_id)
    if lock is None:
        lock = asyncio.Lock()
        session_generation_locks[session_id] = lock
    return lock


def bump_relationship_state_revision() -> int:
    global relationship_state_revision
    relationship_state_revision += 1
    return relationship_state_revision


def apply_relationship_effect(
    db: Session,
    *,
    session_id: str,
    user_message: str,
    relationship: RelationshipState,
    profile: AgentProfile,
    effect: dict[str, object],
    now: datetime,
) -> None:
    """Apply one relationship effect in one transaction."""
    relationship.updated_at = now
    mood_before = relationship.mood
    relationship.irritation = max(0, min(100, relationship.irritation + int(effect["irritation_delta"])))
    relationship.trust = max(0, min(100, relationship.trust + int(effect["trust_delta"])))
    relationship.affection = max(0, min(100, relationship.affection + int(effect["affection_delta"])))
    if effect["kind"] != "neutral":
        relationship.last_trigger = str(effect["trigger"])
        if effect["kind"] == "apology":
            relationship.silence_until = None
            relationship.conflict_count = max(0, relationship.conflict_count - 1)
        elif effect.get("needs_distance") and relationship.irritation >= 18:
            relationship.conflict_count += 1
            silence_minutes = int(effect.get("silence_minutes") or profile.silent_duration_minutes)
            relationship.silence_until = now + timedelta(minutes=silence_minutes)
    elif relationship.silence_until:
        silence_until = normalize_datetime(relationship.silence_until)
        if silence_until and silence_until <= now:
            relationship.silence_until = None
    if effect["kind"] in {"insult", "threat", "dismissal"}:
        relationship.mood = "生气" if relationship.irritation >= 40 else "不高兴"
    elif effect["kind"] == "apology":
        relationship.mood = "缓和" if relationship.irritation < 18 else "不高兴"
    elif relationship.mood in {"平静", "不高兴", "生气", "缓和"}:
        relationship.mood = "生气" if relationship.irritation >= 40 else ("不高兴" if relationship.irritation >= 18 else "平静")
    if effect["kind"] != "neutral":
        event = RelationshipEvent(
            session_id=session_id,
            event_type=str(effect["kind"]),
            trigger=str(effect["trigger"]),
            user_message=user_message[:12000],
            mood_before=mood_before,
            mood_after=relationship.mood,
            trust_delta=int(effect["trust_delta"]),
            affection_delta=int(effect["affection_delta"]),
            irritation_delta=int(effect["irritation_delta"]),
        )
        db.add(event)
        if effect["kind"] == "apology":
            unresolved = db.scalars(
                select(RelationshipEvent)
                .where(RelationshipEvent.resolved.is_(False), RelationshipEvent.event_type != "apology")
                .order_by(RelationshipEvent.created_at.desc())
                .limit(3)
            ).all()
            for previous in unresolved:
                previous.resolved = True
                previous.resolution_note = "用户主动道歉，关系开始修复"
                previous.resolved_at = now


def schedule_relationship_judgement(
    *,
    session_id: str,
    message_id: str,
    user_message: str,
    messages: list[dict[str, str]],
    skill_instructions: str,
    anger_sensitivity: int,
    generation: int,
    invocation_id: str,
    state_revision: int,
) -> asyncio.Task[None]:
    """Run the expensive contextual relationship check without delaying chat."""

    async def run() -> None:
        status = "skipped"
        try:
            judged_effect = await asyncio.wait_for(judge_relationship(messages, skill_instructions), timeout=12)
            if not judged_effect or float(judged_effect.get("confidence", 0)) < 0.78:
                status = "success"
                return
            if (
                relationship_judgement_generations.get(session_id) != generation
                or relationship_state_revision != state_revision
            ):
                return
            effect = relationship_effect_for_kind(
                str(judged_effect["kind"]), anger_sensitivity, str(judged_effect.get("trigger", "")),
            )
            # Neutral cooling already happened in the fast path.
            if effect["kind"] == "neutral":
                status = "success"
                return
            with SessionLocal() as background_db:
                message = background_db.get(MessageRecord, message_id)
                consent = background_db.get(AdultConsent, "local-user")
                if not message or message.session_id != session_id or not consent or not consent.confirmed:
                    return
                now = datetime.now(timezone.utc)
                profile = get_agent_profile(background_db)
                relationship = get_relationship_state(background_db)
                apply_relationship_effect(
                    background_db, session_id=session_id, user_message=user_message,
                    relationship=relationship, profile=profile, effect=effect, now=now,
                )
                background_db.commit()
                status = "success"
        except asyncio.CancelledError:
            status = "cancelled"
            raise
        except Exception:
            status = "failed"
        finally:
            with contextlib.suppress(Exception):
                with SessionLocal() as background_db:
                    invocation = background_db.get(SkillInvocation, invocation_id)
                    if invocation:
                        invocation.status = status
                        background_db.commit()

    task = asyncio.create_task(run())
    relationship_judgement_tasks.add(task)
    task.add_done_callback(relationship_judgement_tasks.discard)
    return task


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def attachment_file_path(stored_name: str) -> Path:
    candidate = (ATTACHMENT_ROOT / stored_name).resolve()
    if ATTACHMENT_ROOT not in candidate.parents:
        raise HTTPException(status_code=404, detail="附件不存在")
    return candidate


def serialize_attachment(item: Attachment) -> AttachmentOut:
    return AttachmentOut(
        id=item.id,
        kind=item.kind,
        original_name=item.original_name,
        mime_type=item.mime_type,
        size=item.size,
        analysis_status=item.analysis_status,
        summary=item.summary,
        created_at=item.created_at,
        url=f"/api/v1/attachments/{item.id}/file",
    )


@app.get("/api/v1/health")
def health():
    return {"status": "ok", "model_configured": bool(settings.model_base_url and settings.model_api_key and settings.model_name)}


@app.post("/api/v1/speech/transcribe", response_model=SpeechTranscriptionOut)
async def transcribe_speech(
    file: UploadFile = File(...),
    language: str = Form("zh-CN"),
    duration_ms: str = Form(""),
):
    mime_type = (file.content_type or "").split(";", 1)[0].strip().lower()
    if mime_type not in ALLOWED_AUDIO_TYPES:
        raise HTTPException(status_code=415, detail="不支持的音频格式")
    try:
        declared_duration = int(duration_ms) if duration_ms else None
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="音频时长格式无效") from exc
    if declared_duration is not None and not 0 <= declared_duration <= MAX_AUDIO_DURATION_MS:
        raise HTTPException(status_code=413, detail="录音最长支持 60 秒")
    audio = await file.read(MAX_AUDIO_BYTES + 1)
    if not audio:
        raise HTTPException(status_code=400, detail="录音内容为空")
    if len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="音频文件不能超过 10 MB")
    try:
        result = await get_asr_provider().transcribe(audio, mime_type, language.strip()[:20] or "zh-CN")
    except SpeechProviderNotConfigured as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except SpeechProviderUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except SpeechProviderRejected as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except TranscriptionEmpty as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return SpeechTranscriptionOut(
        text=result.text,
        language=result.language,
        duration_ms=declared_duration,
        provider=result.provider,
    )


@app.post("/api/v1/speech/synthesize")
async def synthesize_speech(payload: SpeechSynthesisRequest):
    requested_voice = payload.voice.strip()
    voice = settings.tts_voice if requested_voice in {"", "default"} else requested_voice
    try:
        provider = get_tts_provider()
        synthesize_kwargs = {}
        if _supports_tts_num_step(provider.synthesize):
            synthesize_kwargs["num_step"] = payload.num_step if payload.num_step is not None else settings.tts_chat_num_step
        result = await provider.synthesize(
            payload.text,
            voice,
            payload.speed,
            payload.emotion.strip()[:500],
            payload.emotion_vector,
            **synthesize_kwargs,
        )
    except SpeechProviderNotConfigured as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except SpeechProviderUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except SpeechProviderRejected as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except SynthesisEmpty as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return Response(
        content=result.audio,
        media_type=result.mime_type,
        headers={"X-Speech-Provider": result.provider, "X-Speech-Mode": "browser-fallback" if result.provider == "mock" else "audio", "Cache-Control": "no-store"},
    )


@app.post("/api/v1/sessions/{session_id}/attachments", response_model=AttachmentOut, status_code=201)
async def upload_attachment(
    session_id: str,
    file: UploadFile = File(...),
    analysis_prompt: str = Form(""),
    db: Session = Depends(get_db),
):
    session = db.get(SessionRecord, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")
    mime_type = (file.content_type or "").split(";", 1)[0].strip().lower()
    if mime_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=415, detail="请选择 JPG、PNG、WEBP 或 GIF 图片")
    content = await file.read(MAX_IMAGE_BYTES + 1)
    if not content:
        raise HTTPException(status_code=400, detail="图片内容为空")
    if len(content) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="图片不能超过 10 MB")
    original_name = (file.filename or "image")[:255]
    stored_name = f"{uuid4().hex}{IMAGE_EXTENSIONS[mime_type]}"
    ATTACHMENT_ROOT.mkdir(parents=True, exist_ok=True)
    target = attachment_file_path(stored_name)
    target.write_bytes(content)
    item = Attachment(
        session_id=session.id,
        kind="image",
        original_name=original_name,
        stored_name=stored_name,
        mime_type=mime_type,
        size=len(content),
    )
    try:
        summary = await analyze_image(content, mime_type, analysis_prompt[:400])
        item.analysis_status = "ready"
        item.summary = summary
    except VisionNotConfigured as exc:
        item.analysis_status = "unavailable"
        item.summary = str(exc)
    except (VisionProviderUnavailable, VisionProviderRejected, VisionEmptyResponse) as exc:
        item.analysis_status = "failed"
        item.summary = str(exc)
    db.add(item)
    db.commit()
    db.refresh(item)
    return serialize_attachment(item)


@app.get("/api/v1/attachments/{attachment_id}/file")
def get_attachment_file(attachment_id: str, db: Session = Depends(get_db)):
    item = db.get(Attachment, attachment_id)
    if not item or item.kind != "image":
        raise HTTPException(status_code=404, detail="附件不存在")
    path = attachment_file_path(item.stored_name)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="附件文件不存在")
    return FileResponse(path, media_type=item.mime_type, filename=item.original_name or None)


@app.delete("/api/v1/attachments/{attachment_id}", status_code=204)
def delete_attachment(attachment_id: str, db: Session = Depends(get_db)):
    item = db.get(Attachment, attachment_id)
    if not item:
        raise HTTPException(status_code=404, detail="附件不存在")
    path = attachment_file_path(item.stored_name)
    db.delete(item)
    db.commit()
    with contextlib.suppress(OSError):
        path.unlink()


def get_adult_consent(db: Session) -> AdultConsent:
    consent = db.get(AdultConsent, "local-user")
    if not consent:
        consent = AdultConsent(id="local-user", confirmed=False)
        db.add(consent)
        db.commit()
        db.refresh(consent)
    return consent


@app.get("/api/v1/adult/status", response_model=AdultStatus)
def adult_status(db: Session = Depends(get_db)):
    return get_adult_consent(db)


@app.post("/api/v1/adult/consent", response_model=AdultStatus)
def update_adult_consent(payload: AdultConsentUpdate, db: Session = Depends(get_db)):
    consent = get_adult_consent(db)
    consent.confirmed = payload.confirmed
    db.commit()
    db.refresh(consent)
    return consent


def get_memory_consent(db: Session) -> MemoryConsent:
    consent = db.get(MemoryConsent, "local-user")
    if not consent:
        consent = MemoryConsent(id="local-user", allowed=False, paused=False)
        db.add(consent)
        db.commit()
        db.refresh(consent)
    return consent


def get_agent_profile(db: Session) -> AgentProfile:
    profile = db.get(AgentProfile, "local-agent")
    if not profile:
        profile = AgentProfile(id="local-agent")
        db.add(profile)
        db.commit()
        db.refresh(profile)
    return profile


def get_relationship_state(db: Session) -> RelationshipState:
    state = db.get(RelationshipState, "local-relationship")
    if not state:
        state = RelationshipState(id="local-relationship")
        db.add(state)
        db.commit()
        db.refresh(state)
    return state


@app.get("/api/v1/agent/profile", response_model=AgentProfileOut)
def agent_profile(db: Session = Depends(get_db)):
    return get_agent_profile(db)


@app.put("/api/v1/agent/profile", response_model=AgentProfileOut)
def update_agent_profile(payload: AgentProfileUpdate, db: Session = Depends(get_db)):
    profile = get_agent_profile(db)
    for field, value in payload.model_dump().items():
        setattr(profile, field, value)
    bump_relationship_state_revision()
    db.commit()
    db.refresh(profile)
    return profile


@app.get("/api/v1/relationship/state", response_model=RelationshipStateOut)
def relationship_state(db: Session = Depends(get_db)):
    return get_relationship_state(db)


@app.put("/api/v1/relationship/state", response_model=RelationshipStateOut)
def update_relationship_state(payload: RelationshipStateUpdate, db: Session = Depends(get_db)):
    state = get_relationship_state(db)
    for field, value in payload.model_dump().items():
        setattr(state, field, value)
    bump_relationship_state_revision()
    db.commit()
    db.refresh(state)
    return state


@app.get("/api/v1/relationship/rules", response_model=list[RelationshipRuleOut])
def list_relationship_rules(db: Session = Depends(get_db)):
    return db.scalars(select(RelationshipRule).order_by(RelationshipRule.priority.desc(), RelationshipRule.created_at.asc())).all()


@app.post("/api/v1/relationship/rules", response_model=RelationshipRuleOut, status_code=201)
def create_relationship_rule(payload: RelationshipRuleCreate, db: Session = Depends(get_db)):
    rule = RelationshipRule(**payload.model_dump())
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return rule


@app.put("/api/v1/relationship/rules/{rule_id}", response_model=RelationshipRuleOut)
def update_relationship_rule(rule_id: str, payload: RelationshipRuleUpdate, db: Session = Depends(get_db)):
    rule = db.get(RelationshipRule, rule_id)
    if not rule:
        raise HTTPException(status_code=404, detail="关系规则不存在")
    for field, value in payload.model_dump().items():
        setattr(rule, field, value)
    db.commit()
    db.refresh(rule)
    return rule


@app.delete("/api/v1/relationship/rules/{rule_id}", status_code=204)
def delete_relationship_rule(rule_id: str, db: Session = Depends(get_db)):
    rule = db.get(RelationshipRule, rule_id)
    if not rule:
        raise HTTPException(status_code=404, detail="关系规则不存在")
    db.delete(rule)
    db.commit()


@app.get("/api/v1/agent/memories", response_model=list[AgentMemoryOut])
def list_agent_memories(db: Session = Depends(get_db)):
    return db.scalars(select(AgentMemory).where(AgentMemory.enabled.is_(True)).order_by(AgentMemory.importance.desc(), AgentMemory.updated_at.desc())).all()


@app.post("/api/v1/agent/memories", response_model=AgentMemoryOut, status_code=201)
def create_agent_memory(payload: AgentMemoryCreate, db: Session = Depends(get_db)):
    memory = AgentMemory(kind=payload.kind, content=payload.content, source="user", importance=payload.importance)
    db.add(memory)
    db.commit()
    db.refresh(memory)
    return memory


@app.delete("/api/v1/agent/memories/{memory_id}", status_code=204)
def delete_agent_memory(memory_id: str, db: Session = Depends(get_db)):
    memory = db.get(AgentMemory, memory_id)
    if not memory:
        raise HTTPException(status_code=404, detail="AI 记忆不存在")
    memory.enabled = False
    db.commit()


@app.get("/api/v1/relationship/events", response_model=list[RelationshipEventOut])
def list_relationship_events(db: Session = Depends(get_db)):
    return db.scalars(select(RelationshipEvent).order_by(RelationshipEvent.created_at.desc()).limit(100)).all()


def build_memory_context(db: Session) -> str:
    consent = get_memory_consent(db)
    if not consent.allowed or consent.paused:
        return "(长期记忆未启用)"
    records = db.scalars(select(MemoryRecord).order_by(MemoryRecord.updated_at.desc()).limit(30)).all()
    if not records:
        return "(已授权，但还没有保存的记忆)"
    return "\n".join(f"- [{record.kind}] {record.content}" for record in records)


def build_agent_memory_context(db: Session) -> str:
    records = db.scalars(
        select(AgentMemory)
        .where(AgentMemory.enabled.is_(True))
        .order_by(AgentMemory.importance.desc(), AgentMemory.updated_at.desc())
        .limit(20)
    ).all()
    if not records:
        return "(还没有额外的 AI 自身记忆)"
    return "\n".join(f"- [{record.kind}] {record.content}" for record in records)


def build_relationship_history_context(db: Session) -> str:
    events = db.scalars(select(RelationshipEvent).order_by(RelationshipEvent.created_at.desc()).limit(8)).all()
    if not events:
        return "(还没有已记录的关系事件)"
    return "\n".join(
        f"- {event.event_type}：{event.trigger}；情绪 {event.mood_before} -> {event.mood_after}；"
        f"信任 {event.trust_delta:+d}，烦躁 {event.irritation_delta:+d}；"
        f"{'已修复' if event.resolved else '尚未明确修复'}"
        for event in events
    )


def normalize_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def recover_relationship_over_time(state: RelationshipState, now: datetime) -> None:
    """Let irritation cool gradually without erasing trust or relationship history."""
    updated_at = normalize_datetime(state.updated_at)
    if not updated_at:
        return
    elapsed_hours = max(0.0, (now - updated_at).total_seconds() / 3600)
    recovery = min(state.irritation, int(elapsed_hours * 4))
    if recovery:
        state.irritation = max(0, state.irritation - recovery)
    silence_until = normalize_datetime(state.silence_until)
    if silence_until and silence_until <= now:
        state.silence_until = None
    if state.mood in {"生气", "不高兴", "缓和"} and state.irritation < 18 and not state.silence_until:
        state.mood = "平静"


def mark_initiative_window_used(profile: AgentProfile, now: datetime) -> None:
    """Consume only an available initiative window, rather than every turn."""
    if profile.initiative_level <= 1:
        return
    last = normalize_datetime(profile.last_initiative_at)
    cooldown = max(5, int(profile.initiative_cooldown_minutes))
    if last is None or (now - last).total_seconds() >= cooldown * 60:
        profile.last_initiative_at = now


@app.get("/api/v1/memory/status", response_model=MemoryStatus)
def memory_status(db: Session = Depends(get_db)):
    return get_memory_consent(db)


@app.post("/api/v1/memory/consent", response_model=MemoryStatus)
def update_memory_consent(payload: MemoryConsentUpdate, db: Session = Depends(get_db)):
    consent = get_memory_consent(db)
    consent.allowed = payload.allowed
    if not payload.allowed:
        consent.paused = False
    db.commit()
    db.refresh(consent)
    return consent


@app.post("/api/v1/memory/pause", response_model=MemoryStatus)
def update_memory_pause(payload: MemoryPauseUpdate, db: Session = Depends(get_db)):
    consent = get_memory_consent(db)
    if payload.paused and not consent.allowed:
        raise HTTPException(status_code=409, detail="请先授权长期记忆")
    consent.paused = payload.paused
    db.commit()
    db.refresh(consent)
    return consent


@app.get("/api/v1/memory", response_model=list[MemoryOut])
def list_memory(db: Session = Depends(get_db)):
    return db.scalars(select(MemoryRecord).order_by(MemoryRecord.updated_at.desc())).all()


@app.post("/api/v1/memory", response_model=MemoryOut, status_code=201)
def create_memory(payload: MemoryCreate, db: Session = Depends(get_db)):
    consent = get_memory_consent(db)
    if not consent.allowed or consent.paused:
        raise HTTPException(status_code=403, detail="请先授权并启用长期记忆")
    record = MemoryRecord(kind=payload.kind, content=payload.content)
    db.add(record)
    db.commit()
    db.refresh(record)
    db.add(MemoryOperation(memory_id=record.id, operation="create"))
    db.commit()
    return record


@app.patch("/api/v1/memory/{memory_id}", response_model=MemoryOut)
def update_memory(memory_id: str, payload: MemoryUpdate, db: Session = Depends(get_db)):
    consent = get_memory_consent(db)
    if not consent.allowed or consent.paused:
        raise HTTPException(status_code=403, detail="请先授权并启用长期记忆")
    record = db.get(MemoryRecord, memory_id)
    if not record:
        raise HTTPException(status_code=404, detail="记忆不存在")
    previous = record.content
    record.content = payload.content
    db.add(MemoryOperation(memory_id=record.id, operation="update", previous_content=previous))
    db.commit()
    db.refresh(record)
    return record


@app.delete("/api/v1/memory/{memory_id}", status_code=204)
def delete_memory(memory_id: str, db: Session = Depends(get_db)):
    record = db.get(MemoryRecord, memory_id)
    if not record:
        raise HTTPException(status_code=404, detail="记忆不存在")
    db.add(MemoryOperation(memory_id=record.id, operation="delete", previous_content=record.content))
    db.delete(record)
    db.commit()


@app.get("/api/v1/sessions", response_model=list[SessionOut])
def list_sessions(db: Session = Depends(get_db)):
    return db.scalars(select(SessionRecord).order_by(SessionRecord.updated_at.desc())).all()


@app.post("/api/v1/sessions", response_model=SessionOut)
def create_session(payload: SessionCreate, db: Session = Depends(get_db)):
    if payload.mode == "girlfriend" and not get_adult_consent(db).confirmed:
        raise HTTPException(status_code=403, detail="进入 AI 女友模式前请先确认你已年满 18 周岁")
    item = SessionRecord(mode=payload.mode)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@app.get("/api/v1/sessions/{session_id}", response_model=SessionDetail)
def get_session(session_id: str, db: Session = Depends(get_db)):
    item = db.get(SessionRecord, session_id)
    if not item:
        raise HTTPException(status_code=404, detail="会话不存在")
    return SessionDetail(
        id=item.id,
        title=item.title,
        mode=item.mode,
        updated_at=item.updated_at,
        messages=[
            MessageOut(
                id=message.id,
                role=message.role,
                content=message.content,
                created_at=message.created_at,
                attachments=[serialize_attachment(attachment) for attachment in message.attachments],
            )
            for message in sorted(item.messages, key=lambda row: row.created_at)
        ],
    )


@app.delete("/api/v1/sessions/{session_id}", status_code=204)
def delete_session(session_id: str, db: Session = Depends(get_db)):
    item = db.get(SessionRecord, session_id)
    if not item:
        raise HTTPException(status_code=404, detail="会话不存在")
    stored_names = [
        attachment.stored_name
        for attachment in db.scalars(select(Attachment).where(Attachment.session_id == session_id)).all()
    ]
    db.execute(delete(Attachment).where(Attachment.session_id == session_id))
    db.delete(item)
    db.commit()
    for stored_name in stored_names:
        with contextlib.suppress(OSError):
            attachment_file_path(stored_name).unlink()


@app.post("/api/v1/sessions/{session_id}/stop")
async def stop_generation(session_id: str, db: Session = Depends(get_db)):
    if not db.get(SessionRecord, session_id):
        raise HTTPException(status_code=404, detail="会话不存在")
    task = session_generation_tasks.get(session_id)
    if task and not task.done():
        task.cancel()
        return {"status": "stopping"}
    return {"status": "idle"}


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def realtime_error(code: str, message: str) -> dict:
    return {"type": "error", "code": code, "message": message}


def parse_realtime_frame(frame: str, response_id: str) -> list[dict]:
    events: list[dict] = []
    current_event = "message"
    for raw_line in frame.splitlines():
        line = raw_line.strip()
        if line.startswith("event:"):
            current_event = line[6:].strip()
            continue
        if not line.startswith("data:"):
            continue
        try:
            data = json.loads(line[5:].strip())
        except json.JSONDecodeError:
            continue
        if current_event == "token" and isinstance(data.get("text"), str):
            events.append({"type": "response.text.delta", "response_id": response_id, "text": data["text"]})
        elif current_event == "speech_style":
            emotion_vector = data.get("emotion_vector")
            events.append({
                "type": "speech.style",
                "response_id": response_id,
                "name": str(data.get("name", "")),
                "instruct": str(data.get("instruct", "")),
                "speed": data.get("speed", 1.0),
                "emotion_vector": (
                    [float(value) for value in emotion_vector]
                    if isinstance(emotion_vector, list) and len(emotion_vector) == 8
                    else []
                ),
            })
        elif current_event == "model_retry":
            events.append({
                "type": "model_retry",
                "response_id": response_id,
                "attempt": data.get("attempt", 0),
            })
        elif current_event in {"error", "done"}:
            if current_event == "done":
                events.append({"type": "response.completed", "response_id": response_id, "message_id": data.get("message_id", "")})
            elif isinstance(data.get("message"), str):
                events.append({"type": "error", "code": str(data.get("code", "generation_failed")), "message": data["message"]})
    return events


def compact_realtime_history(messages: list[dict[str, str]], max_messages: int = 6) -> list[dict[str, str]]:
    """Keep the live-call prompt bounded without discarding relationship state."""
    if max_messages <= 0:
        return []
    trimmed = messages[-max_messages:]
    while trimmed and trimmed[0].get("role") == "assistant":
        trimmed = trimmed[1:]
    return trimmed


def parse_realtime_sse(payload: str, response_id: str) -> list[dict]:
    events: list[dict] = []
    for frame in payload.split("\n\n"):
        if frame.strip():
            events.extend(parse_realtime_frame(frame, response_id))
    return events


async def stream_generation_sse(app_instance: FastAPI, session_id: str, text: str, response_id: str, realtime: bool = False):
    """Run the normal message endpoint internally and forward SSE frames as they arrive."""
    body = json.dumps({"content": text, "realtime": realtime}).encode("utf-8")
    headers = [(b"content-type", b"application/json"), (b"accept", b"text/event-stream")]
    request_sent = False
    buffer = ""
    queue: asyncio.Queue[list[dict] | None] = asyncio.Queue()

    async def receive():
        nonlocal request_sent
        if not request_sent:
            request_sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        await asyncio.sleep(3600)
        return {"type": "http.disconnect"}

    async def send(output):
        nonlocal buffer
        if output["type"] != "http.response.body":
            return
        buffer += bytes(output.get("body", b"")).decode("utf-8", errors="replace")
        while "\n\n" in buffer:
            frame, buffer = buffer.split("\n\n", 1)
            if frame.strip():
                await queue.put(parse_realtime_frame(frame, response_id))
        if not output.get("more_body", False):
            if buffer.strip():
                await queue.put(parse_realtime_frame(buffer, response_id))
                buffer = ""
            await queue.put(None)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": f"/api/v1/sessions/{session_id}/messages",
        "raw_path": f"/api/v1/sessions/{session_id}/messages".encode("ascii"),
        "query_string": b"",
        "headers": headers,
        "client": ("realtime", 0),
        "server": ("127.0.0.1", settings.api_port),
    }
    stream_task = asyncio.create_task(app_instance(scope, receive, send))
    try:
        while True:
            events = await queue.get()
            if events is None:
                break
            for event in events:
                yield event
    finally:
        if not stream_task.done():
            stream_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await stream_task


async def stream_realtime_answer(
    websocket: WebSocket,
    session_id: str,
    text: str,
    response_id: str,
) -> list[str]:
    answer_parts: list[str] = []
    completed_message_id = ""
    response_started = False
    sentence_buffer = ""
    first_speech_sent = False
    speech_style = {"name": "日常亲密", "instruct": "", "speed": 1.0}
    speech_queue: asyncio.Queue[str | None] | None = None
    speech_task: asyncio.Task[None] | None = None
    from .speech.tts import get_tts_provider
    speech_provider = get_tts_provider()
    speech_socket = None
    speech_socket_context = None
    speech_request_id = 0
    if getattr(speech_provider, "synthesize_stream", None) is not None:
        speech_queue = asyncio.Queue()

        open_stream = getattr(speech_provider, "open_stream", None)
        synthesize_on_stream = getattr(speech_provider, "synthesize_on_stream", None)
        if callable(open_stream) and callable(synthesize_on_stream):
            try:
                speech_socket_context = await open_stream()
                speech_socket = await speech_socket_context.__aenter__()
            except Exception:
                speech_socket_context = None
                speech_socket = None

        async def speech_worker() -> None:
            nonlocal speech_request_id
            assert speech_queue is not None
            try:
                while True:
                    segment = await speech_queue.get()
                    if segment is None:
                        return
                    speech_request_id += 1
                    if speech_socket is not None and callable(synthesize_on_stream):
                        await stream_realtime_speech_on_socket(
                            websocket,
                            speech_socket,
                            synthesize_on_stream,
                            segment,
                            response_id,
                            speech_request_id,
                            speech_style,
                        )
                    else:
                        await stream_realtime_speech(websocket, segment, response_id, speech_style)
            finally:
                if speech_socket_context is not None:
                    with contextlib.suppress(Exception):
                        await speech_socket_context.__aexit__(None, None, None)

        speech_task = asyncio.create_task(speech_worker())

    def drain_sentences(force: bool = False) -> None:
        nonlocal sentence_buffer, first_speech_sent
        if speech_queue is None:
            sentence_buffer = ""
            return
        # Keep each punctuation-delimited clause intact. In particular, a
        # Chinese comma is a speaking boundary; never cut an unfinished clause
        # solely because it reached a character-count threshold.
        pattern = re.compile(r"[，。！？!?；;、\n]")
        consumed = 0
        for match in pattern.finditer(sentence_buffer):
            end = match.end()
            segment = sentence_buffer[consumed:end].strip()
            consumed = end
            if segment:
                speech_queue.put_nowait(segment)
                first_speech_sent = True
        sentence_buffer = sentence_buffer[consumed:]
        if force and sentence_buffer.strip():
            speech_queue.put_nowait(sentence_buffer.strip())
            sentence_buffer = ""

    try:
        async for event in stream_generation_sse(app, session_id, text, response_id, realtime=True):
            if event["type"] == "response.text.delta":
                if not response_started:
                    await websocket.send_json({"type": "response.started", "response_id": response_id})
                    response_started = True
                token = str(event["text"])
                answer_parts.append(token)
                sentence_buffer += token
                await websocket.send_json(event)
                drain_sentences()
            elif event["type"] == "speech.style":
                if not response_started:
                    await websocket.send_json({"type": "response.started", "response_id": response_id})
                    response_started = True
                speech_style = {
                    "name": str(event.get("name", "日常亲密")),
                    "instruct": str(event.get("instruct", "")),
                    "speed": float(event.get("speed", 1.0) or 1.0),
                    "emotion_vector": event.get("emotion_vector", []),
                }
                await websocket.send_json(event)
            elif event["type"] == "response.completed":
                completed_message_id = str(event.get("message_id", ""))
            else:
                await websocket.send_json(event)
        if answer_parts:
            await websocket.send_json({"type": "response.text.completed", "response_id": response_id, "text": "".join(answer_parts)})
        if speech_queue is not None:
            drain_sentences(force=True)
            await speech_queue.put(None)
        if speech_task is not None:
            await speech_task
        await websocket.send_json({"type": "response.completed", "response_id": response_id, "message_id": completed_message_id})
    finally:
        if speech_task is not None and not speech_task.done():
            speech_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await speech_task
    return answer_parts


async def stream_realtime_speech_on_socket(
    websocket: WebSocket,
    speech_socket,
    synthesize_on_stream,
    text: str,
    response_id: str,
    request_id: int = 0,
    speech_style: dict[str, object] | None = None,
) -> None:
    cleaned = text.strip()
    if not cleaned:
        return
    try:
        await websocket.send_json({"type": "speech.started", "response_id": response_id})
        style = speech_style or {}
        stream_kwargs = {"request_id": request_id}
        if _supports_tts_num_step(synthesize_on_stream):
            stream_kwargs["num_step"] = settings.tts_realtime_num_step
        emotion_vector = style.get("emotion_vector")
        if isinstance(emotion_vector, list) and len(emotion_vector) == 8:
            stream_kwargs["emotion_vector"] = [float(value) for value in emotion_vector]
        async for event in synthesize_on_stream(
            speech_socket,
            cleaned,
            settings.tts_voice,
            float(style.get("speed", 1.0) or 1.0),
            str(style.get("instruct", "")),
            **stream_kwargs,
        ):
            if event.kind == "start":
                await websocket.send_json({
                    "type": "speech.format",
                    "response_id": response_id,
                    "sample_rate": event.sample_rate,
                    "channels": 1,
                    "format": "pcm16",
                })
            elif event.kind == "chunk" and event.audio:
                await websocket.send_bytes(event.audio)
            elif event.kind == "error":
                await websocket.send_json({"type": "speech.error", "response_id": response_id, "message": event.message})
                return
        await websocket.send_json({"type": "speech.completed", "response_id": response_id})
    except Exception as exc:
        await websocket.send_json({"type": "speech.error", "response_id": response_id, "message": str(exc)[:240]})


def _supports_tts_num_step(method) -> bool:
    """Keep older test doubles and third-party providers callable."""
    try:
        parameters = inspect.signature(method).parameters.values()
    except (TypeError, ValueError):
        return False
    return any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD or parameter.name == "num_step"
        for parameter in parameters
    )


async def stream_realtime_speech(
    websocket: WebSocket,
    text: str,
    response_id: str,
    speech_style: dict[str, object] | None = None,
) -> None:
    from .speech.tts import get_tts_provider

    cleaned = text.strip()
    if not cleaned:
        return
    provider = get_tts_provider()
    stream_method = getattr(provider, "synthesize_stream", None)
    if stream_method is None:
        await websocket.send_json({"type": "speech.unavailable", "response_id": response_id, "message": "当前语音服务不支持流式合成"})
        return
    try:
        await websocket.send_json({"type": "speech.started", "response_id": response_id})
        style = speech_style or {}
        stream_kwargs = {}
        if _supports_tts_num_step(stream_method):
            stream_kwargs["num_step"] = settings.tts_realtime_num_step
        emotion_vector = style.get("emotion_vector")
        if isinstance(emotion_vector, list) and len(emotion_vector) == 8:
            stream_kwargs["emotion_vector"] = [float(value) for value in emotion_vector]
        async for event in stream_method(
            cleaned,
            settings.tts_voice,
            float(style.get("speed", 1.0) or 1.0),
            str(style.get("instruct", "")),
            **stream_kwargs,
        ):
            if event.kind == "start":
                await websocket.send_json({
                    "type": "speech.format",
                    "response_id": response_id,
                    "sample_rate": event.sample_rate,
                    "channels": 1,
                    "format": "pcm16",
                })
            elif event.kind == "chunk" and event.audio:
                await websocket.send_bytes(event.audio)
            elif event.kind == "error":
                await websocket.send_json({"type": "speech.error", "response_id": response_id, "message": event.message})
                return
        await websocket.send_json({"type": "speech.completed", "response_id": response_id})
    except Exception as exc:
        await websocket.send_json({"type": "speech.error", "response_id": response_id, "message": str(exc)[:240]})


def stream_model(messages: list[dict[str, str]], max_tokens: int | None = None, realtime: bool = False):
    """Keep test doubles and older providers compatible with the optional limit."""
    if max_tokens is None:
        return stream_chat(messages)
    try:
        parameters = inspect.signature(stream_chat).parameters.values()
    except (TypeError, ValueError):
        return stream_chat(messages)
    supports_limit = any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD or parameter.name in {"max_tokens", "realtime"}
        for parameter in parameters
    )
    if supports_limit:
        return stream_chat(messages, max_tokens=max_tokens, realtime=realtime)
    return stream_chat(messages)


@app.websocket("/api/v1/realtime/{session_id}")
async def realtime_session(websocket: WebSocket, session_id: str):
    await websocket.accept()
    asr_provider = get_asr_provider()
    streaming_asr = getattr(asr_provider, "transcribe_stream", None)
    response_task: asyncio.Task[None] | None = None
    asr_task: asyncio.Task[None] | None = None
    asr_queue: asyncio.Queue[bytes | None] | None = None
    current_turn_id = ""
    legacy_turn_id = ""
    legacy_mime_type = "audio/webm"
    legacy_chunks: list[bytes] = []
    closing = False
    with SessionLocal() as db:
        session = db.get(SessionRecord, session_id)
        if not session:
            await websocket.send_json(realtime_error("session_not_found", "会话不存在"))
            await websocket.close(code=1008)
            return
        if session.mode == "girlfriend" and not get_adult_consent(db).confirmed:
            await websocket.send_json(realtime_error("adult_confirmation_required", "AI 女友模式已锁定"))
            await websocket.close(code=1008)
            return

    async def launch_answer(final_text: str) -> None:
        nonlocal response_task
        cleaned = final_text.strip()
        if closing or not cleaned:
            return
        if response_task and not response_task.done():
            response_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await response_task
        response_id = str(uuid4())

        async def run_answer() -> None:
            try:
                if closing:
                    return
                await stream_realtime_answer(websocket, session_id, cleaned, response_id)
            except asyncio.CancelledError:
                raise
            except Exception:
                with contextlib.suppress(Exception):
                    await websocket.send_json(realtime_error("generation_failed", "模型服务暂时不可用"))

        response_task = asyncio.create_task(run_answer())

    async def run_streaming_asr(queue: asyncio.Queue[bytes | None], turn_id: str) -> None:
        assert streaming_asr is not None
        accepted_final = False
        try:
            async for event in streaming_asr(queue, "zh-CN", settings.asr_realtime_model):
                if event.kind == "partial" and event.text.strip():
                    await websocket.send_json({"type": "transcript.partial", "turn_id": turn_id, "text": event.text.strip()})
                elif event.kind == "final":
                    final_text = event.text.strip()
                    final_kind = getattr(event, "final_kind", "")
                    if accepted_final and final_kind == "summary":
                        continue
                    if final_text and not accepted_final:
                        accepted_final = True
                        await websocket.send_json({"type": "transcript.final", "turn_id": turn_id, "text": final_text})
                        await launch_answer(final_text)
                    elif not final_text and not accepted_final:
                        await websocket.send_json({"type": "transcript.empty", "turn_id": turn_id})
                elif event.kind == "error":
                    await websocket.send_json(realtime_error("asr_stream_failed", event.message))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await websocket.send_json(realtime_error("asr_stream_failed", str(exc)[:240]))

    async def stop_streaming_asr() -> None:
        nonlocal asr_task, asr_queue
        queue = asr_queue
        asr_queue = None
        if queue is not None:
            with contextlib.suppress(Exception):
                await queue.put(None)
        task = asr_task
        asr_task = None
        if task and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    try:
        await websocket.send_json({"type": "session.ready", "session_id": session_id})
        if streaming_asr is not None:
            await websocket.send_json({"type": "asr.stream", "format": "pcm16", "sample_rate": 16000})
        while True:
            incoming = await websocket.receive()
            if incoming.get("type") == "websocket.disconnect":
                raise WebSocketDisconnect()
            if incoming.get("bytes") is not None:
                data = bytes(incoming["bytes"])
                if asr_queue is not None and data:
                    await asr_queue.put(data)
                continue
            raw_text = incoming.get("text") or ""
            if not raw_text:
                continue
            try:
                payload = json.loads(raw_text)
            except json.JSONDecodeError:
                continue
            if not isinstance(payload, dict):
                continue
            message_type = payload.get("type")
            if message_type == "session.end":
                closing = True
                await stop_streaming_asr()
                if response_task and not response_task.done():
                    response_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await response_task
                await websocket.send_json({"type": "session.ended"})
                await websocket.close()
                return
            if message_type == "response.cancel":
                if response_task and not response_task.done():
                    response_task.cancel()
                await websocket.send_json({"type": "response.cancelled", "response_id": payload.get("response_id", "")})
                continue
            if message_type == "turn.start":
                if response_task and not response_task.done():
                    response_task.cancel()
                await stop_streaming_asr()
                current_turn_id = str(uuid4())
                if streaming_asr is not None:
                    asr_queue = asyncio.Queue()
                    asr_task = asyncio.create_task(run_streaming_asr(asr_queue, current_turn_id))
                await websocket.send_json({"type": "transcription.started", "turn_id": current_turn_id})
                continue
            if message_type == "turn.end":
                if asr_queue is not None:
                    await asr_queue.put(None)
                    asr_queue = None
                continue
            if message_type == "audio.chunk":
                if payload.get("turn_id"):
                    legacy_turn_id = str(payload["turn_id"])
                if payload.get("mime_type"):
                    legacy_mime_type = str(payload["mime_type"])
                data = payload.get("data")
                if not isinstance(data, str):
                    await websocket.send_json(realtime_error("invalid_audio", "音频数据无效"))
                    continue
                try:
                    legacy_chunks.append(base64.b64decode(data, validate=True))
                except (binascii.Error, ValueError):
                    await websocket.send_json(realtime_error("invalid_audio", "音频数据无效"))
                continue
            if message_type == "audio.commit":
                turn_id = str(payload.get("turn_id") or legacy_turn_id or uuid4())
                current_turn_id = turn_id
                audio = b"".join(legacy_chunks)
                legacy_chunks = []
                if not audio:
                    await websocket.send_json(realtime_error("empty_audio", "没有收到音频"))
                    continue
                await websocket.send_json({"type": "transcription.started", "turn_id": turn_id})
                mime_type = str(payload.get("mime_type") or legacy_mime_type or "audio/webm")
                language = str(payload.get("language") or "zh-CN")
                try:
                    result = await asr_provider.transcribe(audio, mime_type, language)
                except TranscriptionEmpty:
                    await websocket.send_json(realtime_error("empty_audio", "没有识别到文字"))
                    continue
                except (SpeechProviderNotConfigured, SpeechProviderRejected, SpeechProviderUnavailable) as exc:
                    await websocket.send_json(realtime_error("asr_failed", str(exc)[:240]))
                    continue
                final_text = result.text.strip()
                if not final_text:
                    await websocket.send_json(realtime_error("empty_audio", "没有识别到文字"))
                    continue
                await websocket.send_json({"type": "transcript.final", "turn_id": turn_id, "text": final_text})
                await launch_answer(final_text)
                continue
            await websocket.send_json(realtime_error("unsupported_message", "不支持的实时消息类型"))
    except WebSocketDisconnect:
        pass
    finally:
        await stop_streaming_asr()
        if response_task and not response_task.done():
            response_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await response_task


@app.post("/api/v1/sessions/{session_id}/messages")
async def post_message(session_id: str, payload: MessageCreate, db: Session = Depends(get_db)):
    session = db.get(SessionRecord, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")
    if session.mode == "girlfriend" and not get_adult_consent(db).confirmed:
        raise HTTPException(status_code=403, detail="AI 女友模式已锁定，请先完成成年人确认")
    attachment_ids = list(dict.fromkeys(payload.attachment_ids))
    if len(attachment_ids) > 4:
        raise HTTPException(status_code=422, detail="一条消息最多支持 4 张图片")
    if not payload.content.strip() and not attachment_ids:
        if not payload.regenerate:
            latest = db.scalars(
                select(MessageRecord)
                .where(MessageRecord.session_id == session.id)
                .order_by(MessageRecord.created_at.desc(), MessageRecord.id.desc())
                .limit(1)
            ).first()
            if not latest or latest.role != "user" or latest.content.strip():
                raise HTTPException(status_code=422, detail="消息内容不能为空")
    if attachment_ids:
        available_attachments = db.scalars(
            select(Attachment).where(
                Attachment.id.in_(attachment_ids),
                Attachment.session_id == session.id,
                Attachment.message_id.is_(None),
            )
        ).all()
        if len(available_attachments) != len(attachment_ids):
            raise HTTPException(status_code=409, detail="图片附件已失效或已绑定到其他消息")

    async def events():
        current_task = asyncio.current_task()
        async with get_generation_lock(session.id):
            if current_task:
                session_generation_tasks[session.id] = current_task
            assistant_parts: list[str] = []
            invocation = None
            relationship_judgement_task: asyncio.Task[None] | None = None
            try:
                # Read and write the turn after acquiring the session lock. This
                # keeps concurrent requests from taking the same stale snapshot.
                with SessionLocal() as generation_db:
                    current_session = generation_db.get(SessionRecord, session_id)
                    if not current_session:
                        raise HTTPException(status_code=404, detail="会话不存在")

                    sorted_messages = sorted(current_session.messages, key=lambda row: (row.created_at, row.id))
                    raw_prior_messages = [
                        {"role": message.role, "content": message.content}
                        for message in sorted_messages
                    ]
                    prior_messages = [
                        {
                            "role": message.role,
                            "content": (
                                f"{message.content}\n\n[本轮图片观察]\n"
                                + "\n".join(
                                    f"- {attachment.summary}"
                                    for attachment in message.attachments
                                    if attachment.analysis_status == "ready" and attachment.summary.strip()
                                )
                                if message.attachments
                                and any(
                                    attachment.analysis_status == "ready" and attachment.summary.strip()
                                    for attachment in message.attachments
                                )
                                else message.content
                            ),
                        }
                        for message in sorted_messages
                    ]
                    retrying_incomplete_turn = bool(
                        raw_prior_messages
                        and raw_prior_messages[-1]["role"] == "user"
                        and raw_prior_messages[-1]["content"] == payload.content
                    )
                    regenerating_answer = bool(
                        payload.regenerate
                        and len(raw_prior_messages) >= 2
                        and raw_prior_messages[-2]["role"] == "user"
                        and raw_prior_messages[-2]["content"] == payload.content
                        and raw_prior_messages[-1]["role"] == "assistant"
                    )
                    if regenerating_answer:
                        prior_messages = prior_messages[:-1]
                        retrying_incomplete_turn = True
                    recent_history = trim_history(
                        prior_messages,
                        max_messages=settings.model_realtime_history_messages if payload.realtime else 12,
                    )
                    if payload.realtime:
                        recent_history = compact_realtime_history(
                            recent_history,
                            max_messages=settings.model_realtime_history_messages,
                        )
                    turn_attachments: list[Attachment] = []
                    if not retrying_incomplete_turn:
                        requested_attachments = []
                        if attachment_ids:
                            requested_attachments = generation_db.scalars(
                                select(Attachment).where(
                                    Attachment.id.in_(attachment_ids),
                                    Attachment.session_id == current_session.id,
                                    Attachment.message_id.is_(None),
                                )
                            ).all()
                            if len(requested_attachments) != len(attachment_ids):
                                raise HTTPException(status_code=409, detail="图片附件已失效或已绑定到其他消息")
                        user_message = MessageRecord(session_id=current_session.id, role="user", content=payload.content)
                        generation_db.add(user_message)
                        generation_db.flush()
                        for attachment in requested_attachments:
                            attachment.message_id = user_message.id
                        turn_attachments = requested_attachments
                    else:
                        turn_message = sorted_messages[-2] if regenerating_answer and len(sorted_messages) >= 2 else sorted_messages[-1]
                        turn_attachments = generation_db.scalars(
                            select(Attachment)
                            .where(Attachment.message_id == turn_message.id)
                            .order_by(Attachment.created_at.asc())
                        ).all()
                    if not current_session.messages:
                        title_source = payload.content.strip() or (turn_attachments[0].original_name if turn_attachments else "")
                        current_session.title = title_source[:36] or "图片对话"
                    current_session.updated_at = datetime.now(timezone.utc)
                    generation_db.commit()

                    user_turn_text = payload.content.strip() or "（用户发送了一张图片）"
                    memory_context = build_memory_context(generation_db)
                    specialist_ids = select_specialist_ids(user_turn_text, current_session.mode)
                    candidate = extract_memory_candidate(payload.content) if payload.content.strip() and current_session.mode == "girlfriend" else None
                    profile = get_agent_profile(generation_db)
                    relationship = get_relationship_state(generation_db)
                    relationship_rules = generation_db.scalars(
                        select(RelationshipRule)
                        .where(RelationshipRule.enabled.is_(True))
                        .order_by(RelationshipRule.priority.desc(), RelationshipRule.created_at.asc())
                    ).all()
                    judgement_context = ""
                    agent_memory_context = build_agent_memory_context(generation_db)
                    relationship_history_context = build_relationship_history_context(generation_db)
                    judgement_generation = relationship_judgement_generations.get(session.id, 0)
                    judgement_invocation: SkillInvocation | None = None
                    if current_session.mode == "girlfriend" and not retrying_incomplete_turn and not regenerating_answer:
                        judgement_generation += 1
                        relationship_judgement_generations[session.id] = judgement_generation
                        now = datetime.now(timezone.utc)
                        recover_relationship_over_time(relationship, now)
                        mood_before = relationship.mood
                        yield sse("judgement_started", {"skill_id": "relationship-judgement"})
                        judgement_skill = load_skill("relationship-judgement")
                        custom_effect = match_relationship_rule(payload.content, relationship_rules)
                        # Clear phrases and custom rules are applied immediately.
                        # Ambiguous turns use the local neutral path first; the
                        # expensive contextual model judgement runs in parallel.
                        effect = custom_effect or assess_relationship_effect(payload.content, profile.anger_sensitivity)
                        judgement_invocation = SkillInvocation(
                            session_id=current_session.id,
                            skill_id=judgement_skill.skill_id,
                            skill_version=judgement_skill.version,
                            status="pending" if not custom_effect and not payload.realtime and effect["kind"] == "neutral" else "success",
                        )
                        generation_db.add(judgement_invocation)
                        generation_db.flush()
                        generation_db.commit()
                    if current_session.mode == "girlfriend" and not retrying_incomplete_turn and not regenerating_answer:
                        apply_relationship_effect(
                            generation_db,
                            session_id=current_session.id,
                            user_message=payload.content,
                            relationship=relationship,
                            profile=profile,
                            effect=effect,
                            now=now,
                        )
                        current_state_revision = bump_relationship_state_revision()
                        generation_db.commit()
                        relationship_history_context = build_relationship_history_context(generation_db)
                        if judgement_invocation and judgement_invocation.status == "pending":
                            generation_db.refresh(relationship)
                            relationship_judgement_task = schedule_relationship_judgement(
                                session_id=current_session.id,
                                message_id=str(user_message.id),
                                user_message=user_turn_text,
                                messages=[
                                    {"role": item["role"], "content": item["content"]}
                                    for item in [*recent_history, {"role": "user", "content": user_turn_text}]
                                ],
                                skill_instructions=judgement_skill.instructions,
                                anger_sensitivity=profile.anger_sensitivity,
                                generation=judgement_generation,
                                invocation_id=judgement_invocation.id,
                                state_revision=current_state_revision,
                            )
                        yield sse("judgement_completed", {
                            "skill_id": judgement_skill.skill_id,
                            "version": judgement_skill.version,
                            "mode": "local-fast-path",
                            "background": bool(relationship_judgement_task),
                        })

                    if current_session.mode == "girlfriend":
                        silence_until = relationship.silence_until
                        if silence_until is not None and silence_until.tzinfo is None:
                            silence_until = silence_until.replace(tzinfo=timezone.utc)
                        speech_style = build_speech_style(
                            user_message=user_turn_text,
                            mood=relationship.mood,
                            irritation=relationship.irritation,
                            affection=relationship.affection,
                            trust=relationship.trust,
                            distance=bool(silence_until and silence_until > datetime.now(timezone.utc)),
                            profile_speech_style=profile.speech_style,
                        )
                        yield sse("speech_style", {
                            "name": speech_style.name,
                            "instruct": speech_style.instruct,
                            "speed": speech_style.speed,
                            "emotion_vector": list(speech_style.emotion_vector),
                        })

                    yield sse("skill_started", {"skill_id": "girlfriend-core" if current_session.mode == "girlfriend" else "advisor-dogtoujunshi"})
                    skill, context = build_core_context(
                        payload.content,
                        recent_history,
                        current_session.mode,
                        memory_context,
                        build_profile_context(profile) if current_session.mode == "girlfriend" else "",
                        build_relationship_context(relationship) if current_session.mode == "girlfriend" else "",
                        agent_memory_context if current_session.mode == "girlfriend" else "",
                        relationship_history_context if current_session.mode == "girlfriend" else "",
                        prompt_mode=settings.model_realtime_prompt_mode if payload.realtime else "full",
                    )
                    invocation = SkillInvocation(session_id=current_session.id, skill_id=skill.skill_id, skill_version=skill.version, status="success")
                    generation_db.add(invocation)
                    generation_db.commit()
                    yield sse("skill_completed", {"skill_id": skill.skill_id, "version": skill.version})

                    specialist_context = ""
                    if specialist_ids:
                        for specialist_id in specialist_ids:
                            yield sse("specialist_started", {"skill_id": specialist_id})
                        specialists, specialist_context = load_specialist_context(specialist_ids)
                        for specialist in specialists:
                            generation_db.add(SkillInvocation(session_id=current_session.id, skill_id=specialist.skill_id, skill_version=specialist.version, status="success"))
                        generation_db.commit()
                        yield sse("specialist_completed", {"skill_ids": specialist_ids})
                    if candidate:
                        yield sse("memory_candidate", candidate)

                    current_image_context = "\n".join(
                        f"- {attachment.summary}"
                        for attachment in turn_attachments
                        if attachment.analysis_status == "ready" and attachment.summary.strip()
                    )
                    if current_image_context:
                        image_instruction = (
                            "本轮用户上传了图片。只能根据以下图片观察回答，不要声称看见了图片中无法确认的细节，"
                            "也不要把这些观察自动写成长期记忆。\n"
                            f"{current_image_context}"
                        )
                    else:
                        image_instruction = ""
                    messages = [
                        {"role": "system", "content": f"{context}\n\n{judgement_context}\n\n{specialist_context}\n\n{image_instruction}"},
                        *recent_history,
                        {"role": "user", "content": payload.content.strip() or "请看这张图片。"},
                    ]
                    attempts = 2 if payload.realtime else 1
                    for attempt in range(attempts):
                        try:
                            async for token in stream_model(
                                messages,
                                max_tokens=settings.model_realtime_max_tokens if payload.realtime else None,
                                realtime=payload.realtime,
                            ):
                                assistant_parts.append(token)
                                yield sse("token", {"text": token})
                        except ModelEmptyResponse:
                            if assistant_parts or attempt + 1 >= attempts:
                                raise
                            yield sse("model_retry", {"attempt": attempt + 1})
                            continue
                        if assistant_parts or attempt + 1 >= attempts:
                            break
                        # A live call should not die on one provider-side empty
                        # completion. Retry the same grounded context once.
                        yield sse("model_retry", {"attempt": attempt + 1})
                    if not assistant_parts:
                        raise RuntimeError("模型返回了空回答")

                    if regenerating_answer:
                        previous_assistant = sorted(current_session.messages, key=lambda row: (row.created_at, row.id))[-1]
                        previous_assistant.content = "".join(assistant_parts)
                    else:
                        generation_db.add(MessageRecord(session_id=current_session.id, role="assistant", content="".join(assistant_parts)))
                    if not regenerating_answer:
                        mark_initiative_window_used(profile, datetime.now(timezone.utc))
                    current_session.updated_at = datetime.now(timezone.utc)
                    generation_db.commit()
                # Fast test doubles and very quick providers can finish the
                # background judgement before the response closes. In normal
                # use a slow judgement remains detached and never delays done.
                if relationship_judgement_task and not relationship_judgement_task.done():
                    await asyncio.sleep(0)
                if relationship_judgement_task and relationship_judgement_task.done():
                    with contextlib.suppress(asyncio.CancelledError):
                        await relationship_judgement_task
                yield sse("done", {"message_id": str(uuid4())})
            except ModelNotConfigured as exc:
                yield sse("error", {"code": "model_not_configured", "message": str(exc)})
            except ModelProviderUnavailable as exc:
                yield sse("error", {"code": "model_unavailable", "message": str(exc)})
            except ModelProviderRejected as exc:
                yield sse("error", {"code": "model_rejected", "message": str(exc)})
            except ModelStreamInterrupted as exc:
                yield sse("error", {"code": "model_stream_interrupted", "message": str(exc)})
            except ModelEmptyResponse as exc:
                yield sse("error", {"code": "model_empty_response", "message": str(exc)})
            except Exception as exc:
                if invocation:
                    with SessionLocal() as failure_db:
                        failed_invocation = failure_db.get(SkillInvocation, invocation.id)
                        if failed_invocation:
                            failed_invocation.status = "failed"
                            failure_db.commit()
                message = "模型服务暂时不可用，请检查配置后重试。"
                if isinstance(exc, FileNotFoundError):
                    message = "必需的核心 Skill 未安装，本次回答已停止。"
                yield sse("error", {"code": "generation_failed", "message": message})
            finally:
                if current_task and session_generation_tasks.get(session.id) is current_task:
                    session_generation_tasks.pop(session.id, None)

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
