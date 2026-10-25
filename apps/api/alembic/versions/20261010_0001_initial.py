"""Create the single-user companion schema.

Revision ID: 20261010_0001
Revises:
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261010_0001"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "sessions",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("mode", sa.String(32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "messages",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("session_id", sa.String(36), nullable=False),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_messages_session_id", "messages", ["session_id"])
    op.create_table(
        "skill_invocations",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("session_id", sa.String(36), nullable=False),
        sa.Column("skill_id", sa.String(100), nullable=False),
        sa.Column("skill_version", sa.String(40), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_skill_invocations_session_id", "skill_invocations", ["session_id"])
    op.create_table(
        "memory_consent",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("allowed", sa.Boolean(), nullable=False),
        sa.Column("paused", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "memory_records",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("kind", sa.String(40), nullable=False),
        sa.Column("content", sa.String(200), nullable=False),
        sa.Column("source_session_id", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "memory_operations",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("memory_id", sa.String(36), nullable=False),
        sa.Column("operation", sa.String(20), nullable=False),
        sa.Column("previous_content", sa.String(200), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_memory_operations_memory_id", "memory_operations", ["memory_id"])
    op.create_table(
        "adult_consent",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("confirmed", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "agent_profile",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("display_name", sa.String(40), nullable=False),
        sa.Column("personality", sa.Text(), nullable=False),
        sa.Column("background", sa.Text(), nullable=False),
        sa.Column("interests", sa.Text(), nullable=False),
        sa.Column("boundaries", sa.Text(), nullable=False),
        sa.Column("speech_style", sa.Text(), nullable=False),
        sa.Column("autonomy_level", sa.Integer(), nullable=False),
        sa.Column("anger_sensitivity", sa.Integer(), nullable=False),
        sa.Column("silent_duration_minutes", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "relationship_state",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("mood", sa.String(40), nullable=False),
        sa.Column("trust", sa.Integer(), nullable=False),
        sa.Column("affection", sa.Integer(), nullable=False),
        sa.Column("irritation", sa.Integer(), nullable=False),
        sa.Column("conflict_count", sa.Integer(), nullable=False),
        sa.Column("silence_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_trigger", sa.String(200), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "agent_memories",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("kind", sa.String(40), nullable=False),
        sa.Column("content", sa.String(300), nullable=False),
        sa.Column("source", sa.String(30), nullable=False),
        sa.Column("importance", sa.Integer(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "relationship_rules",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("match_text", sa.String(200), nullable=False),
        sa.Column("event_type", sa.String(40), nullable=False),
        sa.Column("trigger", sa.String(200), nullable=False),
        sa.Column("trust_delta", sa.Integer(), nullable=False),
        sa.Column("affection_delta", sa.Integer(), nullable=False),
        sa.Column("irritation_delta", sa.Integer(), nullable=False),
        sa.Column("needs_distance", sa.Boolean(), nullable=False),
        sa.Column("silence_minutes", sa.Integer(), nullable=False),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "relationship_events",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("session_id", sa.String(36), nullable=True),
        sa.Column("event_type", sa.String(40), nullable=False),
        sa.Column("trigger", sa.String(200), nullable=False),
        sa.Column("user_message", sa.Text(), nullable=False),
        sa.Column("mood_before", sa.String(40), nullable=False),
        sa.Column("mood_after", sa.String(40), nullable=False),
        sa.Column("trust_delta", sa.Integer(), nullable=False),
        sa.Column("affection_delta", sa.Integer(), nullable=False),
        sa.Column("irritation_delta", sa.Integer(), nullable=False),
        sa.Column("resolved", sa.Boolean(), nullable=False),
        sa.Column("resolution_note", sa.String(300), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_relationship_events_session_id", "relationship_events", ["session_id"])


def downgrade() -> None:
    op.drop_index("ix_relationship_events_session_id", table_name="relationship_events")
    op.drop_table("relationship_events")
    op.drop_table("relationship_rules")
    op.drop_table("agent_memories")
    op.drop_index("ix_memory_operations_memory_id", table_name="memory_operations")
    op.drop_table("memory_operations")
    op.drop_table("relationship_state")
    op.drop_table("agent_profile")
    op.drop_table("adult_consent")
    op.drop_table("memory_records")
    op.drop_index("ix_skill_invocations_session_id", table_name="skill_invocations")
    op.drop_table("skill_invocations")
    op.drop_index("ix_messages_session_id", table_name="messages")
    op.drop_table("messages")
    op.drop_table("memory_consent")
    op.drop_table("sessions")
