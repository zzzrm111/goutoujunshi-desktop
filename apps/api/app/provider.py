import httpx
import json
import re

from .config import settings


_model_client: httpx.AsyncClient | None = None


def get_model_client() -> httpx.AsyncClient:
    global _model_client
    client_type = httpx.AsyncClient
    if (
        _model_client is None
        or type(_model_client) is not client_type
        or getattr(_model_client, "is_closed", False)
    ):
        _model_client = httpx.AsyncClient(timeout=httpx.Timeout(90, connect=15, read=90, write=30, pool=5))
    return _model_client


async def close_model_client() -> None:
    global _model_client
    if _model_client is not None and not getattr(_model_client, "is_closed", False):
        await _model_client.aclose()
    _model_client = None


class ModelNotConfigured(Exception):
    pass


class ModelProviderUnavailable(Exception):
    pass


class ModelProviderRejected(Exception):
    pass


class ModelStreamInterrupted(Exception):
    pass


class ModelEmptyResponse(Exception):
    pass


async def stream_chat(messages: list[dict[str, str]], *args, **kwargs):
    if not settings.model_base_url or not settings.model_api_key or not settings.model_name:
        raise ModelNotConfigured("模型尚未配置。请在 apps/api/.env 中设置 MODEL_BASE_URL、MODEL_API_KEY 和 MODEL_NAME。")

    url = f"{settings.model_base_url.rstrip('/')}/chat/completions"
    headers = {"Authorization": f"Bearer {settings.model_api_key}"}
    max_tokens = kwargs.get("max_tokens")
    realtime = bool(kwargs.get("realtime"))
    model_name = settings.model_name
    if realtime and settings.model_realtime_name:
        model_name = settings.model_realtime_name
    payload = {
        "model": model_name,
        "messages": messages,
        "stream": True,
        "temperature": 0.88,
        "top_p": 0.92,
    }
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    stream_finished = False
    yielded_token = False
    try:
        async with get_model_client().stream("POST", url, headers=headers, json=payload) as response:
            if response.status_code >= 400:
                detail = (await response.aread()).decode("utf-8", errors="replace")[:300]
                raise ModelProviderRejected(f"模型服务返回 HTTP {response.status_code}：{detail}")
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    stream_finished = True
                    break
                try:
                    chunk = json.loads(data)
                    token = chunk["choices"][0].get("delta", {}).get("content")
                    if isinstance(token, str) and token:
                        yielded_token = True
                        yield token
                except (ValueError, KeyError, IndexError, TypeError):
                    continue
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout, httpx.NetworkError) as exc:
        raise ModelProviderUnavailable("无法连接模型服务，请检查网络或模型服务地址") from exc
    if not stream_finished:
        raise ModelStreamInterrupted("模型流式响应在完成前中断")
    if not yielded_token:
        raise ModelEmptyResponse("模型返回了空回答")


async def judge_relationship(messages: list[dict[str, str]], skill_instructions: str) -> dict[str, object] | None:
    """Ask the configured model for a constrained relationship event label."""
    if not settings.model_base_url or not settings.model_api_key or not settings.model_name:
        return None

    prompt = [
        {
            "role": "system",
            "content": (
                f"{skill_instructions}\n\n"
                "Analyze the recent conversation, focusing on the latest user turn. "
                "Return one JSON object only: {\"kind\": string, \"confidence\": number, \"trigger\": string}. "
                "kind must be one of neutral, apology, insult, threat, dismissal, admitted_lie, "
                "broken_promise, cold_treatment. Do not infer wrongdoing from a user setting a boundary, "
                "asking for space, complaining about the AI, or asking whether the AI lied. "
                "Only label admitted_lie or broken_promise when the user explicitly admits it. "
                "Use neutral when evidence is ambiguous."
            ),
        },
        *messages[-9:],
    ]
    url = f"{settings.model_base_url.rstrip('/')}/chat/completions"
    headers = {"Authorization": f"Bearer {settings.model_api_key}"}
    payload = {
        "model": settings.model_name,
        "messages": prompt,
        "stream": False,
        "temperature": 0,
        "max_tokens": 160,
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(12, connect=5)) as client:
        response = await client.post(url, headers=headers, json=payload)
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
    if not isinstance(content, str):
        return None
    match = re.search(r"\{.*\}", content, re.S)
    if not match:
        return None
    try:
        result = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(result, dict):
        return None
    kind = result.get("kind")
    confidence = result.get("confidence")
    trigger = result.get("trigger", "")
    if kind not in {"neutral", "apology", "insult", "threat", "dismissal", "admitted_lie", "broken_promise", "cold_treatment"}:
        return None
    if not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        return None
    if not isinstance(trigger, str):
        trigger = ""
    return {"kind": kind, "confidence": float(confidence), "trigger": trigger[:120]}
