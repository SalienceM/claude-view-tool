"""QwenCodeSdkBackend — uses qwen-code-sdk (official Python SDK).

Migration from manual CLI subprocess to official SDK:
  - Old: subprocess.Popen("qwen -p <content> -o stream-json") + manual JSON parsing
  - New: qwen_code_sdk.query() with proper system_prompt injection

Key improvements:
  - System prompt: uses `append_system_prompt` instead of hacking into -p
  - Stream format: SDK handles stream-json parsing internally
  - Permission control: uses `permission_mode='yolo'` + `can_use_tool` callback
  - Session management: uses `resume` / `session_id` parameters
  - Error handling: typed exceptions (ProcessExitError, ValidationError, AbortError)

Message format compatibility:
  SDK returns the same Anthropic stream-json protocol, so frontend parsers
  need NO changes.
"""
import os
import sys
import json
import asyncio
import base64
import re
import shutil
import tempfile
import time
from typing import Optional, Callable, Awaitable, Any

from ..types import ModelBackendConfig, ChatMessage, ImageAttachment
from .base import ModelBackend, StreamDelta, PermissionRequest, _exc_msg, cli_available, cli_missing_message


DEFAULT_QWEN_MAX_OUTPUT_TOKENS = 32_000


def _positive_token_limit(value: Any) -> Optional[int]:
    """Normalize persisted/UI token limits without accepting bool/invalid values."""
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if parsed > 0 else None

# ---------------------------------------------------------------------------
#  CLI path resolution (fallback if SDK needs it)
# ---------------------------------------------------------------------------

def resolve_qwen_cli(config_cli_path: Optional[str] = None) -> str:
    """Resolve the qwen CLI path: config → npm global → system PATH."""
    if config_cli_path:
        return str(config_cli_path)

    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA", "")
        if appdata:
            for name in ("qwen.cmd", "qwen.ps1", "qwen"):
                p = os.path.join(appdata, "npm", name)
                if os.path.exists(p):
                    return p

    import shutil as _shutil
    return _shutil.which("qwen") or "qwen"


def _qwen_image_suffix(mime_type: str) -> str:
    """Return a conservative extension understood by Qwen's @file loader."""
    return {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "image/bmp": ".bmp",
    }.get((mime_type or "").lower(), ".png")


def _materialize_qwen_images(
    images: list[ImageAttachment], cwd: str, message_id: str,
) -> tuple[list[str], Optional[str]]:
    """Write UI images under cwd for Qwen CLI's native ``@file`` parser.

    qwen-code-sdk's AsyncIterable input currently serializes non-text content
    blocks as text before invoking the model.  Using Qwen's own file-reference
    syntax preserves actual multimodal input and also keeps every temporary
    artifact inside the session working directory.
    """
    root = os.path.abspath(cwd)
    # Do not place these under ``.qwen``.  This project intentionally ignores
    # that directory and Qwen's @file preprocessor respects .gitignore, so an
    # image stored there is silently skipped before it can become inlineData.
    # The ordinary workspace directory below exists only for the duration of
    # the turn and is removed in ``send_message``'s finally block.
    parent = os.path.join(root, "awu-qwen-attachments")
    os.makedirs(parent, exist_ok=True)
    safe_id = re.sub(r"[^A-Za-z0-9_.-]", "-", message_id or "message")[:64]
    temp_dir = tempfile.mkdtemp(prefix=f"awu-{safe_id}-", dir=parent)
    refs: list[str] = []
    try:
        for index, image in enumerate(images):
            raw: Optional[bytes] = None
            encoded = image.base64 or ""
            if encoded:
                if encoded.startswith("data:") and "," in encoded:
                    encoded = encoded.split(",", 1)[1]
                raw = base64.b64decode(encoded, validate=False)
            elif image.file_path:
                candidate = os.path.abspath(image.file_path)
                try:
                    in_workspace = os.path.commonpath((root, candidate)) == root
                except ValueError:
                    in_workspace = False
                if in_workspace and os.path.isfile(candidate):
                    with open(candidate, "rb") as source:
                        raw = source.read()
            if not raw:
                continue
            target = os.path.join(
                temp_dir, f"image-{index + 1}{_qwen_image_suffix(image.mime_type)}",
            )
            with open(target, "wb") as output:
                output.write(raw)
            refs.append(os.path.relpath(target, root).replace("\\", "/"))
    except Exception:
        shutil.rmtree(temp_dir, ignore_errors=True)
        try:
            os.rmdir(parent)
        except OSError:
            pass
        raise
    if not refs:
        shutil.rmtree(temp_dir, ignore_errors=True)
        try:
            os.rmdir(parent)
        except OSError:
            pass
        return [], None
    return refs, temp_dir


