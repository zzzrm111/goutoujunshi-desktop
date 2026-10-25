"""Add configurable agent autonomy state.

Revision ID: 20261011_0002
Revises: 20261010_0001
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261011_0002"
down_revision: Union[str, Sequence[str], None] = "20261010_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("agent_profile", sa.Column("inner_mood", sa.String(80), nullable=False, server_default="有点懒散，但心情还不错"))
    op.add_column("agent_profile", sa.Column("current_focus", sa.Text(), nullable=False, server_default=""))
    op.add_column("agent_profile", sa.Column("recent_plan", sa.Text(), nullable=False, server_default=""))
    op.add_column("agent_profile", sa.Column("avoid_topics", sa.Text(), nullable=False, server_default=""))
    op.add_column("agent_profile", sa.Column("initiative_level", sa.Integer(), nullable=False, server_default="3"))
    op.add_column("agent_profile", sa.Column("initiative_cooldown_minutes", sa.Integer(), nullable=False, server_default="30"))
    op.add_column("agent_profile", sa.Column("last_initiative_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("agent_profile", "last_initiative_at")
    op.drop_column("agent_profile", "initiative_cooldown_minutes")
    op.drop_column("agent_profile", "initiative_level")
    op.drop_column("agent_profile", "avoid_topics")
    op.drop_column("agent_profile", "recent_plan")
    op.drop_column("agent_profile", "current_focus")
    op.drop_column("agent_profile", "inner_mood")
