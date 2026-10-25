import pytest
import base64
import httpx
from fastapi.testclient import TestClient

from app.main import app
from app.db import Base, SessionLocal, engine
from app.models import AdultConsent, AgentMemory, AgentProfile, Attachment, MemoryConsent, MemoryOperation, MemoryRecord, MessageRecord, RelationshipEvent, RelationshipRule, RelationshipState, SessionRecord, SkillInvocation
from app.provider import ModelEmptyResponse, ModelStreamInterrupted
from app.skills import assess_relationship_effect, build_core_context, extract_memory_candidate, relationship_effect_for_kind, select_specialist_ids, trim_history
from app.speech.contracts import StreamingTranscriptionEvent
from app.speech_styles import build_speech_style
from app.vision import VisionEmptyResponse


@pytest.fixture(autouse=True)
def isolate_database(monkeypatch, tmp_path):
    async def neutral_judgement(messages, skill_instructions):
        return None

    monkeypatch.setattr("app.main.judge_relationship", neutral_judgement)
    monkeypatch.setattr("app.main.settings.asr_provider", "mock")
    monkeypatch.setattr("app.speech.tts.settings.tts_provider", "mock")
    monkeypatch.setattr("app.main.ATTACHMENT_ROOT", tmp_path / "attachments")
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    for model in (Attachment, AdultConsent, AgentMemory, AgentProfile, RelationshipEvent, RelationshipRule, RelationshipState, MemoryOperation, MemoryRecord, MemoryConsent, SkillInvocation, MessageRecord, SessionRecord):
        db.query(model).delete()
    db.commit()
    db.close()
    yield
    db = SessionLocal()
    for model in (Attachment, AdultConsent, AgentMemory, AgentProfile, RelationshipEvent, RelationshipRule, RelationshipState, MemoryOperation, MemoryRecord, MemoryConsent, SkillInvocation, MessageRecord, SessionRecord):
        db.query(model).delete()
    db.commit()
    db.close()


def test_core_skill_is_called_before_model(monkeypatch):
    order = []

    async def fake_stream_chat(messages):
        order.append("model")
        assert "AI 女友核心 Skill" in messages[0]["content"]
        yield "你好，我在听。"

    monkeypatch.setattr("app.main.stream_chat", fake_stream_chat)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()

    with client.stream("POST", f"/api/v1/sessions/{session['id']}/messages", json={"content": "我今天有点累"}) as response:
        body = "".join(response.iter_text())

    assert response.status_code == 200
    assert "event: skill_started" in body
    assert "event: skill_completed" in body
    assert "event: judgement_started" in body
    assert "event: judgement_completed" in body
    assert "你好，我在听。" in body
    assert "event: done" in body
    assert order == ["model"]
    db = SessionLocal()
    assert db.query(SkillInvocation).filter_by(session_id=session["id"], skill_id="relationship-judgement").count() == 1
    db.close()


def test_mock_speech_transcription_returns_editable_text_without_persisting_audio():
    client = TestClient(app)

    response = client.post(
        "/api/v1/speech/transcribe",
        files={"file": ("recording.webm", b"fake-audio", "audio/webm")},
        data={"language": "zh-CN", "duration_ms": "3200"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "text": "（模拟转写）请在发送前编辑这段文字",
        "language": "zh-CN",
        "duration_ms": 3200,
        "provider": "mock",
    }


def test_voicestudio_transcription_uses_real_provider_contract(monkeypatch):
    captured = {}

    class CapturingResponse:
        status_code = 200
        text = ""

        @staticmethod
        def json():
            return {"text": "今天有点累，想早点休息。"}

    class CapturingClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, **kwargs):
            captured["url"] = url
            captured["files"] = kwargs["files"]
            captured["data"] = kwargs["data"]
            return CapturingResponse()

    monkeypatch.setattr("app.main.settings.asr_provider", "voicestudio")
    monkeypatch.setattr("app.speech.asr.settings.asr_base_url", "http://127.0.0.1:3900")
    monkeypatch.setattr("app.speech.asr.settings.asr_model", "Systran/faster-whisper-base")
    monkeypatch.setattr("app.speech.asr.httpx.AsyncClient", CapturingClient)

    client = TestClient(app)
    response = client.post(
        "/api/v1/speech/transcribe",
        files={"file": ("recording.webm", b"real-audio", "audio/webm")},
        data={"language": "zh-CN", "duration_ms": "3200"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "text": "今天有点累，想早点休息。",
        "language": "zh-CN",
        "duration_ms": 3200,
        "provider": "voicestudio",
    }
    assert captured["url"] == "http://127.0.0.1:3900/v1/audio/transcriptions"
    assert captured["files"]["file"][0] == "recording.webm"
    assert captured["files"]["file"][1] == b"real-audio"
    assert captured["data"]["model"] == "Systran/faster-whisper-base"
    assert captured["data"]["language"] == "zh"


def test_voicestudio_transcription_reports_unavailable_service(monkeypatch):
    class UnavailableClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, **kwargs):
            raise httpx.ConnectError("connection refused")

    monkeypatch.setattr("app.main.settings.asr_provider", "voicestudio")
    monkeypatch.setattr("app.speech.asr.settings.asr_base_url", "http://127.0.0.1:3900")
    monkeypatch.setattr("app.speech.asr.httpx.AsyncClient", UnavailableClient)

    client = TestClient(app)
    response = client.post(
        "/api/v1/speech/transcribe",
        files={"file": ("recording.webm", b"real-audio", "audio/webm")},
    )

    assert response.status_code == 503
    assert "无法连接 VoiceStudio 语音识别服务" in response.json()["detail"]


def test_speech_transcription_rejects_invalid_audio_type_and_limits():
    client = TestClient(app)

    invalid_type = client.post(
        "/api/v1/speech/transcribe",
        files={"file": ("note.txt", b"not-audio", "text/plain")},
    )
    too_long = client.post(
        "/api/v1/speech/transcribe",
        files={"file": ("recording.webm", b"fake-audio", "audio/webm")},
        data={"duration_ms": "60001"},
    )

    assert invalid_type.status_code == 415
    assert too_long.status_code == 413


