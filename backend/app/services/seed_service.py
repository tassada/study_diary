from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..config import settings
from ..models import ChildModel
from ..providers.dsh_agent import ensure_child_agent_files


async def seed_builtin_children(db: AsyncSession) -> None:
    builtin_id = settings.default_child_id.strip() or "child_demo"
    res = await db.execute(select(ChildModel).where(ChildModel.id == builtin_id))
    existing = res.scalar_one_or_none()
    if existing is None:
        any_res = await db.execute(select(ChildModel).limit(1))
        first_any = any_res.scalar_one_or_none()
        if first_any is not None:
            ensure_child_agent_files(first_any)
            return
        profile = ChildModel(
            id=builtin_id,
            display_name=settings.default_child_name,
            birth_date=settings.default_child_birth_date,
            gender=settings.default_child_gender,
            age=settings.default_child_age,
            grade_label=settings.default_child_grade,
            title_badge=f"星莓魔法学院 · {settings.default_child_grade}星仙子",
            avatar_key="duoduo",
            theme_pink="#EC5F9B",
            daily_goal_minutes=75,
            star_coins=120,
        )
        db.add(profile)
        await db.commit()
        await db.refresh(profile)
        ensure_child_agent_files(profile)
    else:
        ensure_child_agent_files(existing)
