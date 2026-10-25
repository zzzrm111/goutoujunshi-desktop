#!/usr/bin/env python3
"""读取 VRM 文件里的授权元数据，判断能否公开分发。

用法：
    python scripts/check-vrm-license.py path/to/model.vrm [更多文件...]

退出码：
    0 = 可以分发，或文件没有 VRM 元数据（例如 .vrma）
    1 = 存在禁止再分发的声明，或文件无法解析
"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def read_glb_json(path: Path) -> dict:
    data = path.read_bytes()
    if len(data) < 20:
        raise ValueError("文件太小，不是有效的 GLB/VRM")
    magic, version, _length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF":
        raise ValueError("不是 GLB/VRM 容器（magic 不是 glTF）")
    offset = 12
    chunk_length, chunk_type = struct.unpack_from("<I4s", data, offset)
    if chunk_type != b"JSON":
        raise ValueError("第一个 chunk 不是 JSON")
    raw = data[offset + 8 : offset + 8 + chunk_length]
    return json.loads(raw.decode("utf-8").rstrip("\x00 "))


def extract_meta(document: dict) -> tuple[str, dict] | None:
    extensions = document.get("extensions") or {}
    vrm1 = extensions.get("VRMC_vrm")
    if isinstance(vrm1, dict):
        return "VRM 1.0", vrm1.get("meta") or {}
    vrm0 = extensions.get("VRM")
    if isinstance(vrm0, dict):
        return "VRM 0.x", vrm0.get("meta") or {}
    return None


def check(path: Path) -> bool:
    print(f"\n== {path} ==")
    try:
        document = read_glb_json(path)
    except Exception as exc:  # noqa: BLE001 - 命令行工具，直接展示原因
        print(f"  [FAIL] 无法解析：{exc}")
        return False

    result = extract_meta(document)
    if result is None:
        print("  [SKIP] 没有 VRM 授权元数据（可能是 .vrma 动画）")
        return True

    spec, meta = result
    print(f"  格式：{spec}")
    print(f"  名称：{meta.get('name', '(未填写)')}")
    print(f"  作者：{meta.get('authors') or meta.get('author') or '(未填写)'}")

    problems: list[str] = []

    redistribution = meta.get("allowRedistribution")
    if redistribution is False:
        problems.append("allowRedistribution = false（禁止再分发）")

    avatar_permission = str(meta.get("avatarPermission", "")).lower()
    if avatar_permission == "onlyauthor":
        problems.append("avatarPermission = onlyAuthor（仅作者可用）")

    modification = str(meta.get("modification", "")).lower()
    if modification == "prohibited":
        problems.append("modification = prohibited（禁止修改）")

    commercial = str(meta.get("commercialUsage", "")).lower()
    if commercial and commercial not in {"personalnonprofit", "corporation", "personalprofit"}:
        problems.append(f"commercialUsage = {commercial}（需人工确认）")

    for key in (
        "allowRedistribution",
        "avatarPermission",
        "commercialUsage",
        "creditNotation",
        "modification",
    ):
        if key in meta:
            print(f"  {key}: {meta[key]}")

    if problems:
        for item in problems:
            print(f"  [FAIL] {item}")
        print("  结论：不要把这个模型提交到公开仓库。")
        return False

    print("  [PASS] 元数据未发现禁止再分发的声明。仍建议核对原作者的完整许可条款。")
    return True


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    ok = True
    for raw in sys.argv[1:]:
        path = Path(raw)
        if not path.exists():
            print(f"\n== {path} ==\n  [FAIL] 文件不存在")
            ok = False
            continue
        ok = check(path) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())