def test_mock_speech_synthesis_returns_audio_without_persisting_content():
    client = TestClient(app)

    response = client.post(
        "/api/v1/speech/synthesize",
        json={"text": "我在听。", "speed": 1.0, "emotion": "平静"},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/wav")
    assert response.headers["x-speech-provider"] == "mock"
    assert response.headers["x-speech-mode"] == "browser-fallback"
    assert response.headers["cache-control"] == "no-store"
    assert response.content.startswith(b"RIFF")


def test_speech_synthesis_validates_text_and_speed():
    client = TestClient(app)

    empty = client.post("/api/v1/speech/synthesize", json={"text": ""})
    too_fast = client.post("/api/v1/speech/synthesize", json={"text": "你好", "speed": 2.1})

    assert empty.status_code == 422
    assert too_fast.status_code == 422


def test_speech_synthesis_accepts_full_generated_delivery_style(monkeypatch):
    captured = {}

    class CapturingResponse:
        status_code = 200
        content = b"RIFFvoice"
        headers = {"content-type": "audio/wav"}
        text = ""

    class CapturingClient:
        def __init__(self, *args, **kwargs):
            pass

        async def post(self, url, **kwargs):
            captured["json"] = kwargs["json"]
            return CapturingResponse()

    monkeypatch.setattr("app.speech.tts.settings.tts_provider", "voicestudio")
    monkeypatch.setattr("app.speech.tts.settings.tts_base_url", "http://127.0.0.1:3900")
    monkeypatch.setattr("app.speech.tts.settings.tts_model", "omnivoice")
    monkeypatch.setattr("app.speech.tts.settings.tts_voice", "test-voice")
    monkeypatch.setattr("app.speech.tts.httpx.AsyncClient", CapturingClient)

    long_style = "自然放松、像熟人聊天的中文语气说话；" + ("保留角色自己的说话方式。" * 20)
    response = TestClient(app).post(
        "/api/v1/speech/synthesize",
        json={"text": "我在听。", "speed": 1.0, "emotion": long_style},
    )

    assert response.status_code == 200
    assert len(captured["json"]["instruct"]) <= 500


def test_voicestudio_default_voice_uses_configured_voice(monkeypatch):
    captured = {}

    class CapturingResponse:
        status_code = 200
        content = b"RIFFvoice"
        headers = {"content-type": "audio/wav"}
        text = ""

    class CapturingClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, **kwargs):
            captured["url"] = url
            captured["json"] = kwargs["json"]
            return CapturingResponse()

    monkeypatch.setattr("app.speech.tts.settings.tts_provider", "voicestudio")
    monkeypatch.setattr("app.speech.tts.settings.tts_base_url", "http://127.0.0.1:3900")
    monkeypatch.setattr("app.speech.tts.settings.tts_model", "omnivoice")
    monkeypatch.setattr("app.speech.tts.settings.tts_voice", "test-voice")
    monkeypatch.setattr("app.speech.tts.httpx.AsyncClient", CapturingClient)

    client = TestClient(app)
    response = client.post(
        "/api/v1/speech/synthesize",
        json={"text": "你好", "voice": "default", "speed": 1.0},
    )

    assert response.status_code == 200
    assert response.headers["x-speech-provider"] == "voicestudio"
    assert captured["url"] == "http://127.0.0.1:3900/v1/audio/speech"
    assert captured["json"]["voice"] == "test-voice"


def test_voicestudio_synthesis_sends_delivery_instruction(monkeypatch):
    captured = {}

    class CapturingResponse:
        status_code = 200
        content = b"RIFFvoice"
        headers = {"content-type": "audio/wav"}
        text = ""

    class CapturingClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, **kwargs):
            captured["json"] = kwargs["json"]
            return CapturingResponse()

    monkeypatch.setattr("app.speech.tts.settings.tts_provider", "voicestudio")
    monkeypatch.setattr("app.speech.tts.settings.tts_base_url", "http://127.0.0.1:3900")
    monkeypatch.setattr("app.speech.tts.settings.tts_model", "omnivoice")
    monkeypatch.setattr("app.speech.tts.settings.tts_voice", "test-voice")
    monkeypatch.setattr("app.speech.tts.httpx.AsyncClient", CapturingClient)

    client = TestClient(app)
    response = client.post(
        "/api/v1/speech/synthesize",
        json={
            "text": "我听着呢。",
            "voice": "default",
            "speed": 0.98,
            "emotion": "温柔、关心、语速稍慢",
        },
    )

    assert response.status_code == 200
    assert captured["json"]["instruct"] == "low pitch"
    assert "emo_text" not in captured["json"]


def test_voicestudio_synthesis_forwards_latency_step_hint(monkeypatch):
    captured = {}

    class CapturingResponse:
        status_code = 200
        content = b"RIFFvoice"
        headers = {"content-type": "audio/wav"}
        text = ""

    class CapturingClient:
        def __init__(self, *args, **kwargs):
            pass

        async def post(self, url, **kwargs):
            captured["json"] = kwargs["json"]
            return CapturingResponse()

    monkeypatch.setattr("app.speech.tts.settings.tts_provider", "voicestudio")
    monkeypatch.setattr("app.speech.tts.settings.tts_base_url", "http://127.0.0.1:3900")
    monkeypatch.setattr("app.speech.tts.settings.tts_model", "omnivoice")
    monkeypatch.setattr("app.speech.tts.settings.tts_voice", "test-voice")
    monkeypatch.setattr("app.speech.tts.httpx.AsyncClient", CapturingClient)
    monkeypatch.setattr("app.main.settings.tts_manual_num_step", 12)

    response = TestClient(app).post(
        "/api/v1/speech/synthesize",
        json={"text": "我在听。", "voice": "default", "num_step": 7},
    )

    assert response.status_code == 200
    assert captured["json"]["num_step"] == 7


