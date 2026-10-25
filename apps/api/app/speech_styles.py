"""Turn relationship and conversation context into a TTS delivery direction.

The language model decides *what* the character says. This module only
decides *how* the finished text should be spoken. Keeping it deterministic
also keeps the voice fast, testable, and consistent across short TTS chunks.
"""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class SpeechStyle:
    """One bounded delivery instruction shared by every TTS chunk in a turn."""

    name: str
    instruct: str
    speed: float = 1.0
    # IndexTTS2 order:
    # [happy, angry, sad, afraid, disgusted, melancholic, surprised, calm]
    emotion_vector: tuple[float, ...] = ()


_USER_SAD = re.compile(
    r"难过|难受|委屈|焦虑|崩溃|压力|好累|很累|孤独|失眠|想哭|哭了|不开心|"
    r"烦死了|撑不住|害怕|担心|被欺负|受委屈"
)
_USER_HAPPY = re.compile(
    r"开心|高兴|太好了|好开心|喜欢你|爱你|想你|抱抱|亲亲|么么|"
    r"谢谢|辛苦啦|好消息|成功了|做到了"
)
_USER_AFFECTIONATE = re.compile(
    r"喜欢你|爱你|想你|抱抱|亲亲|么么|宝宝|宝贝|老婆|亲爱的|在干嘛|睡了吗"
)
_USER_COLD = re.compile(r"随便|无所谓|别烦我|没空|不想聊|不说算了|懒得说|哦。|嗯。")
_USER_APOLOGY = re.compile(r"对不起|抱歉|我错了|是我不对|原谅我|别生气|我道歉")
_USER_TEASING = re.compile(r"吃醋|嫉妒|别人|前女友|她是谁|跟谁|好看吗|漂亮吗|可爱吗")


def _clamp_speed(value: float) -> float:
    return round(max(0.92, min(1.06, value)), 2)


def build_speech_style(
    user_message: str,
    mood: str,
    irritation: int,
    affection: int,
    trust: int,
    distance: bool = False,
    profile_speech_style: str = "",
) -> SpeechStyle:
    """Choose a natural delivery without overriding the character's own style.

    Priority is intentional: an active cold conflict must win over a cheerful
    topic, while a distressed user should soften the voice even if the
    relationship is not very affectionate yet.
    """
    message = (user_message or "").strip()
    own_style = " ".join((profile_speech_style or "").split())[:120]

    if distance or irritation >= 40 or mood == "生气":
        style = SpeechStyle(
            name="生气克制的距离感",
            instruct=(
                "用压低一档、偏冷、克制而简短的中文语气说话；语速放慢一点，"
                "句尾不要上扬，不要撒娇或讨好；保留一点不高兴和边界感。"
            ),
            speed=0.96,
            emotion_vector=(0.0, 0.72, 0.0, 0.0, 0.0, 0.0, 0.0, 0.28),
        )
    elif irritation >= 18 or mood == "不高兴":
        style = SpeechStyle(
            name="有点闹别扭",
            instruct=(
                "用带一点委屈和不高兴的自然中文语气说话；语气淡一点、句子短一点，"
                "偶尔停顿，像还在闹别扭但愿意继续听；不要客服腔，也不要突然变得甜腻。"
            ),
            speed=0.98,
            emotion_vector=(0.0, 0.38, 0.16, 0.0, 0.0, 0.12, 0.0, 0.34),
        )
    elif _USER_SAD.search(message):
        style = SpeechStyle(
            name="温柔关心",
            instruct=(
                "用温柔、耐心、明显关心但不夸张的中文语气说话；语速稍慢，"
                "声音放软，停顿更自然，像真的在心疼对方；不要用哄小孩的腔调。"
            ),
            speed=0.96,
            emotion_vector=(0.0, 0.0, 0.18, 0.0, 0.0, 0.12, 0.0, 0.70),
        )
    elif _USER_APOLOGY.search(message) and (irritation > 0 or mood == "缓和"):
        style = SpeechStyle(
            name="嘴硬后松动",
            instruct=(
                "用表面还在端着、其实已经软下来的中文语气说话；开头稍微迟疑，"
                "句子短一点，后面变得更温和；有一点嘴硬，不要立刻变成无事发生。"
            ),
            speed=0.98,
            emotion_vector=(0.14, 0.16, 0.0, 0.0, 0.0, 0.10, 0.0, 0.60),
        )
    elif _USER_TEASING.search(message) or (affection >= 68 and _USER_AFFECTIONATE.search(message)):
        style = SpeechStyle(
            name="吃醋试探",
            instruct=(
                "用带着一点吃醋、试探和不服气的中文语气说话；语速接近日常，"
                "有一点点拖音和停顿，像在等对方解释；不要尖锐攻击。"
            ),
            speed=1.0,
            emotion_vector=(0.12, 0.22, 0.0, 0.0, 0.0, 0.0, 0.10, 0.56),
        )
    elif _USER_HAPPY.search(message) or (affection >= 65 and trust >= 55):
        style = SpeechStyle(
            name="亲近轻快",
            instruct=(
                "用轻快、亲近、自然带笑意的中文语气说话；语速稍快，"
                "句尾自然一点，偶尔带一点撒娇；不要像客服，也不要每句都甜。"
            ),
            speed=1.03,
            emotion_vector=(0.76, 0.0, 0.0, 0.0, 0.0, 0.0, 0.06, 0.18),
        )
    elif _USER_COLD.search(message):
        style = SpeechStyle(
            name="克制观察",
            instruct=(
                "用平静、克制、略带打量意味的中文语气说话；语速正常或稍慢，"
                "不要主动讨好，也不要突然变得热情；保留自己的判断。"
            ),
            speed=0.98,
            emotion_vector=(0.0, 0.12, 0.0, 0.0, 0.0, 0.10, 0.0, 0.78),
        )
    else:
        style = SpeechStyle(
            name="日常亲密",
            instruct=(
                "用自然放松、像熟人聊天的中文语气说话；语速正常，"
                "亲近但不刻意甜腻，句子有停顿和呼吸感，不要旁白腔或客服腔。"
            ),
            speed=1.0,
            emotion_vector=(0.18, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.82),
        )

    if own_style:
        style = SpeechStyle(
            name=style.name,
            instruct=f"{style.instruct}角色本身的说话方式参考：{own_style}。",
            speed=style.speed,
            emotion_vector=style.emotion_vector,
        )
    return SpeechStyle(
        style.name,
        style.instruct[:500],
        _clamp_speed(style.speed),
        style.emotion_vector,
    )

