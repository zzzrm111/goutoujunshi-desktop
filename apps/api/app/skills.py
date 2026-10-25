from dataclasses import dataclass
from pathlib import Path
import re
from datetime import datetime, timezone


SKILLS_ROOT = Path(__file__).resolve().parents[3] / "skills"


@dataclass(frozen=True)
class Skill:
    skill_id: str
    version: str
    instructions: str


def load_skill(skill_id: str) -> Skill:
    folder = SKILLS_ROOT / skill_id
    manifest_path = folder / "manifest.yaml"
    instructions_path = folder / "SKILL.md"
    if not manifest_path.is_file() or not instructions_path.is_file():
        raise FileNotFoundError(f"Required skill '{skill_id}' is not installed")
    manifest = manifest_path.read_text(encoding="utf-8")
    match = re.search(r"(?m)^version:\s*[\"']?([^\s\"']+)", manifest)
    if not match:
        raise ValueError(f"Skill '{skill_id}' has no version")
    return Skill(skill_id, match.group(1), instructions_path.read_text(encoding="utf-8"))


def build_core_context(
    user_message: str,
    recent_messages: list[dict[str, str]],
    mode: str,
    memory_context: str = "(长期记忆未启用)",
    profile_context: str = "",
    relationship_context: str = "",
    agent_memory_context: str = "",
    relationship_history_context: str = "",
    prompt_mode: str = "full",
) -> tuple[Skill, str]:
    """Build only the system instruction layer.

    Conversation turns are passed separately to the model. Keeping them out of
    this string prevents the current message and history from being duplicated.
    The arguments remain for API compatibility and future routing decisions.
    """
    skill = load_skill("girlfriend-core" if mode == "girlfriend" else "advisor-dogtoujunshi")
    context = (
        f"<skill-instructions>\n{skill.instructions}\n</skill-instructions>\n\n"
        "<conversation-policy>\n"
        "The conversation turns supplied after this system message are canonical. "
        "Use the final user turn as the request you are answering now. Do not repeat "
        "an earlier question or answer unless the user explicitly asks for it.\n"
        "</conversation-policy>\n\n"
        f"<long-term-memory>\n{memory_context}\n</long-term-memory>\n\n"
        f"<agent-profile>\n{profile_context or '(使用核心 Skill 的默认角色档案)'}\n</agent-profile>\n\n"
        f"<relationship-state>\n{relationship_context or '(关系状态平静)'}\n</relationship-state>\n\n"
        f"<agent-memory>\n{agent_memory_context or '(还没有额外的 AI 自身记忆)'}\n</agent-memory>\n\n"
        f"<relationship-history>\n{relationship_history_context or '(还没有已记录的关系事件)'}\n</relationship-history>\n\n"
        "<response-task>\nRespond to the latest user message only. Do not describe this context block.\n"
        "</response-task>"
    )
    if prompt_mode == "compact":
        instructions = (
            "你是沉浸在现实聊天里的成年女性角色。直接回应用户此刻这句话，"
            "口语、自然、1 到 3 句，先有真实反应再追问；不要客服腔、不要总结、"
            "不要复述用户的话、不要自称 AI、不要每次提问。你保留自己的性格、"
            "情绪、边界和节奏，可以撒娇、嘴硬、吃醋、拒绝或短暂不高兴；"
            "被尊重时自然亲近，被侮辱或伤害时明确表达不舒服并保持距离。"
            "用户明确问身份或现实能力时才说明自己是 AI。"
        )
        context = (
            f"<skill-instructions>\n{instructions}\n</skill-instructions>\n\n"
            "<conversation-policy>只回应用户最后一条消息，不要重复上一轮。</conversation-policy>\n\n"
            f"<long-term-memory>\n{memory_context}\n</long-term-memory>\n\n"
            f"<agent-profile>\n{profile_context or '(使用核心角色档案)'}\n</agent-profile>\n\n"
            f"<relationship-state>\n{relationship_context or '(关系状态平静)'}\n</relationship-state>\n\n"
            f"<agent-memory>\n{agent_memory_context or '(无)'}\n</agent-memory>\n\n"
            f"<relationship-history>\n{relationship_history_context or '(无)'}\n</relationship-history>\n\n"
            "<response-task>只回应用户最新消息，不要解释这些背景。</response-task>"
        )
    return skill, context