def test_voicestudio_synthesis_uses_chat_default_step(monkeypatch):
    captured = {}

    class CapturingResponse:
        status_code = 200
        content = b"RIFFvoice"
        headers = {"content-type": "audio/wav"}
        text = ""

    class CapturingClient:
        def __init__(self, *args, **kwargs):
            pass

        async def post(self, url, **kwargs):
            captured["json"] = kwargs["json"]
            return CapturingResponse()

    monkeypatch.setattr("app.speech.tts.settings.tts_provider", "voicestudio")
    monkeypatch.setattr("app.speech.tts.settings.tts_base_url", "http://127.0.0.1:3900")
    monkeypatch.setattr("app.speech.tts.settings.tts_model", "omnivoice")
    monkeypatch.setattr("app.speech.tts.settings.tts_voice", "test-voice")
    monkeypatch.setattr("app.speech.tts.httpx.AsyncClient", CapturingClient)
    monkeypatch.setattr("app.main.settings.tts_chat_num_step", 10)

    response = TestClient(app).post(
        "/api/v1/speech/synthesize",
        json={"text": "我在听。", "voice": "default"},
    )

    assert response.status_code == 200
    assert captured["json"]["num_step"] == 10


def test_voicestudio_omnivoice_maps_legal_pitch_and_whisper_tags(monkeypatch):
    captured = []

    class CapturingResponse:
        status_code = 200
        content = b"RIFFvoice"
        headers = {"content-type": "audio/wav"}
        text = ""

    class CapturingClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, **kwargs):
            captured.append(kwargs["json"])
            return CapturingResponse()

    monkeypatch.setattr("app.speech.tts.settings.tts_provider", "voicestudio")
    monkeypatch.setattr("app.speech.tts.settings.tts_base_url", "http://127.0.0.1:3900")
    monkeypatch.setattr("app.speech.tts.settings.tts_model", "omnivoice")
    monkeypatch.setattr("app.speech.tts.settings.tts_voice", "test-voice")
    monkeypatch.setattr("app.speech.tts.httpx.AsyncClient", CapturingClient)

    client = TestClient(app)
    for emotion in ("开心、轻快", "小声、耳语"):
        response = client.post(
            "/api/v1/speech/synthesize",
            json={"text": "我在听。", "voice": "default", "speed": 1.0, "emotion": emotion},
        )
        assert response.status_code == 200

    assert captured[0]["instruct"] == "high pitch"
    assert captured[1]["instruct"] == "whisper, moderate pitch"


def test_voicestudio_indextts_sends_emotion_vector(monkeypatch):
    captured = {}

    class CapturingResponse:
        status_code = 200
        content = b"RIFFvoice"
        headers = {"content-type": "audio/wav"}
        text = ""

    class CapturingClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, **kwargs):
            captured["json"] = kwargs["json"]
            return CapturingResponse()

    monkeypatch.setattr("app.speech.tts.settings.tts_provider", "voicestudio")
    monkeypatch.setattr("app.speech.tts.settings.tts_base_url", "http://127.0.0.1:3900")
    monkeypatch.setattr("app.speech.tts.settings.tts_model", "indextts2")
    monkeypatch.setattr("app.speech.tts.settings.tts_voice", "test-voice")
    monkeypatch.setattr("app.speech.tts.httpx.AsyncClient", CapturingClient)

    client = TestClient(app)
    response = client.post(
        "/api/v1/speech/synthesize",
        json={
            "text": "我听着呢。",
            "voice": "default",
            "speed": 0.98,
            "emotion": "温柔、关心、语速稍慢",
            "emotion_vector": [0, 0, 0.2, 0, 0, 0.1, 0, 0.7],
        },
    )

    assert response.status_code == 200
    assert captured["json"]["emo_vector"] == [0, 0, 0.2, 0, 0, 0.1, 0, 0.7]
    assert captured["json"]["emo_alpha"] == 1.0
    assert "emo_text" not in captured["json"]


def test_speech_style_prioritizes_conflict_and_compassion():
    angry = build_speech_style("随便吧", "生气", irritation=55, affection=70, trust=60)
    caring = build_speech_style("我今天真的好累，有点撑不住", "平静", irritation=0, affection=50, trust=50)

    assert angry.name == "生气克制的距离感"
    assert "冷淡" in angry.instruct or "偏冷" in angry.instruct
    assert caring.name == "温柔关心"
    assert caring.speed < 1.0


def test_core_skill_uses_immersive_role_without_proactive_identity_break(monkeypatch):
    captured = {}

    async def fake_stream_chat(messages):
        captured["system"] = messages[0]["content"]
        yield "我也很开心见到你。"

    monkeypatch.setattr("app.main.stream_chat", fake_stream_chat)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()

    response = client.post(f"/api/v1/sessions/{session['id']}/messages", json={"content": "我喜欢你"})

    assert response.status_code == 200
    assert "ROLEPLAY_MODE: immersive-companion" in captured["system"]


def test_missing_required_skill_blocks_model(monkeypatch):
    called = False

    async def fake_stream_chat(messages):
        nonlocal called
        called = True
        yield "should not happen"

    def missing_skill(*args, **kwargs):
        raise FileNotFoundError("missing")

    monkeypatch.setattr("app.main.stream_chat", fake_stream_chat)
    monkeypatch.setattr("app.main.build_core_context", missing_skill)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()

    response = client.post(f"/api/v1/sessions/{session['id']}/messages", json={"content": "你好"})
    events = response.text

    assert not called
    assert "必需的核心 Skill 未安装" in events
    assert "event: error" in events


def test_session_history_round_trip(monkeypatch):
    async def fake_stream_chat(messages):
        yield "记得了。"

    monkeypatch.setattr("app.main.stream_chat", fake_stream_chat)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()
    client.post(f"/api/v1/sessions/{session['id']}/messages", json={"content": "我喜欢春天"})

    detail = client.get(f"/api/v1/sessions/{session['id']}").json()
    assert [message["role"] for message in detail["messages"]] == ["user", "assistant"]
    assert detail["messages"][-1]["content"] == "记得了。"


