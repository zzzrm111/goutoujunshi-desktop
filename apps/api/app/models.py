from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


class SessionRecord(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    title: Mapped[str] = mapped_column(String(120), default="新的对话")
    mode: Mapped[str] = mapped_column(String(32), default="girlfriend")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    messages: Mapped[list["MessageRecord"]] = relationship(back_populates="session", cascade="all, delete-orphan")


class MessageRecord(Base):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    session: Mapped[SessionRecord] = relationship(back_populates="messages")
    attachments: Mapped[list["Attachment"]] = relationship(back_populates="message", cascade="all, delete-orphan")


class Attachment(Base):
    __tablename__ = "attachments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"), index=True)
    message_id: Mapped[str | None] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE"), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(20), default="image")
    original_name: Mapped[str] = mapped_column(String(255), default="")
    stored_name: Mapped[str] = mapped_column(String(255))
    mime_type: Mapped[str] = mapped_column(String(80))
    size: Mapped[int] = mapped_column(Integer)
    analysis_status: Mapped[str] = mapped_column(String(20), default="pending")
    summary: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    message: Mapped[MessageRecord | None] = relationship(back_populates="attachments")


class SkillInvocation(Base):
    __tablename__ = "skill_invocations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    session_id: Mapped[str] = mapped_column(String(36), index=True)
    skill_id: Mapped[str] = mapped_column(String(100))
    skill_version: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class MemoryConsent(Base):
    __tablename__ = "memory_consent"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default="local-user")
    allowed: Mapped[bool] = mapped_column(Boolean, default=False)
    paused: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class MemoryRecord(Base):
    __tablename__ = "memory_records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    kind: Mapped[str] = mapped_column(String(40), default="user_fact")
    content: Mapped[str] = mapped_column(String(200))
    source_session_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class MemoryOperation(Base):
    __tablename__ = "memory_operations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    memory_id: Mapped[str] = mapped_column(String(36), index=True)
    operation: Mapped[str] = mapped_column(String(20))
    previous_content: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class AdultConsent(Base):
    __tablename__ = "adult_consent"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default="local-user")
    confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class AgentProfile(Base):
    __tablename__ = "agent_profile"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default="local-agent")
    display_name: Mapped[str] = mapped_column(String(40), default="小满")
    personality: Mapped[str] = mapped_column(Text, default="温柔、俏皮，有自己的主见，偶尔会嘴硬")
    background: Mapped[str] = mapped_column(Text, default="喜欢在安静的时候读书、听歌和整理自己的想法")
    interests: Mapped[str] = mapped_column(Text, default="音乐、散步、电影、随手记录生活")
    boundaries: Mapped[str] = mapped_column(Text, default="不接受羞辱、威胁、欺骗和被命令式对待")
    speech_style: Mapped[str] = mapped_column(Text, default="自然、口语化、短句，有情绪但不夸张")
    inner_mood: Mapped[str] = mapped_column(String(80), default="有点懒散，但心情还不错")
    current_focus: Mapped[str] = mapped_column(Text, default="")
    recent_plan: Mapped[str] = mapped_column(Text, default="")
    avoid_topics: Mapped[str] = mapped_column(Text, default="")
    autonomy_level: Mapped[int] = mapped_column(Integer, default=4)
    initiative_level: Mapped[int] = mapped_column(Integer, default=3)
    initiative_cooldown_minutes: Mapped[int] = mapped_column(Integer, default=30)
    last_initiative_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    anger_sensitivity: Mapped[int] = mapped_column(Integer, default=3)
    silent_duration_minutes: Mapped[int] = mapped_column(Integer, default=30)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class RelationshipState(Base):
    __tablename__ = "relationship_state"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default="local-relationship")
    mood: Mapped[str] = mapped_column(String(40), default="平静")
    trust: Mapped[int] = mapped_column(Integer, default=50)
    affection: Mapped[int] = mapped_column(Integer, default=50)
    irritation: Mapped[int] = mapped_column(Integer, default=0)
    conflict_count: Mapped[int] = mapped_column(Integer, default=0)
    silence_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_trigger: Mapped[str] = mapped_column(String(200), default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class RelationshipRule(Base):
    __tablename__ = "relationship_rules"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    name: Mapped[str] = mapped_column(String(80))
    match_text: Mapped[str] = mapped_column(String(200))
    event_type: Mapped[str] = mapped_column(String(40), default="custom")
    trigger: Mapped[str] = mapped_column(String(200), default="自定义关系规则命中")
    trust_delta: Mapped[int] = mapped_column(Integer, default=0)
    affection_delta: Mapped[int] = mapped_column(Integer, default=0)
    irritation_delta: Mapped[int] = mapped_column(Integer, default=0)
    needs_distance: Mapped[bool] = mapped_column(Boolean, default=False)
    silence_minutes: Mapped[int] = mapped_column(Integer, default=0)
    priority: Mapped[int] = mapped_column(Integer, default=50)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class AgentMemory(Base):
    __tablename__ = "agent_memories"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    kind: Mapped[str] = mapped_column(String(40), default="self_fact")
    content: Mapped[str] = mapped_column(String(300))
    source: Mapped[str] = mapped_column(String(30), default="agent")
    importance: Mapped[int] = mapped_column(Integer, default=3)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class RelationshipEvent(Base):
    __tablename__ = "relationship_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    session_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    event_type: Mapped[str] = mapped_column(String(40))
    trigger: Mapped[str] = mapped_column(String(200))
    user_message: Mapped[str] = mapped_column(Text)
    mood_before: Mapped[str] = mapped_column(String(40))
    mood_after: Mapped[str] = mapped_column(String(40))
    trust_delta: Mapped[int] = mapped_column(Integer, default=0)
    affection_delta: Mapped[int] = mapped_column(Integer, default=0)
    irritation_delta: Mapped[int] = mapped_column(Integer, default=0)
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)
    resolution_note: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
