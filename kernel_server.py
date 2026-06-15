"""Scienceum notebook kernel server (stdio JSON-RPC).

The Tauri (Rust) shell launches this script once and keeps it alive. It speaks
one JSON object per line on stdin/stdout:

    in :  {"id": 1, "op": "eval", "src": "diff(sin(x), x)"}
    out:  {"id": 1, "ok": true, "kind": "value",
           "latex": "\\cos{\\left(x \\right)}", "text": "cos(x)"}

It wraps the existing :class:`scienceum.symbolic.SymbolicKernel` (so all the
SymPy / SciPy / Matplotlib behaviour is reused unchanged) and adds a thin
*presentation* layer: results become LaTeX for KaTeX, plots become inline
base64 PNGs. The kernel is stateful, so an assignment in one cell is visible in
later cells -- exactly the Pluto-style shared session.

Run standalone for a smoke test:
    echo {"id":1,"op":"eval","src":"expand((x+1)^2)"} | python kernel_server.py
"""

from __future__ import annotations

import base64
import json
import os
import sys
from pathlib import Path

# Make the `scienceum` package importable no matter what the working directory
# of the launching process is. The package lives at <repo>/parsers/python and
# this script lives at <repo>/app/kernel_server.py.
_APP_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _APP_DIR.parent
sys.path.insert(0, str(_REPO_ROOT / "parsers" / "python"))

# Keep generated plot files out of the repo / user's way: run from a scratch dir.
_WORK = Path(os.environ.get("SCIENCEUM_WORKDIR", _APP_DIR / ".kernel"))
_WORK.mkdir(parents=True, exist_ok=True)
os.chdir(_WORK)

import sympy as sp  # noqa: E402

from scienceum.symbolic import SymbolicKernel, PLOT_FILENAME  # noqa: E402


def _render(result):
    """Turn a kernel result into a presentation payload for the frontend."""
    # A plot command returns the (relative) PNG filename -> inline it.
    if isinstance(result, str) and result.endswith(".png"):
        data = Path(result).read_bytes()
        b64 = base64.b64encode(data).decode("ascii")
        return {"kind": "plot", "image": b64, "text": "<plot>"}

    text = str(result)
    latex = None
    try:
        latex = sp.latex(result)
    except Exception:  # noqa: BLE001 - any non-SymPy value falls back to text
        latex = None
    return {"kind": "value", "latex": latex, "text": text}


def _handle(kernel: SymbolicKernel, msg: dict) -> dict:
    op = msg.get("op")
    mid = msg.get("id")

    if op == "ping":
        return {"id": mid, "ok": True, "kind": "pong"}

    if op == "reset":
        kernel.__init__()  # fresh environment, same instance the caller holds
        return {"id": mid, "ok": True, "kind": "reset"}

    if op == "eval":
        src = msg.get("src", "")
        if not src.strip():
            return {"id": mid, "ok": True, "kind": "empty"}
        try:
            result = kernel.eval(src)
        except Exception as exc:  # noqa: BLE001 - report every failure to the UI
            # Parser/eval errors carry a caret-annotated render(); use it.
            render = getattr(exc, "render", None)
            detail = render(src) if callable(render) else str(exc)
            return {
                "id": mid,
                "ok": False,
                "error": str(exc).splitlines()[0] if str(exc) else type(exc).__name__,
                "detail": detail,
            }
        payload = _render(result)
        payload.update({"id": mid, "ok": True})
        return payload

    return {"id": mid, "ok": False, "error": f"unknown op {op!r}"}


def main() -> None:
    kernel = SymbolicKernel()
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            out.write(json.dumps({"ok": False, "error": f"bad JSON: {exc}"}) + "\n")
            out.flush()
            continue
        response = _handle(kernel, msg)
        out.write(json.dumps(response) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