@pytest.mark.parametrize(
    ("failure", "code"),
    [
        (ModelStreamInterrupted("模型流式响应在完成前中断"), "model_stream_interrupted"),
        (ModelEmptyResponse("模型返回了空回答"), "model_empty_response"),
    ],
)
def test_incomplete_model_response_is_reported_without_saving_assistant(monkeypatch, failure, code):
    async def failed_stream_chat(messages):
        raise failure
        yield "unreachable"

    monkeypatch.setattr("app.main.stream_chat", failed_stream_chat)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()

    response = client.post(f"/api/v1/sessions/{session['id']}/messages", json={"content": "测试异常"})

    assert response.status_code == 200
    assert f'"code": "{code}"' in response.text
    detail = client.get(f"/api/v1/sessions/{session['id']}").json()
    assert [message["role"] for message in detail["messages"]] == ["user"]


def test_memory_requires_consent_and_is_injected_after_authorization(monkeypatch):
    captured = {}

    async def fake_stream_chat(messages):
        captured["messages"] = messages
        yield "我记住啦。"

    monkeypatch.setattr("app.main.stream_chat", fake_stream_chat)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    blocked = client.post("/api/v1/memory", json={"kind": "preference", "content": "喜欢清淡的早餐"})
    assert blocked.status_code == 403

    consent = client.post("/api/v1/memory/consent", json={"allowed": True})
    assert consent.json()["allowed"] is True
    created = client.post("/api/v1/memory", json={"kind": "preference", "content": "喜欢清淡的早餐"})
    assert created.status_code == 201

    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()
    client.post(f"/api/v1/sessions/{session['id']}/messages", json={"content": "今天吃什么"})
    assert "喜欢清淡的早餐" in captured["messages"][0]["content"]


def test_memory_edit_records_previous_value():
    client = TestClient(app)
    client.post("/api/v1/memory/consent", json={"allowed": True})
    created = client.post("/api/v1/memory", json={"kind": "preference", "content": "喜欢清淡的早餐"}).json()

    updated = client.patch(f"/api/v1/memory/{created['id']}", json={"content": "喜欢热的清淡早餐"})

    assert updated.status_code == 200
    assert updated.json()["content"] == "喜欢热的清淡早餐"
    db = SessionLocal()
    operation = db.query(MemoryOperation).filter_by(memory_id=created["id"], operation="update").one()
    assert operation.previous_content == "喜欢清淡的早餐"
    db.close()


def test_retrying_incomplete_user_turn_does_not_duplicate_message(monkeypatch):
    async def fake_stream_chat(messages):
        yield "重试成功。"

    monkeypatch.setattr("app.main.stream_chat", fake_stream_chat)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()
    db = SessionLocal()
    db.add(MessageRecord(session_id=session["id"], role="user", content="上一轮没有回答的问题"))
    db.commit()
    db.close()

    response = client.post(f"/api/v1/sessions/{session['id']}/messages", json={"content": "上一轮没有回答的问题"})

    assert response.status_code == 200
    detail = client.get(f"/api/v1/sessions/{session['id']}").json()
    assert [message["role"] for message in detail["messages"]] == ["user", "assistant"]
    assert detail["messages"][-1]["content"] == "重试成功。"


def test_regeneration_replaces_answer_without_repeating_relationship_effect(monkeypatch):
    answers = iter(["第一次回答。", "第二次回答。"])

    async def fake_stream_chat(messages):
        yield next(answers)

    monkeypatch.setattr("app.main.stream_chat", fake_stream_chat)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()
    first = client.post(f"/api/v1/sessions/{session['id']}/messages", json={"content": "你真没用，滚开"})
    assert first.status_code == 200
    first_state = client.get("/api/v1/relationship/state").json()
    first_events = client.get("/api/v1/relationship/events").json()

    regenerated = client.post(f"/api/v1/sessions/{session['id']}/messages", json={"content": "你真没用，滚开", "regenerate": True})
    assert regenerated.status_code == 200
    second_state = client.get("/api/v1/relationship/state").json()
    second_events = client.get("/api/v1/relationship/events").json()
    detail = client.get(f"/api/v1/sessions/{session['id']}").json()

    assert second_state["irritation"] == first_state["irritation"]
    assert len(second_events) == len(first_events)
    assert [message["role"] for message in detail["messages"]] == ["user", "assistant"]
    assert detail["messages"][-1]["content"] == "第二次回答。"


def test_pausing_memory_stops_injection_and_new_writes(monkeypatch):
    async def fake_stream_chat(messages):
        assert "喜欢清淡的早餐" not in messages[0]["content"]
        yield "好呀。"

    monkeypatch.setattr("app.main.stream_chat", fake_stream_chat)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    client.post("/api/v1/memory/consent", json={"allowed": True})
    client.post("/api/v1/memory", json={"kind": "preference", "content": "喜欢清淡的早餐"})
    paused = client.post("/api/v1/memory/pause", json={"paused": True})
    assert paused.json()["paused"] is True
    blocked = client.post("/api/v1/memory", json={"kind": "preference", "content": "不喝冰饮"})
    assert blocked.status_code == 403

    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()
    client.post(f"/api/v1/sessions/{session['id']}/messages", json={"content": "早上好"})


def test_girlfriend_mode_requires_adult_confirmation_but_advisor_does_not():
    client = TestClient(app)
    blocked = client.post("/api/v1/sessions", json={"mode": "girlfriend"})
    assert blocked.status_code == 403

    advisor = client.post("/api/v1/sessions", json={"mode": "advisor"})
    assert advisor.status_code == 200

    consent = client.post("/api/v1/adult/consent", json={"confirmed": True})
    assert consent.json()["confirmed"] is True
    girlfriend = client.post("/api/v1/sessions", json={"mode": "girlfriend"})
    assert girlfriend.status_code == 200

    revoked = client.post("/api/v1/adult/consent", json={"confirmed": False})
    assert revoked.json()["confirmed"] is False
    locked = client.post(f"/api/v1/sessions/{girlfriend.json()['id']}/messages", json={"content": "你好"})
    assert locked.status_code == 403


