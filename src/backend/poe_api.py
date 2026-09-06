"""Small, read-only client for Poe's model catalog and point balance APIs."""

from __future__ import annotations

import asyncio
import time
from typing import Any, Optional

import httpx


POE_MODELS_URL = "https://api.poe.com/v1/models"
POE_BALANCE_URL = "https://api.poe.com/usage/current_balance"


def _response_error(label: str, response: httpx.Response) -> str:
    detail = ""
    try:
        payload = response.json()
        if isinstance(payload, dict):
            detail = str(payload.get("detail") or payload.get("message") or payload.get("error") or "")
    except Exception:
        detail = ""
    suffix = f"：{detail[:300]}" if detail else ""
    return f"{label}请求失败（HTTP {response.status_code}）{suffix}"


def _created_ms(value: Any) -> int:
    try:
        created = int(value or 0)
    except (TypeError, ValueError):
        return 0
    # OpenAI-compatible providers are inconsistent here: accept seconds or milliseconds.
    return created * 1000 if 0 < created < 100_000_000_000 else created


async def fetch_poe_overview(
    api_key: str = "",
    *,
    transport: Optional[httpx.AsyncBaseTransport] = None,
    timeout: float = 20.0,
) -> dict[str, Any]:
    """Fetch a fresh Poe API catalog and, when authorized, the current point balance.

    The two requests are intentionally independent.  A missing/expired key must not hide
    the public model catalog, while a temporary catalog failure must not hide a valid
    account balance.
    """

    key = str(api_key or "").strip()
    async with httpx.AsyncClient(timeout=timeout, transport=transport) as client:
        async def load_models() -> tuple[list[dict[str, Any]], str]:
            try:
                response = await client.get(POE_MODELS_URL, headers={"Accept": "application/json"})
                if response.status_code != 200:
                    return [], _response_error("Poe 模型目录", response)
                payload = response.json()
                raw_models = payload.get("data", []) if isinstance(payload, dict) else []
                if not isinstance(raw_models, list):
                    return [], "Poe 模型目录响应缺少 data 数组"
                models: list[dict[str, Any]] = []
                seen: set[str] = set()
                for item in raw_models[:2_000]:
                    if not isinstance(item, dict):
                        continue
                    model_id = str(item.get("id") or "").strip()
                    if not model_id or model_id in seen:
                        continue
                    seen.add(model_id)
                    models.append({
                        "id": model_id[:240],
                        "createdAt": _created_ms(item.get("created")),
                        "description": str(item.get("description") or "")[:2_000],
                        "ownedBy": str(item.get("owned_by") or "")[:120],
                    })
                models.sort(key=lambda item: (item["createdAt"], item["id"]), reverse=True)
                return models, ""
            except (httpx.HTTPError, ValueError, TypeError) as exc:
                return [], f"Poe 模型目录读取失败：{exc}"

        async def load_balance() -> tuple[Optional[int], str]:
            if not key:
                return None, "请填写 Poe API Key 后刷新余额"
            try:
                response = await client.get(
                    POE_BALANCE_URL,
                    headers={"Accept": "application/json", "Authorization": f"Bearer {key}"},
                )
                if response.status_code != 200:
                    return None, _response_error("Poe 积分余额", response)
                payload = response.json()
                raw_balance = payload.get("current_point_balance") if isinstance(payload, dict) else None
                if isinstance(raw_balance, bool) or not isinstance(raw_balance, (int, float)):
                    return None, "Poe 积分响应缺少 current_point_balance"
                return max(0, int(raw_balance)), ""
            except (httpx.HTTPError, ValueError, TypeError) as exc:
                return None, f"Poe 积分余额读取失败：{exc}"

        (models, catalog_error), (balance, balance_error) = await asyncio.gather(
            load_models(), load_balance(),
        )

    return {
        "status": "ok" if models or balance is not None else "error",
        "models": models,
        "modelCount": len(models),
        "catalogError": catalog_error,
        "currentPointBalance": balance,
        "balanceError": balance_error,
        "fetchedAt": int(time.time() * 1000),
    }