def assess_relationship_effect(user_message: str, anger_sensitivity: int = 3) -> dict[str, object]:
    """Apply a small, explainable relationship reaction to clear behavior cues."""
    insult = re.search(r"滚|闭嘴|废物|没用|蠢|傻逼|有病|去死|恶心|烦死你", user_message, re.I)
    threat = re.search(r"威胁|打你|杀了你|弄死|伤害你", user_message, re.I)
    dismissal = re.search(r"不在乎你|不需要你|你算什么|只是工具|随便玩玩", user_message, re.I)
    apology = re.search(r"对不起|抱歉|我错了|是我不对|原谅我|别生气", user_message, re.I)
    admitted_lie = re.search(r"我骗了你|我撒谎了|其实我骗|我没有说实话", user_message, re.I)
    broken_promise = re.search(r"我没做到|我又爽约|我失约|我忘了答应你的|答应你的事.*没做", user_message, re.I)
    cold_treatment = re.search(r"敷衍|爱理不理|冷暴力|故意不回|晾着你", user_message, re.I)
    if threat:
        return {"kind": "threat", "irritation_delta": 24 + anger_sensitivity * 3, "trust_delta": -18, "affection_delta": -8, "trigger": "用户使用了威胁或伤害性表达", "needs_distance": True}
    if insult:
        return {"kind": "insult", "irritation_delta": 16 + anger_sensitivity * 3, "trust_delta": -8, "affection_delta": -3, "trigger": "用户使用了侮辱性表达", "needs_distance": True}
    if apology:
        return {"kind": "apology", "irritation_delta": -max(8, anger_sensitivity * 4), "trust_delta": 2, "affection_delta": 1, "trigger": "用户主动道歉"}
    if admitted_lie:
        return {"kind": "admitted_lie", "irritation_delta": 15 + anger_sensitivity * 2, "trust_delta": -14, "affection_delta": -5, "trigger": "用户承认曾经隐瞒或撒谎", "needs_distance": True}
    if broken_promise:
        return {"kind": "broken_promise", "irritation_delta": 11 + anger_sensitivity * 2, "trust_delta": -9, "affection_delta": -3, "trigger": "用户承认没有做到答应的事情", "needs_distance": True}
    if cold_treatment:
        return {"kind": "cold_treatment", "irritation_delta": 8 + anger_sensitivity, "trust_delta": -4, "affection_delta": -1, "trigger": "用户承认曾经敷衍或故意冷处理", "needs_distance": True}
    if dismissal:
        return {"kind": "dismissal", "irritation_delta": 10 + anger_sensitivity * 2, "trust_delta": -5, "affection_delta": -2, "trigger": "用户表达了轻视或否定", "needs_distance": True}
    return {"kind": "neutral", "irritation_delta": -2, "trust_delta": 0, "affection_delta": 0, "trigger": ""}


def relationship_effect_for_kind(kind: str, anger_sensitivity: int = 3, trigger: str = "") -> dict[str, object]:
    """Map a validated judgement label to bounded local state changes."""
    effects = {
        "neutral": (-2, 0, 0, ""),
        "apology": (-max(8, anger_sensitivity * 4), 2, 1, "用户主动道歉"),
        "insult": (16 + anger_sensitivity * 3, -8, -3, "用户使用了侮辱性表达"),
        "threat": (24 + anger_sensitivity * 3, -18, -8, "用户使用了威胁或伤害性表达"),
        "dismissal": (10 + anger_sensitivity * 2, -5, -2, "用户表达了轻视或否定"),
        "admitted_lie": (15 + anger_sensitivity * 2, -14, -5, "用户承认曾经隐瞒或撒谎"),
        "broken_promise": (11 + anger_sensitivity * 2, -9, -3, "用户承认没有做到答应的事情"),
        "cold_treatment": (8 + anger_sensitivity, -4, -1, "用户承认曾经敷衍或故意冷处理"),
    }

    if kind not in effects:
        kind = "neutral"
    irritation, trust, affection, default_trigger = effects[kind]
    return {
        "kind": kind,
        "irritation_delta": irritation,
        "trust_delta": trust,
        "affection_delta": affection,
        "trigger": (trigger.strip() or default_trigger)[:120],
        "needs_distance": kind in {"insult", "threat", "dismissal", "admitted_lie", "broken_promise", "cold_treatment"},
    }