def test_specialists_and_memory_candidate_are_emitted(monkeypatch):
    captured = {}

    async def fake_stream_chat(messages):
        captured["system"] = messages[0]["content"]
        yield "先抱抱。"

    monkeypatch.setattr("app.main.stream_chat", fake_stream_chat)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()
    response = client.post(f"/api/v1/sessions/{session['id']}/messages", json={"content": "我最近好累，而且我喜欢清淡的早餐"})

    assert response.status_code == 200
    assert "event: specialist_started" in response.text
    assert "girlfriend-emotion" in response.text
    assert "event: memory_candidate" in response.text
    assert "清淡的早餐" in captured["system"] or "长期记忆未启用" in captured["system"]
    assert select_specialist_ids("我有点难过", "girlfriend") == ["girlfriend-emotion"]
    assert select_specialist_ids("我想和他吵架", "girlfriend") == ["girlfriend-conflict"]
    assert extract_memory_candidate("我的手机号是 123") is None


def test_current_message_is_not_duplicated_in_model_context(monkeypatch):
    captured = []

    async def fake_stream_chat(messages):
        captured.append(messages)
        yield "收到。"

    monkeypatch.setattr("app.main.stream_chat", fake_stream_chat)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()

    client.post(f"/api/v1/sessions/{session['id']}/messages", json={"content": "第一条消息"})
    response = client.post(f"/api/v1/sessions/{session['id']}/messages", json={"content": "这是当前问题"})

    assert response.status_code == 200
    messages = captured[-1]
    assert [message["role"] for message in messages] == ["system", "user", "assistant", "user"]
    assert messages[-1] == {"role": "user", "content": "这是当前问题"}
    assert sum(message["content"].count("这是当前问题") for message in messages) == 1
    assert "这是当前问题" not in messages[0]["content"]


def test_trim_history_keeps_newest_messages_and_character_budget():
    messages = [
        {"role": "user" if index % 2 == 0 else "assistant", "content": f"message-{index}"}
        for index in range(20)
    ]

    assert trim_history(messages, max_messages=12) == messages[-12:]
    trimmed = trim_history(messages, max_messages=20, max_chars=25)
    assert trimmed == messages[-2:]
    assert sum(len(message["content"]) for message in trimmed) <= 25

    assistant_cutoff = trim_history(
        [{"role": "user", "content": "旧问题"}, {"role": "assistant", "content": "旧回答"}],
        max_messages=1,
    )
    assert assistant_cutoff == []

    failed_turn = trim_history(
        [{"role": "user", "content": "已失败的问题"}, {"role": "user", "content": "新的问题"}],
        max_messages=12,
    )
    assert failed_turn == []


def test_core_context_contains_policy_but_no_conversation_turns():
    _, context = build_core_context("当前问题", [{"role": "user", "content": "旧问题"}], "girlfriend")

    assert "当前问题" not in context
    assert "旧问题" not in context
    assert "final user turn" in context


def test_relationship_effect_has_anger_and_apology_paths():
    insult = assess_relationship_effect("你真没用，滚开", anger_sensitivity=3)
    apology = assess_relationship_effect("对不起，我刚才说重了，别生气", anger_sensitivity=3)

    assert insult["kind"] == "insult"
    assert insult["needs_distance"] is True
    assert insult["irritation_delta"] > 0
    assert apology["kind"] == "apology"
    assert apology["irritation_delta"] < 0

    assert assess_relationship_effect("我答应你的事没做到") ["kind"] == "broken_promise"
    assert assess_relationship_effect("其实我骗了你") ["kind"] == "admitted_lie"
    assert assess_relationship_effect("我之前一直敷衍你") ["kind"] == "cold_treatment"
    assert assess_relationship_effect("我今天想自己待一会儿") ["kind"] == "neutral"
    assert assess_relationship_effect("对不起，废物") ["kind"] == "insult"
    assert relationship_effect_for_kind("broken_promise", anger_sensitivity=5, trigger="明确失约")["trust_delta"] == -9
    assert relationship_effect_for_kind("unknown")["kind"] == "neutral"


def test_custom_profile_and_relationship_state_are_injected(monkeypatch):
    captured = {}

    async def fake_stream_chat(messages):
        captured["system"] = messages[0]["content"]
        yield "我听到了。"

    monkeypatch.setattr("app.main.stream_chat", fake_stream_chat)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    profile = client.get("/api/v1/agent/profile").json()
    profile.update({
        "display_name": "阿澄",
        "personality": "有点骄傲，心软但不喜欢被敷衍",
        "background": "在海边长大，喜欢夜里听电台",
        "interests": "电台、海风、旧电影",
        "boundaries": "不接受侮辱和命令式说话",
        "speech_style": "短句，偶尔冷淡，熟悉后会撒娇",
        "inner_mood": "有点困，但心情不错",
        "current_focus": "最近在琢磨一部旧电影",
        "recent_plan": "周末想去散步",
        "avoid_topics": "暂时不想展开工作争执",
        "autonomy_level": 5,
        "initiative_level": 4,
        "initiative_cooldown_minutes": 45,
        "anger_sensitivity": 4,
        "silent_duration_minutes": 20,
    })
    saved = client.put("/api/v1/agent/profile", json=profile)
    assert saved.status_code == 200
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()
    response = client.post(f"/api/v1/sessions/{session['id']}/messages", json={"content": "你今天还好吗"})

    assert response.status_code == 200
    assert "阿澄" in captured["system"]
    assert "在海边长大" in captured["system"]
    assert "自主程度：5/5" in captured["system"]
    assert "自己的当前心情：有点困，但心情不错" in captured["system"]
    assert "当前关注：最近在琢磨一部旧电影" in captured["system"]
    assert "主动表达等级：4/5" in captured["system"]
    assert "有明显的独立生活感和判断" in captured["system"]
    assert "当前情绪：平静" in captured["system"]


