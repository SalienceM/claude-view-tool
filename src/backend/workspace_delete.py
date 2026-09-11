from __future__ import annotations

import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import shutil


def delete_workspace_entry(working_dir: str, relative_path: str, expected_directory: bool) -> None:
    if not working_dir or not Path(working_dir).is_absolute():
        raise ValueError("工作目录必须是绝对路径")
    root = Path(working_dir).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("工作目录不存在")
    relative = str(relative_path or "").replace("\\", "/")
    parts = relative.split("/")
    if (not relative or PurePosixPath(relative).is_absolute()
            or PureWindowsPath(relative).drive
            or any(part in {"", ".", ".."} or ":" in part for part in parts)):
        raise ValueError("只允许删除工作目录内的相对路径，不能删除工作目录本身")
    if any(part.rstrip(" .").lower() == ".git" for part in parts):
        raise ValueError("不能通过文件面板删除 .git 元数据")
    target = root
    for part in parts:
        target = target / part
        if target.is_symlink() or os.path.normcase(os.path.realpath(target)) != os.path.normcase(os.path.abspath(target)):
            raise ValueError("不允许沿符号链接或目录联接执行删除")
    resolved = target.resolve(strict=True)
    resolved.relative_to(root)
    if resolved == root:
        raise ValueError("不能删除工作目录本身")
    if resolved.is_dir() != expected_directory:
        raise ValueError("文件类型已变化，请刷新后重新确认")
    if expected_directory:
        shutil.rmtree(resolved)
    elif resolved.is_file():
        resolved.unlink()
    else:
        raise ValueError("只支持删除普通文件或目录")
