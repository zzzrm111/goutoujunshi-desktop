"""Add message-bound multimodal attachments.

Revision ID: 20261011_0003
Revises: 20261011_0002
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261011_0003"
down_revision: Union[str, Sequence[str], None] = "20261011_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(name: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(name)


def _has_index(table_name: str, index_name: str) -> bool:
    return index_name in {index["name"] for index in sa.inspect(op.get_bind()).get_indexes(table_name)}


def upgrade() -> None:
    if not _has_table("attachments"):
        op.create_table(
            "attachments",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("session_id", sa.String(36), sa.ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False),
            sa.Column("message_id", sa.String(36), sa.ForeignKey("messages.id", ondelete="CASCADE"), nullable=True),
            sa.Column("kind", sa.String(20), nullable=False, server_default="image"),
            sa.Column("original_name", sa.String(255), nullable=False, server_default=""),
            sa.Column("stored_name", sa.String(255), nullable=False),
            sa.Column("mime_type", sa.String(80), nullable=False),
            sa.Column("size", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("analysis_status", sa.String(20), nullable=False, server_default="pending"),
            sa.Column("summary", sa.Text(), nullable=False, server_default=""),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
    if not _has_index("attachments", "ix_attachments_session_id"):
        op.create_index("ix_attachments_session_id", "attachments", ["session_id"])
    if not _has_index("attachments", "ix_attachments_message_id"):
        op.create_index("ix_attachments_message_id", "attachments", ["message_id"])


def downgrade() -> None:
    op.drop_index("ix_attachments_message_id", table_name="attachments")
    op.drop_index("ix_attachments_session_id", table_name="attachments")
    op.drop_table("attachments")