def test_successful_generation_records_initiative_cooldown(monkeypatch):
    async def fake_stream_chat(messages):
        yield "我在听。"

    monkeypatch.setattr("app.main.stream_chat", fake_stream_chat)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    profile = client.get("/api/v1/agent/profile").json()
    profile["initiative_level"] = 4
    profile["initiative_cooldown_minutes"] = 60
    saved = client.put("/api/v1/agent/profile", json=profile)
    assert saved.status_code == 200
    assert saved.json()["last_initiative_at"] is None
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()

    response = client.post(f"/api/v1/sessions/{session['id']}/messages", json={"content": "你今天怎么样"})

    assert response.status_code == 200
    assert client.get("/api/v1/agent/profile").json()["last_initiative_at"] is not None


def test_relationship_state_changes_after_insult_and_apology(monkeypatch):
    async def fake_stream_chat(messages):
        yield "我先冷静一下。"

    monkeypatch.setattr("app.main.stream_chat", fake_stream_chat)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()

    client.post(f"/api/v1/sessions/{session['id']}/messages", json={"content": "你真没用，滚开"})
    angry = client.get("/api/v1/relationship/state").json()
    assert angry["irritation"] > 0
    assert angry["trust"] < 50
    assert angry["silence_until"] is not None

    client.post(f"/api/v1/sessions/{session['id']}/messages", json={"content": "对不起，我刚才说重了，别生气"})
    recovering = client.get("/api/v1/relationship/state").json()
    assert recovering["irritation"] < angry["irritation"]
    assert recovering["silence_until"] is None


def test_relationship_state_can_be_customized():
    client = TestClient(app)
    response = client.put("/api/v1/relationship/state", json={
        "mood": "吃醋",
        "trust": 23,
        "affection": 81,
        "irritation": 34,
        "conflict_count": 2,
        "last_trigger": "用户答应的事情还没有做到",
    })

    assert response.status_code == 200
    assert response.json()["mood"] == "吃醋"
    assert response.json()["trust"] == 23
    assert response.json()["affection"] == 81
    assert response.json()["last_trigger"] == "用户答应的事情还没有做到"


def test_custom_relationship_rule_has_priority_and_controls_effect(monkeypatch):
    async def fake_stream_chat(messages):
        yield "我知道了。"

    monkeypatch.setattr("app.main.stream_chat", fake_stream_chat)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    created = client.post("/api/v1/relationship/rules", json={
        "name": "失约规则",
        "match_text": "临时放鸽子,又失约",
        "event_type": "custom_broken_promise",
        "trigger": "你触发了自定义失约规则",
        "trust_delta": -12,
        "affection_delta": -4,
        "irritation_delta": 20,
        "needs_distance": True,
        "silence_minutes": 7,
        "priority": 90,
    })
    assert created.status_code == 201
    listed = client.get("/api/v1/relationship/rules")
    assert listed.status_code == 200
    assert listed.json()[0]["match_text"] == "临时放鸽子,又失约"
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()
    response = client.post(f"/api/v1/sessions/{session['id']}/messages", json={"content": "你别生气，我这次临时放鸽子了"})
    state = client.get("/api/v1/relationship/state").json()
    events = client.get("/api/v1/relationship/events").json()

    assert response.status_code == 200
    assert state["trust"] == 38
    assert state["irritation"] == 20
    assert events[0]["trigger"] == "你触发了自定义失约规则"
    assert state["silence_until"] is not None

    updated = client.put(f"/api/v1/relationship/rules/{created.json()['id']}", json={**created.json(), "enabled": False})
    assert updated.status_code == 200
    deleted = client.delete(f"/api/v1/relationship/rules/{created.json()['id']}")
    assert deleted.status_code == 204


def test_model_judgement_can_drive_contextual_relationship_change(monkeypatch):
    async def broken_promise_judgement(messages, skill_instructions):
        return {"kind": "broken_promise", "confidence": 0.95, "trigger": "用户承认答应的事没有做到"}

    async def fake_stream_chat(messages):
        yield "这件事让我有点失望。"

    monkeypatch.setattr("app.main.judge_relationship", broken_promise_judgement)
    monkeypatch.setattr("app.main.stream_chat", fake_stream_chat)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()

    response = client.post(f"/api/v1/sessions/{session['id']}/messages", json={"content": "我答应你的事没有做到"})
    state = client.get("/api/v1/relationship/state").json()

    assert response.status_code == 200
    assert "judgement_completed" in response.text
    assert state["trust"] == 41
    assert state["last_trigger"] == "用户承认答应的事没有做到"


def test_agent_memory_is_saved_and_injected(monkeypatch):
    captured = {}

    async def fake_stream_chat(messages):
        captured["system"] = messages[0]["content"]
        yield "我记得。"

    monkeypatch.setattr("app.main.stream_chat", fake_stream_chat)
    client = TestClient(app)
    memory = client.post("/api/v1/agent/memories", json={
        "kind": "current_interest",
        "content": "最近在读一本关于海边旅行的书",
        "importance": 5,
    })
    assert memory.status_code == 201
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()
    client.post(f"/api/v1/sessions/{session['id']}/messages", json={"content": "你最近在看什么"})

    assert "最近在读一本关于海边旅行的书" in captured["system"]
    assert client.get("/api/v1/agent/memories").json()[0]["source"] == "user"


