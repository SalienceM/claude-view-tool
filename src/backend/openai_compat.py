"""OpenAICompatibleBackend — generic OpenAI-compatible /chat/completions."""
import sys, asyncio, json
from typing import Optional, Callable, Awaitable
import httpx
from ..types import ModelBackendConfig, ChatMessage, ImageAttachment, new_id
from .base import ModelBackend, StreamDelta, _exc_msg

# ---------------------------------------------------------------------------
#  OpenAI Compatible Backend (unchanged)
# ---------------------------------------------------------------------------

class OpenAICompatibleBackend(ModelBackend):

    async def send_message(
        self,
        messages: list[ChatMessage],
        content: str,
        images: Optional[list[ImageAttachment]],
        session_id: str,
        message_id: str,
        on_delta: Callable[[StreamDelta], None],
        skip_permissions: Optional[bool] = None,
        extra_tools: Optional[list[dict]] = None,
        on_tool_call: Optional[Callable] = None,
        constraints: Optional[str] = None,  # ★ Session-level constraints/rules/prompts
        **kwargs,
    ) -> dict:
        self.clear_cancelled(session_id)

        def emit(delta_type: str, **kw):
            if not self.is_cancelled(session_id):
                on_delta(StreamDelta(session_id, message_id, delta_type, **kw))

        try:
            # ★ 注入约束/提示词到 system message 中
            final_content = content
            if constraints:
                final_content = f"以下是你必须遵守的规则和约束：\n\n{constraints}\n\n---\n\n{content}"

            api_messages = []
            for m in messages:
                if m.role == "system":
                    continue
                if m.images:
                    # 历史消息含图片，重建 multimodal content 块
                    blocks: list[dict] = []
                    for img in m.images:
                        if img.base64:
                            blocks.append({
                                "type": "image_url",
                                "image_url": {"url": f"data:{img.mime_type};base64,{img.base64}"},
                            })
                    blocks.append({"type": "text", "text": m.content})
                    api_messages.append({"role": m.role, "content": blocks})
                else:
                    api_messages.append({"role": m.role, "content": m.content})

            current_content: list[dict] = []
            if images:
                for img in images:
                    if img.base64:
                        current_content.append({
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{img.mime_type};base64,{img.base64}"
                            },
                        })
            current_content.append({"type": "text", "text": final_content})
            api_messages.append({"role": "user", "content": current_content})

            base_url = self.config.base_url or "https://api.openai.com/v1"
            headers = {"Content-Type": "application/json"}
            if self.config.api_key:
                headers["Authorization"] = f"Bearer {self.config.api_key}"
            if self.config.extra_headers:
                headers.update(self.config.extra_headers)

            # 转换 Anthropic 格式 tools 到 OpenAI 格式
            oai_tools: Optional[list[dict]] = None
            oai_tool_names: set[str] = set()
            if extra_tools:
                oai_tools = []
                for t in extra_tools:
                    oai_tools.append({
                        "type": "function",
                        "function": {
                            "name": t["name"],
                            "description": t.get("description", ""),
                            "parameters": t.get("input_schema", {"type": "object", "properties": {}}),
                        },
                    })
                    oai_tool_names.add(t["name"])

            _RETRY_DELAYS = [1.0, 2.0, 4.0, 8.0, 8.0, 8.0, 8.0, 8.0, 8.0, 8.0]
            _MAX_RETRIES = len(_RETRY_DELAYS)
            _MAX_TOOL_ROUNDS = 10

            for _tool_round in range(_MAX_TOOL_ROUNDS + 1):
                data_emitted = False
                last_error: Optional[str] = None
                # 收集本轮 tool_calls
                _oai_tool_calls: dict[int, dict] = {}  # index → {id, name, arguments}
                _finish_reason: Optional[str] = None

                req_json: dict = {
                    "model": self.config.model or "gpt-4o",
                    "messages": api_messages,
                    "stream": True,
                }
                if oai_tools:
                    req_json["tools"] = oai_tools

                # ★ DEBUG：打印实际发给模型的完整消息（含约束/提示词），方便排查
                print(f"\n[OpenAI DEBUG] ===== 发送给模型的消息 (round={_tool_round}) =====",
                      file=sys.stderr, flush=True)
                for _i, _m in enumerate(api_messages):
                    _role = _m.get("role", "?")
                    _c = _m.get("content", "")
                    if isinstance(_c, list):
                        # multimodal content
                        _text_parts = [p.get("text", "") for p in _c if p.get("type") == "text"]
                        _c_preview = " ".join(_text_parts)
                    else:
                        _c_preview = str(_c) if _c else ""
                    # 截断太长的内容，只显示前500字
                    if len(_c_preview) > 500:
                        _c_preview = _c_preview[:500] + f"... (共{len(_c_preview)}字)"
                    print(f"[OpenAI DEBUG] [{_i}] role={_role}: {_c_preview!r}",
                          file=sys.stderr, flush=True)
                print(f"[OpenAI DEBUG] ===================================================\n",
                      file=sys.stderr, flush=True)

                for attempt in range(_MAX_RETRIES + 1):
                    if self.is_cancelled(session_id):
                        break
                    if attempt > 0:
                        delay = _RETRY_DELAYS[attempt - 1]
                        print(f"[OpenAI] retry {attempt}/{_MAX_RETRIES} in {delay}s ...",
                              file=sys.stderr, flush=True)
                        await asyncio.sleep(delay)
                    try:
                        async with httpx.AsyncClient(timeout=120.0) as client:
                            async with client.stream(
                                "POST",
                                f"{base_url}/chat/completions",
                                json=req_json,
                                headers=headers,
                            ) as response:
                                if response.status_code == 429 and attempt < _MAX_RETRIES:
                                    last_error = f"API error: 429 (rate limited, retrying {attempt+1}/{_MAX_RETRIES})"
                                    print(f"[OpenAI] 429 rate limit, will retry", file=sys.stderr, flush=True)
                                    continue
                                if response.status_code != 200:
                                    emit("error", error=f"API error: {response.status_code}")
                                    emit("done")
                                    return {}

                                async for line in response.aiter_lines():
                                    if self.is_cancelled(session_id):
                                        break
                                    line = line.strip()
                                    if not line.startswith("data: "):
                                        continue
                                    data = line[6:]
                                    if data == "[DONE]":
                                        break
                                    try:
                                        parsed = json.loads(data)
                                        choice = parsed.get("choices", [{}])[0]
                                        delta = choice.get("delta", {})
                                        fr = choice.get("finish_reason")
                                        if fr:
                                            _finish_reason = fr
                                        if delta.get("content"):
                                            emit("text_delta", text=delta["content"])
                                            data_emitted = True
                                        # 收集 tool_calls delta
                                        for tc_delta in delta.get("tool_calls", []):
                                            idx = tc_delta.get("index", 0)
                                            if idx not in _oai_tool_calls:
                                                _oai_tool_calls[idx] = {
                                                    "id": tc_delta.get("id", ""),
                                                    "name": tc_delta.get("function", {}).get("name", ""),
                                                    "arguments": "",
                                                }
                                                # emit tool_start
                                                emit("tool_start", tool_call={
                                                    "id": tc_delta.get("id", ""),
                                                    "name": tc_delta.get("function", {}).get("name", ""),
                                                    "input": "",
                                                    "status": "running",
                                                })
                                            else:
                                                if tc_delta.get("id"):
                                                    _oai_tool_calls[idx]["id"] = tc_delta["id"]
                                                if tc_delta.get("function", {}).get("name"):
                                                    _oai_tool_calls[idx]["name"] = tc_delta["function"]["name"]
                                            arg_delta = tc_delta.get("function", {}).get("arguments", "")
                                            if arg_delta:
                                                _oai_tool_calls[idx]["arguments"] += arg_delta
                                                emit("tool_input", tool_call={"inputDelta": arg_delta})
                                    except (json.JSONDecodeError, IndexError):
                                        pass
                        last_error = None
                        break  # success

                    except (httpx.ConnectError, httpx.NetworkError,
                            httpx.TimeoutException, httpx.RemoteProtocolError) as e:
                        if data_emitted or attempt >= _MAX_RETRIES:
                            last_error = _exc_msg(e)
                            break
                        last_error = _exc_msg(e)
                        print(f"[OpenAI] network error ({last_error}), will retry",
                              file=sys.stderr, flush=True)

                if last_error and not self.is_cancelled(session_id):
                    emit("error", error=last_error)
                    break

                # ── Backend Skill tool_use 处理 ──
                if (_finish_reason == "tool_calls" and _oai_tool_calls
                        and on_tool_call and oai_tool_names):
                    backend_tcs = {idx: tc for idx, tc in _oai_tool_calls.items()
                                   if tc["name"] in oai_tool_names}
                    if not backend_tcs:
                        break

                    # 构建 assistant 消息
                    assistant_tc_list = []
                    for idx in sorted(_oai_tool_calls.keys()):
                        tc = _oai_tool_calls[idx]
                        assistant_tc_list.append({
                            "id": tc["id"],
                            "type": "function",
                            "function": {"name": tc["name"], "arguments": tc["arguments"]},
                        })
                    api_messages.append({
                        "role": "assistant",
                        "content": None,
                        "tool_calls": assistant_tc_list,
                    })

                    # 执行 Backend Skill 工具
                    for idx in sorted(backend_tcs.keys()):
                        tc = backend_tcs[idx]
                        try:
                            args = json.loads(tc["arguments"]) if tc["arguments"] else {}
                        except json.JSONDecodeError:
                            args = {}
                        try:
                            result_text = await on_tool_call(tc["name"], args)
                            emit("tool_result", tool_call={
                                "id": tc["id"], "output": result_text, "status": "done",
                            })
                            api_messages.append({
                                "role": "tool",
                                "tool_call_id": tc["id"],
                                "content": result_text,
                            })
                        except Exception as te:
                            emit("tool_result", tool_call={
                                "id": tc["id"], "output": f"Error: {te}", "status": "error",
                            })
                            api_messages.append({
                                "role": "tool",
                                "tool_call_id": tc["id"],
                                "content": f"Error: {te}",
                            })

                    print(f"[OpenAI] Backend Skill round {_tool_round + 1}, "
                          f"tools: {[tc['name'] for tc in backend_tcs.values()]}",
                          file=sys.stderr, flush=True)
                    continue
                else:
                    break  # 无 tool_use，结束

            emit("done")
            return {}

        except Exception as e:
            if not self.is_cancelled(session_id):
                emit("error", error=_exc_msg(e))
            emit("done")
            return {}

