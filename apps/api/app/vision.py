import base64

import httpx

from .config import settings


class VisionNotConfigured(Exception):
    pass


class VisionProviderUnavailable(Exception):
    pass


class VisionProviderRejected(Exception):
    pass


class VisionEmptyResponse(Exception):
    pass


async def analyze_image(image: bytes, mime_type: str, prompt: str = "") -> str:
    """Return a short description of one image without persisting image bytes."""
    if settings.vision_provider == "mock":
        return "图片已收到。当前使用本地模拟视觉服务，尚未提取图片内容。"
    if settings.vision_provider != "cloud":
        raise VisionNotConfigured(f"不支持的视觉服务：{settings.vision_provider}")
    if not settings.vision_base_url or not settings.vision_api_key or not settings.vision_model:
        raise VisionNotConfigured("视觉服务尚未配置")
    encoded = base64.b64encode(image).decode("ascii")
    instruction = prompt.strip() or (
        "请用简洁中文描述这张图片的主要内容、可见文字、场景和明显情绪线索。"
        "只描述图片中能确认的信息，不要推测现实身份、地点或敏感属性。"
    )
    payload = {
        "model": settings.vision_model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": instruction},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{mime_type};base64,{encoded}"},
                    },
                ],
            }
        ],
        "stream": False,
        "temperature": 0.2,
        "max_tokens": 300,
    }
    url = f"{settings.vision_base_url.rstrip('/')}/chat/completions"
    headers = {"Authorization": f"Bearer {settings.vision_api_key}"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(90, connect=15)) as client:
            response = await client.post(url, headers=headers, json=payload)
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout, httpx.NetworkError) as exc:
        raise VisionProviderUnavailable("无法连接视觉服务") from exc
    if response.status_code >= 400:
        detail = response.text[:240]
        raise VisionProviderRejected(f"视觉服务返回 HTTP {response.status_code}：{detail}")
    try:
        content = response.json()["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise VisionEmptyResponse("视觉服务返回了无效结果") from exc
    if not isinstance(content, str) or not content.strip():
        raise VisionEmptyResponse("视觉服务没有返回描述")
    return content.strip()[:1200]