# ---------------------------------------------------------------------------
#  Backend implementation
# ---------------------------------------------------------------------------

class QwenCodeSdkBackend(ModelBackend):
    """Qwen Code SDK backend.

    Uses the official `qwen-code-sdk` Python package for proper integration.
    Keeps feature parity with ClaudeAgentBackend by enabling Skill, Task/subagent,
    TodoWrite, and ExitPlanMode tools when the backend config does not override
    tool selection. System prompt injection is handled via `append_system_prompt`.
    """

    def follow_up_capabilities(self) -> dict:
        return {
            "queue": True,
            "nativeSteer": False,
            "interruptResume": True,
            "steerAttachments": False,
        }

    def abort(self, session_id: Optional[str] = None):
        """取消标记之外，主动关闭正在等待的 SDK Query/CLI 子进程。

        仅靠 ModelBackend 的 cancelled 标记，要等 SDK 再吐出一条事件才会生效；
        Bash 已经挂住时恰好不会再有事件，因此 LOOP 看门狗必须能直接 close。
        """
        super().abort(session_id)
        active = getattr(self, "_active_queries", {})
        targets = [
            query for sid, query in list(active.items())
            if session_id is None or sid == session_id
        ]
        for query in targets:
            try:
                self._detach_query_cleanup(query)
            except RuntimeError:
                # 没有活动事件循环时保留 cancelled 标记；正常 RPC/LOOP 路径
                # 总在 asyncio loop 内，会走上面的主动关闭。
                pass

    def _resolve_cli(self) -> str:
        return resolve_qwen_cli(getattr(self.config, "cli_path", None))

    def _detach_query_cleanup(self, result: Any) -> None:
        """Close a terminal SDK query without delaying the completed turn.

        Qwen's transport waits up to five seconds for the CLI process after a
        terminal result. Starting close here marks Query closed immediately;
        the surrounding context manager then exits without repeating that wait,
        while process cleanup finishes in a tracked background task.
        """
        task = asyncio.create_task(result.close(), name="qwen-sdk-cleanup")
        cleanup_tasks = getattr(self, "_cleanup_tasks", None)
        if cleanup_tasks is None:
            cleanup_tasks = set()
            self._cleanup_tasks = cleanup_tasks
        cleanup_tasks.add(task)
        def _finished(done_task: asyncio.Task) -> None:
            cleanup_tasks.discard(done_task)
            try:
                done_task.result()
            except (asyncio.CancelledError, Exception) as exc:
                print(f"[QwenSdk] background cleanup failed: {exc}",
                      file=sys.stderr, flush=True)
        task.add_done_callback(_finished)


    def _ensure_project_auth_settings(
        self,
        cwd: str,
        auth_type: str,
        model: Optional[str],
        enable_image_input: bool = False,
    ) -> None:
        """Ensure Qwen CLI has a non-interactive auth selection.

        Some Qwen CLI versions still require `security.auth.selectedType` in
        settings even when the SDK passes `--auth-type`.  Keep this file in the
        session/project workspace (not the user's home) and only write non-secret
        routing metadata; API keys remain in the process environment.
        """
        if not cwd:
            return
        context_window_size = _positive_token_limit(
            getattr(self.config, "qwen_context_window_size", None),
        )
        requested_max_output = _positive_token_limit(
            getattr(self.config, "qwen_max_output_tokens", None),
        )
        max_output_tokens = requested_max_output or DEFAULT_QWEN_MAX_OUTPUT_TOKENS
        if context_window_size and max_output_tokens >= context_window_size:
            # 手工导入的旧配置可能绕过 UI 校验；运行时仍要保证不会再次构造
            # max_tokens >= 总上下文的必错请求。
            max_output_tokens = max(1, min(
                DEFAULT_QWEN_MAX_OUTPUT_TOKENS,
                context_window_size // 4,
            ))
            print(
                "[QwenSdk] max output token limit exceeded context window; "
                f"using safe fallback {max_output_tokens}",
                file=sys.stderr,
                flush=True,
            )
        cache_key = (
            os.path.abspath(cwd), auth_type, model or "", enable_image_input,
            context_window_size, max_output_tokens,
        )
        if cache_key in getattr(self, "_auth_settings_cache", set()):
            return
        try:
            from pathlib import Path as _Path
            settings_dir = _Path(cwd) / ".qwen"
            settings_path = settings_dir / "settings.json"
            data: dict[str, Any] = {}
            if settings_path.exists():
                try:
                    loaded = json.loads(settings_path.read_text(encoding="utf-8"))
                    if isinstance(loaded, dict):
                        data = loaded
                except Exception:
                    data = {}

            security = data.setdefault("security", {})
            if not isinstance(security, dict):
                security = {}
                data["security"] = security
            auth = security.setdefault("auth", {})
            if not isinstance(auth, dict):
                auth = {}
                security["auth"] = auth
            auth["selectedType"] = auth_type

            if model and model not in ("default",):
                model_cfg = data.setdefault("model", {})
                if not isinstance(model_cfg, dict):
                    model_cfg = {}
                    data["model"] = model_cfg
                model_cfg.setdefault("name", model)

            # Token limits are Backend policy, not a controller-only preference.
            # Persist them in this executor's project settings so the external
            # Qwen CLI applies the same boundary for local and Relay requests.
            model_cfg = data.setdefault("model", {})
            if not isinstance(model_cfg, dict):
                model_cfg = {}
                data["model"] = model_cfg
            generation_cfg = model_cfg.setdefault("generationConfig", {})
            if not isinstance(generation_cfg, dict):
                generation_cfg = {}
                model_cfg["generationConfig"] = generation_cfg
            if context_window_size:
                generation_cfg["contextWindowSize"] = context_window_size
            sampling_params = generation_cfg.setdefault("samplingParams", {})
            if not isinstance(sampling_params, dict):
                sampling_params = {}
                generation_cfg["samplingParams"] = sampling_params
            sampling_params["max_tokens"] = max_output_tokens

            # Qwen Code uses a built-in name table to decide whether an
            # @referenced image may be converted to inlineData.  New/custom
            # visual model IDs (for example qwen3.7-plus) can be absent from
            # that table and are otherwise downgraded to text with an
            # "Unsupported image" placeholder.  An actual image attachment
            # is an explicit capability signal from AgentWithU, so override
            # only the image modality while preserving all user settings.
            if enable_image_input:
                modalities = generation_cfg.setdefault("modalities", {})
                if not isinstance(modalities, dict):
                    modalities = {}
                    generation_cfg["modalities"] = modalities
                modalities["image"] = True

            settings_dir.mkdir(parents=True, exist_ok=True)
            settings_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            cache = getattr(self, "_auth_settings_cache", None)
            if cache is None:
                cache = set()
                self._auth_settings_cache = cache
            cache.add(cache_key)
            print(f"[QwenSdk] ensured project auth settings: {settings_path} selectedType={auth_type}",
                  file=sys.stderr, flush=True)
        except Exception as e:
            print(f"[QwenSdk] failed to ensure project auth settings: {e}", file=sys.stderr, flush=True)

    def _build_env(self) -> dict:
        """Build environment dict for SDK.

        Strategy:
          1. Auto-detect system proxy
          2. Backend config env overrides
          3. Map QWEN_PROVIDER → QWEN_AUTH_TYPE
          4. Convenience alias: api_key → OPENAI_API_KEY / DASHSCOPE_API_KEY
        """
        import urllib.request as _urllib_req

        # The SDK starts the external `qwen` CLI via subprocess.  Keep the
        # parent environment (especially PATH/PATHEXT/SystemRoot on Windows)
        # so npm shims such as qwen.cmd can find node.exe and dependencies.
        proc_env: dict[str, str] = os.environ.copy()

        # Auto-detect system proxy
        _already_has_proxy = any(
            os.environ.get(k)
            for k in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy")
        )
        if not _already_has_proxy:
            try:
                sys_proxies = _urllib_req.getproxies()
                for scheme, env_keys in [("https", ("HTTPS_PROXY", "https_proxy")),
                                         ("http", ("HTTP_PROXY", "http_proxy"))]:
                    url = sys_proxies.get(scheme)
                    if url:
                        for k in env_keys:
                            proc_env.setdefault(k, url)
                _detected = proc_env.get("HTTPS_PROXY") or proc_env.get("https_proxy") or "none"
                print(f"[QwenSdk] proxy auto-detect: {_detected}",
                      file=sys.stderr, flush=True)
            except Exception as _pe:
                print(f"[QwenSdk] proxy detect failed (harmless): {_pe}",
                      file=sys.stderr, flush=True)

        # Backend config env overrides
        for key in (
            "DASHSCOPE_API_KEY", "DASHSCOPE_API_TOKEN",
            "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE",
            "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
            "GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
            "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
            "https_proxy", "http_proxy", "all_proxy", "no_proxy",
            "QWEN_MODEL", "QWEN_AUTH_TYPE", "QWEN_PROVIDER",
            "QWEN_CODE_SUPPRESS_YOLO_WARNING",
        ):
            val = self.config.get_env(key)
            if val is not None:
                if val:
                    proc_env[key] = val
                else:
                    proc_env.pop(key, None)

        # Map QWEN_PROVIDER → QWEN_AUTH_TYPE
        provider = proc_env.get("QWEN_PROVIDER") or proc_env.get("QWEN_AUTH_TYPE")
        if provider:
            proc_env["QWEN_AUTH_TYPE"] = provider

        # Convenience alias: api_key → OPENAI_API_KEY / DASHSCOPE_API_KEY
        if self.config.api_key:
            auth_type = proc_env.get("QWEN_AUTH_TYPE", "openai")
            if auth_type == "openai":
                proc_env.setdefault("OPENAI_API_KEY", self.config.api_key)
            elif auth_type == "qwen-oauth":
                proc_env.setdefault("DASHSCOPE_API_KEY", self.config.api_key)
            elif auth_type == "anthropic":
                proc_env.setdefault("ANTHROPIC_API_KEY", self.config.api_key)

        # qwen-oauth fallback: DASHSCOPE_API_KEY → OPENAI_API_KEY
        _final_auth = proc_env.get("QWEN_AUTH_TYPE") or proc_env.get("QWEN_PROVIDER")
        if _final_auth == "qwen-oauth":
            _ds_key = proc_env.get("DASHSCOPE_API_KEY")
            if _ds_key and not proc_env.get("OPENAI_API_KEY"):
                proc_env["OPENAI_API_KEY"] = _ds_key
                print("[QwenSdk] qwen-oauth: mapped DASHSCOPE_API_KEY → OPENAI_API_KEY (fallback)",
                      file=sys.stderr, flush=True)
            if not proc_env.get("OPENAI_BASE_URL"):
                proc_env["OPENAI_BASE_URL"] = (
                    "https://dashscope.aliyuncs.com/compatible-mode/v1"
                )

        return proc_env

    async def send_message(
        self,
        messages: list[ChatMessage],
        content: str,
        images: Optional[list[ImageAttachment]],
        session_id: str,
        message_id: str,
        on_delta: Callable[[StreamDelta], None],
        agent_session_id: Optional[str] = None,
        working_dir: Optional[str] = None,
        skip_permissions: Optional[bool] = None,
        on_permission_request: Optional[Callable[[PermissionRequest], Awaitable[bool]]] = None,
        constraints: Optional[str] = None,
        sandbox_enabled: bool = True,
        model_override: Optional[str] = None,
    ) -> dict:
        self.clear_cancelled(session_id)

        def emit(delta_type: str, **kwargs):
            if not self.is_cancelled(session_id):
                on_delta(StreamDelta(session_id, message_id, delta_type, **kwargs))

        # Load SDK
        try:
            from qwen_code_sdk import query as sdk_query
            from qwen_code_sdk import (
                ProcessExitError,
                is_sdk_assistant_message,
                is_sdk_result_message,
                is_sdk_partial_assistant_message,
                is_sdk_user_message,
            )
        except ImportError as _imp_err:
            import traceback as _tb
            _detail = str(_imp_err)
            print(f"[QwenSdk] ImportError: {_detail}\n{_tb.format_exc()}", file=sys.stderr, flush=True)
            emit("error", error=f"qwen-code-sdk 加载失败：{_detail}\n请确认：pip install qwen-code-sdk")
            emit("done")
            return {}

        cwd = working_dir or getattr(self.config, "working_dir", None) or "."
        model = (model_override or "").strip() or self.get_env("QWEN_MODEL") or self.config.model
        auth_type = (self.get_env("QWEN_PROVIDER")
                     or self.get_env("QWEN_AUTH_TYPE")
                     or "openai")

        # Allowed tools
        # Qwen Code expects native snake_case tool IDs (for example
        # `run_shell_command`, `todo_write`, `agent`, `exit_plan_mode`).  Do not
        # pass Claude-style CamelCase defaults here: the CLI validates tool IDs
        # during SDK initialization and exits with code 1 for unknown names.  When
        # no explicit backend allow-list is configured, omit `allowed_tools` so
        # Qwen enables its full built-in agent surface.
        configured_tools = list(getattr(self.config, "allowed_tools", None) or [])
        tool_aliases = {
            "Read": "read_file",
            "Write": "write_file",
            "Edit": "edit",
            "Bash": "run_shell_command",
            "Glob": "glob",
            "Grep": "grep_search",
            "TodoWrite": "todo_write",
            "Task": "agent",
            "ExitPlanMode": "exit_plan_mode",
            "WebFetch": "web_fetch",
            "NotebookEdit": "notebook_edit",
        }
        tools: list[str] = []
        if configured_tools:
            seen_tools: set[str] = set()
            for tool in configured_tools:
                native_tool = tool_aliases.get(tool, tool)
                if native_tool and native_tool not in seen_tools:
                    tools.append(native_tool)
                    seen_tools.add(native_tool)
            for required_tool in ("todo_write", "agent", "exit_plan_mode"):
                if required_tool not in seen_tools:
                    tools.append(required_tool)
                    seen_tools.add(required_tool)

        # Permission mode
        if skip_permissions is None:
            skip_permissions = getattr(self.config, "skip_permissions", True)
        permission_mode = "yolo" if skip_permissions else "default"

        # Environment
        env_dict = self._build_env()
        if permission_mode == "yolo":
            # The application already exposes this permission choice in its UI;
            # avoid repeating Qwen's headless warning on every request.  An
            # explicit backend env value still wins over this default.
            env_dict.setdefault("QWEN_CODE_SUPPRESS_YOLO_WARNING", "1")
        self._ensure_project_auth_settings(
            cwd, auth_type, model, enable_image_input=bool(images),
        )
        print(f"[QwenSdk] auth: {auth_type}, model={model!r}, permission_mode={permission_mode}",
              file=sys.stderr, flush=True)

        qwen_cli = self._resolve_cli()
        if not cli_available(qwen_cli):
            emit("error", error=cli_missing_message(
                "Qwen Code",
                qwen_cli,
                "npm install -g @qwen-code/qwen-code@latest",
                "Qwen Code 官方文档要求较新的 Node.js；若安装后仍不可用，请确认 npm global bin 已加入 PATH。",
            ))
            emit("done")
            return {"agentSessionId": agent_session_id}

        # Qwen's stream-json SDK input currently consumes only text.  Feed
        # images through the CLI's native @file path instead of passing a dict
        # (which is neither AsyncIterable nor interpreted as multimodal data).
        _image_temp_dir: Optional[str] = None
        image_refs: list[str] = []
        if images:
            try:
                image_refs, _image_temp_dir = _materialize_qwen_images(
                    images, cwd, message_id,
                )
            except Exception as image_error:
                emit("error", error=f"Qwen 图片附件准备失败: {_exc_msg(image_error)}")
                emit("done")
                return {"agentSessionId": agent_session_id}
        prompt = "\n".join(f"@{path}" for path in image_refs)
        if prompt:
            prompt += "\n\n"
        prompt += content
        if image_refs:
            print(f"[QwenSdk] images: {len(image_refs)} @file attachment(s)",
                  file=sys.stderr, flush=True)

        # SDK options
        options = {
            "cwd": cwd,
            "model": model if model and model not in ("default",) else None,
            "path_to_qwen_executable": qwen_cli,
            "permission_mode": permission_mode,
            "auth_type": auth_type,
            "include_partial_messages": True,  # Stream partial messages
            # stream-json 的确认协议不传递 ask_user_question.answers；自动 allow
            # 会产生空答案。改走正常文本问答，让 CLI 正常发出 terminal result。
            "exclude_tools": ["ask_user_question"],
            "env": env_dict if env_dict else None,
        }
        if tools:
            options["allowed_tools"] = tools

        # System prompt injection (★ KEY IMPROVEMENT)
        # A resumed Qwen session already owns the system prompt from its first
        # turn. Re-appending the full constraints on every request increases
        # CLI startup/argument parsing time and can duplicate instructions.
        if constraints and not agent_session_id:
            options["append_system_prompt"] = constraints
            print(f"[QwenSdk] constraints injected via append_system_prompt ({len(constraints)} chars)",
                  file=sys.stderr, flush=True)

        question_guidance = (
            "When you need clarification or user confirmation, ask in your final text "
            "response and end the turn. The user will reply in the next chat turn. "
            "Do not use ask_user_question or a shell command to wait for user input."
        )
        options["append_system_prompt"] = "\n\n".join(filter(None, (
            options.get("append_system_prompt"), question_guidance,
        )))

        # Session resume
        if agent_session_id:
            options["resume"] = agent_session_id

        # stderr callback
        _stderr_lines: list[str] = []
        def _on_stderr(line: str):
            line = line.rstrip()
            if line:
                _stderr_lines.append(line)
                if len(_stderr_lines) > 50:
                    del _stderr_lines[:-50]
                print(f"[QwenSdk][stderr] {line}", file=sys.stderr, flush=True)
        options["stderr"] = _on_stderr

        def _display_tool_name(tool_name: str) -> str:
            return {
                "read_file": "Read",
                "write_file": "Write",
                "edit": "Edit",
                "run_shell_command": "Bash",
                "glob": "Glob",
                "grep_search": "Grep",
                "notebook_edit": "NotebookEdit",
                "todo_write": "TodoWrite",
                "agent": "Task",
                "exit_plan_mode": "ExitPlanMode",
                "web_fetch": "WebFetch",
            }.get(tool_name, tool_name)

        # Sandbox tools
        SANDBOX_TOOLS = {
            "Read", "Write", "Edit", "Bash", "Glob", "Grep", "NotebookEdit",
            "read_file", "write_file", "edit", "run_shell_command", "glob",
            "grep_search", "notebook_edit",
        }

        # Permission-sensitive tools
        PERMISSION_SENSITIVE_TOOLS = {"Bash", "Edit", "Write", "run_shell_command", "edit", "write_file"}

        def _tool_input_to_text(tool_input: Any) -> str:
            if isinstance(tool_input, str):
                return tool_input
            try:
                return json.dumps(tool_input, ensure_ascii=False)
            except Exception:
                return str(tool_input)

        # Permission callback
        async def _can_use_tool(tool_name: str, tool_input: dict, context) -> dict:
            """SDK permission callback. Returns PermissionAllowResult or PermissionDenyResult."""
            # 兼容旧版 CLI/恢复的原生线程仍然请求此工具的情况；不得伪造用户答案。
            if tool_name in {"ask_user_question", "AskUserQuestion"}:
                return {"behavior": "deny", "message": question_guidance}
            # Sandbox validation
            if sandbox_enabled and cwd and tool_name in SANDBOX_TOOLS:
                from .bridge_ws import validate_tool_sandbox
                _ok, _reason = validate_tool_sandbox(
                    _display_tool_name(tool_name), _tool_input_to_text(tool_input), cwd
                )
                if not _ok:
                    print(f"[QwenSdk] sandbox violation: {tool_name} — {_reason}",
                          file=sys.stderr, flush=True)
                    emit("error", error=f"🔒 沙盒违规：{_reason}")
                    return {"behavior": "deny", "message": f"沙盒违规: {_reason}"}

            if skip_permissions:
                return {"behavior": "allow"}
            if tool_name not in PERMISSION_SENSITIVE_TOOLS:
                return {"behavior": "allow"}
            if not on_permission_request:
                return {"behavior": "allow"}

            # Send permission request to frontend
            tool_input_str = _tool_input_to_text(tool_input)
            perm_payload = {
                "id": context.get("tool_use_id", "") if isinstance(context, dict) else "",
                "name": _display_tool_name(tool_name),
                "input": tool_input_str,
            }
            emit("permission_request", tool_call=perm_payload)

            req = PermissionRequest(session_id, message_id,
                                    context.get("tool_use_id", "") if isinstance(context, dict) else "",
                                    _display_tool_name(tool_name), tool_input_str)
            granted = await on_permission_request(req)
            if granted:
                return {"behavior": "allow"}
            else:
                return {"behavior": "deny", "message": "Permission denied by user"}

        options["can_use_tool"] = _can_use_tool

        # Execute query
        _new_agent_sid: Optional[str] = agent_session_id
        _done_emitted = False
        _usage: Optional[dict] = None
        # 仅在收到真正可展示的增量后，才跳过随后重复的 completed assistant。
        # message_start/message_stop 也是 stream_event，但本身没有内容；旧逻辑
        # 会因此误判并吞掉某些 provider 只在 completed 中返回的最终内容。
        _partial_content: dict[str, str] = {}
        _partial_tools: set[str] = set()
        _query_started_at = time.monotonic()
        _first_event_at: Optional[float] = None
        _active_result: Any = None
        _tool_names_by_id: dict[str, str] = {}

        try:
            async with sdk_query(prompt, options) as result:
                _active_result = result
                active_queries = getattr(self, "_active_queries", None)
                if active_queries is None:
                    active_queries = self._active_queries = {}
                active_queries[session_id] = result
                # Update session ID from result (SDK uses get_session_id() method)
                try:
                    sdk_session_id = result.get_session_id()
                    if sdk_session_id:
                        _new_agent_sid = sdk_session_id
                        print(f"[QwenSdk] session_id: {_new_agent_sid}", file=sys.stderr, flush=True)
                except Exception:
                    pass

                async for message in result:
                    if self.is_cancelled(session_id):
                        self._detach_query_cleanup(result)
                        await asyncio.sleep(0)
                        break

                    if _first_event_at is None:
                        _first_event_at = time.monotonic()
                        print(
                            f"[QwenSdk] first event in {_first_event_at - _query_started_at:.3f}s",
                            file=sys.stderr,
                            flush=True,
                        )

                    if is_sdk_assistant_message(message):
                        # Assistant messages contain the completed assistant content.
                        # When include_partial_messages=True, Qwen also sends stream_event
                        # deltas for the same content; emitting both causes the final
                        # answer/thinking/tool transcript to appear twice in the UI.
                        msg_dict = dict(message)
                        msg_content = msg_dict.get("message", {}).get("content", [])
                        for block in msg_content:
                            btype = block.get("type", "")
                            if btype == "text":
                                t = block.get("text", "")
                                streamed = _partial_content.get("text", "")
                                if streamed and t.startswith(streamed):
                                    t = t[len(streamed):]
                                    _partial_content["text"] = ""
                                elif t and streamed.startswith(t):
                                    _partial_content["text"] = streamed[len(t):]
                                    t = ""
                                if t:
                                    emit("text_delta", text=t)
                            elif btype == "thinking":
                                t = block.get("thinking", "")
                                streamed = _partial_content.get("thinking", "")
                                if streamed and t.startswith(streamed):
                                    t = t[len(streamed):]
                                    _partial_content["thinking"] = ""
                                elif t and streamed.startswith(t):
                                    _partial_content["thinking"] = streamed[len(t):]
                                    t = ""
                                if t:
                                    emit("thinking", text=t)
                            elif btype == "tool_use":
                                _tool_name = block.get("name", "")
                                _tool_input = block.get("input", {})
                                _tool_id = str(block.get("id", ""))
                                if _tool_id in _partial_tools:
                                    continue
                                if _tool_id:
                                    _tool_names_by_id[_tool_id] = _display_tool_name(_tool_name)
                                emit("tool_start", tool_call={
                                    "id": _tool_id,
                                    "name": _display_tool_name(_tool_name),
                                    "input": json.dumps(_tool_input, ensure_ascii=False),
                                    "status": "running",
                                })
                        _partial_content.clear()
                        _partial_tools.clear()

                    elif is_sdk_user_message(message):
                        # Qwen 把工具执行结果作为 user/tool_result 消息返回。旧适配器
                        # 完全忽略了它，导致 UI 永远只看见“Bash 开始”，也无法用结果
                        # 事件刷新 LOOP 看门狗的活动时间。
                        msg_dict = dict(message)
                        msg_content = msg_dict.get("message", {}).get("content", [])
                        if isinstance(msg_content, list):
                            for block in msg_content:
                                if not isinstance(block, dict) or block.get("type") != "tool_result":
                                    continue
                                raw_content = block.get("content", "")
                                if isinstance(raw_content, str):
                                    output = raw_content
                                else:
                                    try:
                                        output = json.dumps(raw_content, ensure_ascii=False)
                                    except Exception:
                                        output = str(raw_content)
                                emit("tool_result", tool_call={
                                    "id": block.get("tool_use_id", ""),
                                    "name": _tool_names_by_id.get(str(block.get("tool_use_id", "")), "Tool"),
                                    "output": output,
                                    "status": "error" if block.get("is_error") else "done",
                                    "error": output if block.get("is_error") else "",
                                })

                    elif is_sdk_partial_assistant_message(message):
                        # Partial message: stream_event with content_block_delta/start/stop
                        msg_dict = dict(message)
                        event = msg_dict.get("event", {})
                        etype = event.get("type", "")
                        if etype == "message_start":
                            _partial_content.clear()
                            _partial_tools.clear()
                        if etype == "content_block_delta":
                            delta = event.get("delta", {})
                            dtype = delta.get("type", "")
                            if dtype == "text_delta":
                                text = delta.get("text", "")
                                if text:
                                    _partial_content["text"] = _partial_content.get("text", "") + text
                                    emit("text_delta", text=text)
                            elif dtype == "thinking_delta":
                                thinking = delta.get("thinking", "")
                                if thinking:
                                    _partial_content["thinking"] = _partial_content.get("thinking", "") + thinking
                                    emit("thinking", text=thinking)
                            elif dtype == "input_json_delta":
                                partial_json = delta.get("partial_json", "")
                                if partial_json:
                                    emit("tool_input", tool_call={
                                        "inputDelta": partial_json,
                                    })

                        elif etype == "content_block_start":
                            block = event.get("content_block", {})
                            if block.get("type") == "tool_use":
                                _tool_id = str(block.get("id", ""))
                                _partial_tools.add(_tool_id)
                                if _tool_id:
                                    _tool_names_by_id[_tool_id] = _display_tool_name(block.get("name", ""))
                                emit("tool_start", tool_call={
                                    "id": _tool_id,
                                    "name": _display_tool_name(block.get("name", "")),
                                    "input": "",
                                    "status": "running",
                                })

                        elif etype == "content_block_stop":
                            # Tool input complete - permission check happens here
                            pass

                    elif is_sdk_result_message(message):
                        # Result message: session completed
                        msg_dict = dict(message)
                        _new_agent_sid = msg_dict.get("session_id", _new_agent_sid)
                        is_error = msg_dict.get("is_error", False)
                        subtype = msg_dict.get("subtype", "")

                        if is_error or subtype == "error_during_execution":
                            result_text = msg_dict.get("result", "")
                            err_obj = msg_dict.get("error", {})
                            err_msg = err_obj.get("message", "") if isinstance(err_obj, dict) else ""
                            display_text = result_text or err_msg

                            print(f"[QwenSdk] result error: subtype={subtype}, text={display_text[:300]}",
                                  file=sys.stderr, flush=True)

                            # Detect auth/network errors
                            _lower = display_text.lower()
                            _is_auth_or_network = any(k in _lower for k in (
                                "failed to auth", "authentication failed",
                                "unauthorized", "invalid", "login", "credential",
                                "expired", "failed to fetch", "network",
                                "econnrefused", "enotfound",
                                "缺少", "api key", "认证",
                            ))
                            if _is_auth_or_network:
                                emit("text_delta", text=(
                                    "\n\n---\n\n"
                                    "💡 **认证或网络问题，请检查：**\n\n"
                                    "- **API Key 未配置**：点击 ⚙️ → 编辑后端 → "
                                    "填写 API Key（DashScope / OpenAI 兼容）\n"
                                    "- **auth-type 不匹配**：确认 `QWEN_AUTH_TYPE` "
                                    "与 API Key 类型一致（openai / qwen-oauth / "
                                    "anthropic / gemini）\n"
                                    "- **代理未开启**：如需代理，请在后端配置 "
                                    "`HTTPS_PROXY` 字段\n"
                                ))
                            else:
                                emit("resume_failed")

                        # Usage stats
                        usage = msg_dict.get("usage", {})
                        if usage:
                            _usage = {
                                "inputTokens": usage.get("input_tokens", 0),
                                "outputTokens": usage.get("output_tokens", 0),
                            }

                        # Qwen SDK may keep the underlying process/generator alive briefly
                        # after the terminal result message.  Emit `done` as soon as the
                        # result arrives so the UI stops showing the streaming cursor, then
                        # break and let the context manager clean up in the background path.
                        _done_emitted = True
                        emit("done", **(_usage and {"usage": _usage} or {}))
                        terminal_elapsed = time.monotonic() - _query_started_at
                        print(f"[QwenSdk] terminal result in {terminal_elapsed:.3f}s; cleanup detached",
                              file=sys.stderr, flush=True)
                        self._detach_query_cleanup(result)
                        # Let the cleanup task mark Query closed before
                        # __aexit__ runs; this is a single event-loop yield,
                        # not a timed delay.
                        await asyncio.sleep(0)
                        break

            # Stream completed normally without an explicit result message.
            if not _done_emitted:
                _done_emitted = True
                emit("done", **(_usage and {"usage": _usage} or {}))

        except Exception as e:
            import traceback
            traceback.print_exc()
            err_msg = _exc_msg(e)
            print(f"[QwenSdk] exception: {err_msg}", file=sys.stderr, flush=True)

            if agent_session_id and isinstance(e, ProcessExitError):
                print("[QwenSdk] resume process exited; clearing stale session and retrying without resume",
                      file=sys.stderr, flush=True)
                emit("resume_failed")
                if not _done_emitted:
                    emit("done")
                return {"agentSessionId": None}

            # Check for stderr context
            if _stderr_lines:
                err_msg += "\n\n[SDK stderr]:\n" + "\n".join(_stderr_lines[-10:])

            emit("error", error=err_msg)
            if not _done_emitted:
                emit("done")

        finally:
            active_queries = getattr(self, "_active_queries", {})
            if _active_result is not None and active_queries.get(session_id) is _active_result:
                active_queries.pop(session_id, None)
            if _image_temp_dir:
                shutil.rmtree(_image_temp_dir, ignore_errors=True)
                try:
                    os.rmdir(os.path.dirname(_image_temp_dir))
                except OSError:
                    pass

        return {"agentSessionId": _new_agent_sid}