def test_relationship_event_is_recorded_and_resolved_by_apology(monkeypatch):
    async def fake_stream_chat(messages):
        yield "先让我冷静一下。"

    monkeypatch.setattr("app.main.stream_chat", fake_stream_chat)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()
    client.post(f"/api/v1/sessions/{session['id']}/messages", json={"content": "我答应你的事没做到"})
    events = client.get("/api/v1/relationship/events").json()
    assert events[0]["event_type"] == "broken_promise"
    assert events[0]["resolved"] is False

    client.post(f"/api/v1/sessions/{session['id']}/messages", json={"content": "对不起，我会补上"})
    events = client.get("/api/v1/relationship/events").json()
    broken_promise = next(event for event in events if event["event_type"] == "broken_promise")
    assert broken_promise["resolved"] is True
    assert broken_promise["resolution_note"]


def test_image_upload_is_bound_to_message_and_injected_without_long_term_memory(monkeypatch):
    captured = {}

    async def fake_stream_chat(messages):
        captured["system"] = messages[0]["content"]
        captured["last"] = messages[-1]["content"]
        yield "我看到这张图了。"

    monkeypatch.setattr("app.main.stream_chat", fake_stream_chat)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()

    uploaded = client.post(
        f"/api/v1/sessions/{session['id']}/attachments",
        files={"file": ("scene.png", b"\x89PNG\r\n\x1a\nfake", "image/png")},
    )
    assert uploaded.status_code == 201
    attachment = uploaded.json()
    assert attachment["analysis_status"] == "ready"
    assert "本地模拟视觉服务" in attachment["summary"]
    assert client.get(attachment["url"]).status_code == 200

    response = client.post(
        f"/api/v1/sessions/{session['id']}/messages",
        json={"content": "看看这个", "attachment_ids": [attachment["id"]]},
    )
    assert response.status_code == 200
    assert "本地模拟视觉服务" in captured["system"]
    assert captured["last"] == "看看这个"

    detail = client.get(f"/api/v1/sessions/{session['id']}").json()
    assert detail["messages"][0]["attachments"][0]["id"] == attachment["id"]
    db = SessionLocal()
    assert db.query(MemoryRecord).count() == 0
    assert db.query(Attachment).filter_by(message_id=detail["messages"][0]["id"]).count() == 1
    db.close()


def test_image_only_message_is_allowed_and_failed_summary_is_not_injected(monkeypatch):
    captured = {}

    async def failed_analysis(image, mime_type, prompt=""):
        raise VisionEmptyResponse("视觉服务没有返回描述")

    async def fake_stream_chat(messages):
        captured["system"] = messages[0]["content"]
        yield "我收到了这张图片。"

    monkeypatch.setattr("app.main.analyze_image", failed_analysis)
    monkeypatch.setattr("app.main.stream_chat", fake_stream_chat)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()
    attachment = client.post(
        f"/api/v1/sessions/{session['id']}/attachments",
        files={"file": ("scene.webp", b"fake-webp", "image/webp")},
    ).json()

    response = client.post(
        f"/api/v1/sessions/{session['id']}/messages",
        json={"content": "", "attachment_ids": [attachment["id"]]},
    )

    assert response.status_code == 200
    assert "视觉服务没有返回描述" not in captured["system"]
    detail = client.get(f"/api/v1/sessions/{session['id']}").json()
    assert len(detail["messages"]) == 2
    assert detail["messages"][0]["content"] == ""
    assert detail["messages"][0]["attachments"][0]["analysis_status"] == "failed"


def test_attachment_validation_and_session_delete_cleanup():
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()

    invalid = client.post(
        f"/api/v1/sessions/{session['id']}/attachments",
        files={"file": ("note.txt", b"not-image", "text/plain")},
    )
    oversized = client.post(
        f"/api/v1/sessions/{session['id']}/attachments",
        files={"file": ("large.jpg", b"x" * (10 * 1024 * 1024 + 1), "image/jpeg")},
    )
    assert invalid.status_code == 415
    assert oversized.status_code == 413

    attachment = client.post(
        f"/api/v1/sessions/{session['id']}/attachments",
        files={"file": ("unused.png", b"\x89PNG\r\n\x1a\npending", "image/png")},
    ).json()
    db = SessionLocal()
    stored_name = db.get(Attachment, attachment["id"]).stored_name
    db.close()
    from app.main import ATTACHMENT_ROOT

    assert (ATTACHMENT_ROOT / stored_name).is_file()
    assert client.delete(f"/api/v1/sessions/{session['id']}").status_code == 204
    db = SessionLocal()
    assert db.query(Attachment).filter_by(id=attachment["id"]).count() == 0
    db.close()
    assert not (ATTACHMENT_ROOT / stored_name).exists()


def test_realtime_websocket_reuses_generation_pipeline(monkeypatch):
    captured = {}

    async def fake_stream_chat(messages):
        captured["system"] = messages[0]["content"]
        yield "我在听，你继续说。"

    monkeypatch.setattr("app.main.stream_chat", fake_stream_chat)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()

    with client.websocket_connect(f"/api/v1/realtime/{session['id']}") as websocket:
        ready = websocket.receive_json()
        assert ready["type"] == "session.ready"
        websocket.send_json({"type": "audio.chunk", "turn_id": "turn-1", "mime_type": "audio/webm", "data": base64.b64encode(b"fake-audio").decode("ascii")})
        websocket.send_json({"type": "audio.commit", "turn_id": "turn-1", "duration_ms": 1200, "language": "zh-CN"})
        assert websocket.receive_json()["type"] == "transcription.started"
        transcript = websocket.receive_json()
        assert transcript["type"] == "transcript.final"
        assert transcript["text"]
        assert websocket.receive_json()["type"] == "response.started"
        events = []
        while True:
            event = websocket.receive_json()
            events.append(event)
            if event["type"] in {"response.completed", "error"}:
                break
        assert any(event["type"] == "response.text.delta" for event in events)
        assert any(event["type"] == "speech.style" for event in events)
        assert any(event["type"] == "response.text.completed" for event in events)
        websocket.send_json({"type": "session.end"})
        assert websocket.receive_json()["type"] == "session.ended"

    assert "<skill-instructions>" in captured["system"]
    assert "沉浸在现实聊天里的成年女性角色" in captured["system"]
    assert "<agent-profile>" in captured["system"]
    detail = client.get(f"/api/v1/sessions/{session['id']}").json()
    assert [message["role"] for message in detail["messages"]] == ["user", "assistant"]