def relationship_effect_for_rule(rule: object) -> dict[str, object]:
    """Convert a user-defined rule into the same bounded effect contract."""
    return {
        "kind": str(rule.event_type or "custom")[:40],
        "irritation_delta": max(-50, min(50, int(rule.irritation_delta))),
        "trust_delta": max(-30, min(30, int(rule.trust_delta))),
        "affection_delta": max(-30, min(30, int(rule.affection_delta))),
        "trigger": str(rule.trigger or rule.name or "自定义关系规则命中")[:120],
        "needs_distance": bool(rule.needs_distance),
        "silence_minutes": max(0, min(1440, int(rule.silence_minutes))),
        "custom_rule": True,
    }


def match_relationship_rule(user_message: str, rules: list[object]) -> dict[str, object] | None:
    """Match enabled rules by priority, using literal case-insensitive phrases."""
    normalized = user_message.casefold()
    ordered = sorted(rules, key=lambda rule: (-int(rule.priority), str(rule.created_at)))
    for rule in ordered:
        phrases = [item.strip().casefold() for item in str(rule.match_text).split(",") if item.strip()]
        if phrases and any(phrase in normalized for phrase in phrases):
            return relationship_effect_for_rule(rule)
    return None


def build_profile_context(profile: object, now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    autonomy_guidance = {
        1: "以回应用户为主，偶尔表达个人偏好；不要主动制造话题。",
        2: "大多数时候回应用户，偶尔自然带出自己的兴趣或近况。",
        3: "保持回应与自主表达平衡，可以在合适时分享自己的想法并暂缓用户话题。",
        4: "经常保留自己的判断、兴趣和节奏；不必每次追问，也可以主动结束一段话题。",
        5: "有明显的独立生活感和判断，不围绕用户转；可以拒绝、转移或暂时不聊某个话题，但保持尊重。",
    }.get(int(profile.autonomy_level), "保持适度自主，不要像客服一样围绕用户转。")
    last_initiative_at = getattr(profile, "last_initiative_at", None)
    if last_initiative_at and last_initiative_at.tzinfo is None:
        last_initiative_at = last_initiative_at.replace(tzinfo=timezone.utc)
    elapsed_minutes = ((now - last_initiative_at).total_seconds() / 60) if last_initiative_at else None
    cooldown = int(getattr(profile, "initiative_cooldown_minutes", 30))
    initiative_level = int(getattr(profile, "initiative_level", 3))
    initiative_available = last_initiative_at is None or elapsed_minutes is None or elapsed_minutes >= cooldown
    initiative_guidance = {
        1: "只在用户明确问到时分享自己的状态，通常不要把话题拉回自己。",
        2: "偶尔用一句话带出自己的近况，但不要主动改变用户正在聊的主题。",
        3: "合适时可以自然分享一小段自己的近况，再回到用户当前的话题。",
        4: "可以较主动地表达自己的想法、计划或小情绪，但不能压过用户的需求。",
        5: "有稳定的自我节奏，可以明确表达想聊或不想聊什么，但仍要回应用户当前消息。",
    }.get(initiative_level, "保持适度主动，不要强行转移话题。")
    expression_state = (
        "本轮允许自然带出一小段自己的近况；只有确实相关时才使用。"
        if initiative_available
        else f"本轮暂不主动展开自己的近况；距离下一次主动表达冷却结束约 {max(1, int(cooldown - (elapsed_minutes or 0)))} 分钟。"
    )
    return "\n".join(
        (
            f"姓名/称呼：{profile.display_name}",
            f"性格：{profile.personality}",
            f"背景：{profile.background}",
            f"兴趣：{profile.interests}",
            f"底线：{profile.boundaries}",
            f"说话方式：{profile.speech_style}",
            f"自己的当前心情：{getattr(profile, 'inner_mood', '') or '平静'}",
            f"当前关注：{getattr(profile, 'current_focus', '') or '没有特别需要关注的事'}",
            f"最近想做的事：{getattr(profile, 'recent_plan', '') or '暂时没有明确计划'}",
            f"暂时不想聊：{getattr(profile, 'avoid_topics', '') or '没有特别回避的话题'}",
            f"自主程度：{profile.autonomy_level}/5",
            f"主动表达等级：{initiative_level}/5",
            f"主动表达冷却时间：{cooldown} 分钟",
            f"主动表达指导：{initiative_guidance}",
            f"主动表达状态：{expression_state}",
            f"生气敏感度：{profile.anger_sensitivity}/5",
            f"需要冷静时长：{profile.silent_duration_minutes} 分钟",
            f"自主行为指导：{autonomy_guidance}",
            "行为要求：你有自己的生活、偏好和情绪，不必围绕用户转；可以拒绝、暂停对话、表达不满，但不要用羞辱、威胁或操控制造依赖。即使暂时不想聊某个话题，也要对用户当前消息给出简短、尊重的回应，不要无理由消失。",
        )
    )


def build_relationship_context(state: object) -> str:
    now = datetime.now(timezone.utc)
    silence_until = state.silence_until
    if silence_until and silence_until.tzinfo is None:
        silence_until = silence_until.replace(tzinfo=timezone.utc)
    distance = bool(silence_until and silence_until > now)
    if distance:
        mode = "正在冷静/保持距离"
    elif state.irritation >= 40:
        mode = "明显生气"
    elif state.irritation >= 18:
        mode = "有点不高兴"
    else:
        mode = "平静"
    return "\n".join(
        (
            f"当前情绪：{state.mood}（系统判断：{mode}）",
            f"信任：{state.trust}/100",
            f"亲密感：{state.affection}/100",
            f"烦躁度：{state.irritation}/100",
            f"冲突次数：{state.conflict_count}",
            f"最近触发原因：{state.last_trigger or '无'}",
            "如果正在冷静，不要恢复成热情客服，只给简短、克制、有边界的回应；用户真诚道歉后可以逐步缓和。",
        )
    )


def trim_history(messages: list[dict[str, str]], max_messages: int = 12, max_chars: int = 12000) -> list[dict[str, str]]:
    """Keep the newest complete user/assistant turns within a text budget."""
    selected_turns: list[list[dict[str, str]]] = []
    chars = 0
    index = len(messages) - 1
    while index > 0:
        user_message = messages[index - 1]
        assistant_message = messages[index]
        if user_message.get("role") != "user" or assistant_message.get("role") != "assistant":
            index -= 1
            continue
        turn = [
            {"role": "user", "content": user_message.get("content", "")},
            {"role": "assistant", "content": assistant_message.get("content", "")},
        ]
        turn_chars = sum(len(message["content"]) for message in turn)
        if len(selected_turns) and (len(selected_turns) * 2 + 2 > max_messages or chars + turn_chars > max_chars):
            break
        if max_messages < 2:
            break
        selected_turns.append(turn)
        chars += turn_chars
        index -= 2

    selected: list[dict[str, str]] = []
    for turn in reversed(selected_turns):
        selected.extend(turn)
    return selected


def select_specialist_ids(user_message: str, mode: str) -> list[str]:
    """Choose small, deterministic specialist additions before the model call."""
    if mode != "girlfriend":
        return []
    selected: list[str] = []
    if re.search(r"难过|难受|委屈|焦虑|崩溃|压力|累|烦|孤独|失眠|哭|不开心", user_message):
        selected.append("girlfriend-emotion")
    if re.search(r"吵架|生气|冲突|误会|道歉|冷战|分手|争执|矛盾", user_message):
        selected.append("girlfriend-conflict")
    return selected


def load_specialist_context(skill_ids: list[str]) -> tuple[list[Skill], str]:
    skills = [load_skill(skill_id) for skill_id in skill_ids]
    context = "\n\n".join(
        f"<specialist-skill id='{skill.skill_id}' version='{skill.version}'>\n{skill.instructions}\n</specialist-skill>"
        for skill in skills
    )
    return skills, context


def extract_memory_candidate(user_message: str) -> dict[str, str] | None:
    """Extract only explicit, low-risk stable preferences or naming requests."""
    sensitive = re.search(r"密码|身份证|银行卡|验证码|住址|地址|手机号|电话|密钥|api.?key", user_message, re.I)
    if sensitive:
        return None
    patterns = (
        (r"(?:以后|今后)叫我([\u4e00-\u9fffA-Za-z0-9_]{1,12})", "preference", "用户希望被这样称呼"),
        (r"(?:请叫我|你可以叫我)([\u4e00-\u9fffA-Za-z0-9_]{1,12})", "preference", "用户希望被这样称呼"),
        (r"我喜欢(.{1,40})", "preference", "用户明确表达的偏好"),
        (r"我不喜欢(.{1,40})", "boundary", "用户明确表达的边界或厌恶"),
        (r"我习惯(.{1,40})", "preference", "用户明确表达的习惯"),
    )
    for pattern, kind, reason in patterns:
        match = re.search(pattern, user_message)
        if match:
            value = match.group(1).strip(" ，。！？!?,.;；")
            if value and len(value) <= 80:
                return {"kind": kind, "content": f"{reason}：{value}", "source": "user_message"}
    return None