def test_realtime_rejects_invalid_audio_and_requires_adult_confirmation():
    client = TestClient(app)
    session = client.post("/api/v1/sessions", json={"mode": "advisor"}).json()
    with client.websocket_connect(f"/api/v1/realtime/{session['id']}") as websocket:
        assert websocket.receive_json()["type"] == "session.ready"
        websocket.send_json({"type": "audio.commit", "turn_id": "empty"})
        error = websocket.receive_json()
        assert error["type"] == "error"
        assert error["code"] == "empty_audio"

    girlfriend = client.post("/api/v1/sessions", json={"mode": "girlfriend"})
    assert girlfriend.status_code == 403


def test_realtime_streaming_asr_ignores_summary_after_utterance(monkeypatch):
    launched = []

    class StreamingAsr:
        async def transcribe_stream(self, audio_queue, language, model):
            assert model == "sherpa-zipformer-bilingual-zh-en"
            yield StreamingTranscriptionEvent(kind="partial", text="今天")
            yield StreamingTranscriptionEvent(kind="final", text="今天好累。", final_kind="utterance")
            yield StreamingTranscriptionEvent(kind="final", text="今天好累。", final_kind="summary")

    async def fake_launch_answer(websocket, session_id, text, response_id):
        launched.append(text)

    monkeypatch.setattr("app.main.settings.asr_realtime_model", "sherpa-zipformer-bilingual-zh-en")
    monkeypatch.setattr("app.main.get_asr_provider", lambda: StreamingAsr())
    monkeypatch.setattr("app.main.stream_realtime_answer", fake_launch_answer)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()

    with client.websocket_connect(f"/api/v1/realtime/{session['id']}") as websocket:
        assert websocket.receive_json()["type"] == "session.ready"
        assert websocket.receive_json()["type"] == "asr.stream"
        websocket.send_json({"type": "turn.start"})
        assert websocket.receive_json()["type"] == "transcription.started"
        assert websocket.receive_json()["type"] == "transcript.partial"
        assert websocket.receive_json()["type"] == "transcript.final"
        websocket.send_json({"type": "turn.end"})
        websocket.send_json({"type": "session.end"})
        assert websocket.receive_json()["type"] == "session.ended"

    assert launched == ["今天好累。"]


def test_realtime_empty_model_response_is_retried_once(monkeypatch):
    calls = []

    async def flaky_stream_chat(messages, **kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            raise ModelEmptyResponse("empty")
        yield "我还在。"

    monkeypatch.setattr("app.main.stream_chat", flaky_stream_chat)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()

    with client.websocket_connect(f"/api/v1/realtime/{session['id']}") as websocket:
        assert websocket.receive_json()["type"] == "session.ready"
        websocket.send_json({"type": "audio.chunk", "turn_id": "turn-retry", "mime_type": "audio/webm", "data": base64.b64encode(b"fake-audio").decode("ascii")})
        websocket.send_json({"type": "audio.commit", "turn_id": "turn-retry", "duration_ms": 1200, "language": "zh-CN"})
        assert websocket.receive_json()["type"] == "transcription.started"
        assert websocket.receive_json()["type"] == "transcript.final"
        assert websocket.receive_json()["type"] == "response.started"
        events = []
        while True:
            event = websocket.receive_json()
            events.append(event)
            if event["type"] in {"response.completed", "error"}:
                break
        websocket.send_json({"type": "session.end"})
        assert websocket.receive_json()["type"] == "session.ended"

    assert len(calls) == 2
    assert any(event["type"] == "model_retry" for event in events)
    assert any(event["type"] == "response.text.delta" and event["text"] == "我还在。" for event in events)


def test_realtime_streaming_tts_receives_turn_style(monkeypatch):
    captured = {}

    class FakeTtsProvider:
        async def synthesize_stream(self, text, voice, speed, style, emotion_vector=None):
            captured["text"] = text
            captured["speed"] = speed
            captured["style"] = style
            captured["emotion_vector"] = emotion_vector
            yield StreamingSynthesisEvent(kind="chunk", audio=b"pcm")
            yield StreamingSynthesisEvent(kind="done", sample_rate=24_000)

        async def open_stream(self):
            raise AssertionError("HTTP-style streaming should be used unless explicitly supported")

    async def fake_stream_chat(messages, **kwargs):
        yield "我听着呢，今天真的辛苦你了。"

    monkeypatch.setattr("app.speech.tts.get_tts_provider", lambda: FakeTtsProvider())
    monkeypatch.setattr("app.main.stream_chat", fake_stream_chat)
    client = TestClient(app)
    client.post("/api/v1/adult/consent", json={"confirmed": True})
    session = client.post("/api/v1/sessions", json={"mode": "girlfriend"}).json()

    with client.websocket_connect(f"/api/v1/realtime/{session['id']}") as websocket:
        assert websocket.receive_json()["type"] == "session.ready"
        websocket.send_json({"type": "audio.chunk", "turn_id": "turn-style", "mime_type": "audio/webm", "data": base64.b64encode(b"fake-audio").decode("ascii")})
        websocket.send_json({"type": "audio.commit", "turn_id": "turn-style", "duration_ms": 1200, "language": "zh-CN"})
        assert websocket.receive_json()["type"] == "transcription.started"
        assert websocket.receive_json()["type"] == "transcript.final"
        assert websocket.receive_json()["type"] == "response.started"
        while True:
            event = websocket.receive_json()
            if event["type"] in {"response.completed", "error"}:
                break
        websocket.send_json({"type": "session.end"})
        assert websocket.receive_json()["type"] == "session.ended"

    assert captured["text"].strip()
    assert captured["style"].strip()
    assert len(captured["emotion_vector"] or []) == 8
    assert 0.9 <= captured["speed"] <= 1.1
