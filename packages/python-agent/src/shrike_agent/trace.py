# function events from sys.monitoring (PEP 669): only code under the project root, only inside a request.
import contextvars
import linecache
import os
import random
import re
import reprlib
import sys
import threading
import time
import traceback

SECRET = re.compile(r"pass(word)?|secret|token|api[-_]?key|authorization|cookie|session", re.I)
MAX = 2048
SKIP_DIRS = {"site-packages", "dist-packages", "node_modules", "__pypackages__"}
MAX_STEPS = 2000  # function steps per request; past it a hot loop costs a dict lookup per call, not an event
MAX_DEPTH = 64  # deep recursion records its first levels only
STEPS_NOTE = f"Shrike recorded the first {MAX_STEPS} steps of this request and skipped the rest."
DEPTH_NOTE = f"Shrike skipped steps nested more than {MAX_DEPTH} calls deep."

cur = contextvars.ContextVar("shrike_parent", default=None)  # the Rec new events nest under; None outside a request
_local = threading.local()
_files = {}  # co_filename -> project-relative path, or None when it isn't the user's
_lines = {}  # (file, co_firstlineno) -> line of the `def`
_frames = {}  # running frame -> its Rec
project = ""  # realpath of SHRIKE_PROJECT_ROOT
place = {}
sink = lambda event: None
_M = getattr(sys, "monitoring", None)
DISABLE = getattr(_M, "DISABLE", None)


# A request (root) or a function step in it.
class Rec:
    __slots__ = ("trace_id", "id", "parent", "event", "t0", "saved", "root", "depth", "steps", "error", "notes", "paused")

    def __init__(self, trace_id, id, parent=None, event=None):
        self.trace_id, self.id, self.parent, self.event, self.t0 = trace_id, id, parent, event, time.perf_counter()
        self.saved = parent  # what `cur` was before this step took it; given back when it yields or ends
        self.root = parent.root if parent else self
        self.depth = parent.depth + 1 if parent else 0
        self.steps, self.error, self.notes = 0, None, None  # root only
        self.paused = None  # perf_counter when it last suspended (generators, coroutines)


_rng = random.Random(os.urandom(16))  # ids only; os.urandom per event costs a syscall
os.register_at_fork(after_in_child=lambda: _rng.seed(os.urandom(16)))


def new_id():
    return f"{_rng.getrandbits(64):016x}"


def new_trace_id():
    return f"{_rng.getrandbits(128):032x}"


def now_ms():
    return time.time_ns() / 1e6


def elapsed(rec):
    return round((time.perf_counter() - rec.t0) * 1000, 2)


def busy():
    return getattr(_local, "busy", False)


# Runs fn with re-entry disabled (a __repr__ or __str__ is user code too). Never raises.
def quietly(fn, *args):
    if getattr(_local, "busy", False):
        return None
    _local.busy = True
    try:
        return fn(*args)
    except Exception:
        return None
    finally:
        _local.busy = False


def emit(event):
    try:
        event.setdefault("place", place)
        sink(event)
    except Exception:
        pass


def user_file(filename):
    rel = _files.get(filename, False)
    if rel is not False:
        return rel
    rel = None
    try:
        if filename and not filename.startswith("<"):
            r = os.path.relpath(os.path.realpath(filename), project)
            parts = r.split(os.sep)
            if not r.startswith("..") and not os.path.isabs(r) and not parts[0].startswith(".") and not SKIP_DIRS.intersection(parts):
                rel = "/".join(parts)
    except Exception:
        pass
    _files[filename] = rel
    return rel


# Module bodies, comprehensions and lambdas (<module>, <genexpr>, <lambda>) are not steps.
def user_code(code):
    return None if code.co_name.startswith("<") else user_file(code.co_filename)


# co_firstlineno is the first decorator's line; the step points at the `def`.
def def_line(filename, first):
    key = (filename, first)
    line = _lines.get(key)
    if line is None:
        line = first
        for n in range(first, first + 30):
            text = linecache.getline(filename, n).lstrip()
            if text.startswith(("def ", "async def ")):
                line = n
                break
        _lines[key] = line
    return line


def caller_site(frame, depth=50):
    while frame is not None and depth > 0:
        rel = user_file(frame.f_code.co_filename)
        if rel:
            return {"file": rel, "line": frame.f_lineno, "precision": "exact"}
        frame, depth = frame.f_back, depth - 1
    return None


def cut(s, limit=MAX):
    return s if len(s) <= limit else s[:limit] + "…[truncated]"


class _Repr(reprlib.Repr):
    def repr_dict(self, x, level):
        if not x:
            return "{}"
        if level <= 0:
            return "{...}"
        out = []
        for i, (k, v) in enumerate(list(x.items())):
            if i >= self.maxdict:
                out.append("...")
                break
            shown = "[redacted]" if isinstance(k, str) and SECRET.search(k) else self.repr1(v, level - 1)
            out.append(f"{self.repr1(k, level - 1)}: {shown}")
        return "{" + ", ".join(out) + "}"

    def repr_bytes(self, x, level):
        return repr(x[: self.maxstring]) + ("..." if len(x) > self.maxstring else "")

    repr_bytearray = repr_bytes

    # A plain class shows its fields, not <Foo object at 0x...>.
    def repr_instance(self, x, level):
        d = getattr(x, "__dict__", None)
        if type(x).__repr__ is object.__repr__ and isinstance(d, dict) and level > 0:
            fields = [(k, v) for k, v in list(d.items()) if not k.startswith("_")][: self.maxdict]
            body = ", ".join(f"{k}={'[redacted]' if SECRET.search(k) else self.repr1(v, level - 1)}" for k, v in fields)
            return f"{type(x).__name__}({body})"
        return super().repr_instance(x, level)


_repr = _Repr(maxlevel=3, maxstring=200, maxlist=20, maxtuple=20, maxset=20, maxfrozenset=20, maxdeque=20, maxarray=20, maxdict=20, maxlong=60, maxother=400)


_PLAIN = (int, float, bool, type(None))


def preview(v):
    try:
        t = type(v)
        if t in _PLAIN or (t is str and len(v) <= 200):
            return repr(v)
        return cut(_repr.repr(v))
    except Exception:
        return "[unavailable]"


def error_info(e):
    try:
        stack = "".join(traceback.format_exception(e)).replace(project + os.sep, "")
        return {"message": cut(str(e)), "type": type(e).__name__, "stack": cut(stack, 8192)}
    except Exception:
        return {"message": "unknown error"}


def _args(code, frame):
    flags = code.co_flags
    n = code.co_argcount + code.co_kwonlyargcount + bool(flags & 0x04) + bool(flags & 0x08)
    names = code.co_varnames[:n]
    loc = frame.f_locals
    out = []
    for i, name in enumerate(names):
        if (i == 0 and name in ("self", "cls")) or name not in loc:
            continue
        out.append(f"{name}=[redacted]" if SECRET.search(name) else f"{name}={preview(loc[name])}")
    return out


def _note(root, message):
    if root.notes is None:
        root.notes = set()
    if message in root.notes:
        return
    root.notes.add(message)
    emit({"id": new_id(), "traceId": root.trace_id, "parentId": root.id, "origin": "server", "kind": "log", "name": message, "startMs": now_ms(), "status": "ok", "log": {"level": "warn", "message": message}})


def _begin(code, rel, parent, frame):
    parent.root.steps += 1
    name = code.co_qualname
    event = {
        "id": new_id(),
        "traceId": parent.trace_id,
        "parentId": parent.id,
        "origin": "server",
        "kind": "function",
        "name": f"{name}()",
        "startMs": now_ms(),
        "status": "ok",
        "source": {"file": rel, "line": def_line(code.co_filename, code.co_firstlineno), "functionName": name, "precision": "exact"},
        "args": _args(code, frame),
    }
    site = caller_site(frame.f_back)
    if site:
        event["callSite"] = site
    rec = Rec(parent.trace_id, event["id"], parent, event)
    _hook(code)
    _frames[frame] = rec
    cur.set(rec)
    rec.t0 = time.perf_counter()


def _end(rec, failed, value, frame):
    event = rec.event
    event["durationMs"] = elapsed(rec)
    if failed and isinstance(value, GeneratorExit):
        pass  # a generator closed before it finished: not an error
    elif failed:
        event["status"] = "error"
        event["error"] = error_info(value)
        back = frame.f_back
        if back is None or user_file(back.f_code.co_filename) is None:
            rec.root.error = value  # escaped into the framework: what its 500 was about
    else:
        event["returned"] = preview(value)
    emit(event)


def _on_start(code, offset):
    rel = user_code(code)
    if rel is None:
        return DISABLE
    parent = cur.get()
    if parent is None or getattr(_local, "busy", False):
        return
    root = parent.root
    note = STEPS_NOTE if root.steps >= MAX_STEPS else DEPTH_NOTE if parent.depth >= MAX_DEPTH else None
    if note is None:
        quietly(_begin, code, rel, parent, sys._getframe(1))
    elif root.notes is None or note not in root.notes:
        quietly(_note, root, note)


def _leave(frame, failed, value):
    rec = _frames.pop(frame, None)
    if rec is not None:
        cur.set(rec.saved)
        quietly(_end, rec, failed, value, frame)


# Return, yield and resume are watched only on code that has been a step (_hook), so the app's other code pays nothing for them.
def _on_return(code, offset, value):
    if _frames:
        _leave(sys._getframe(1), False, value)


# PY_UNWIND and PY_THROW can only be watched everywhere: they stay a dict check for everyone else's code.
def _on_unwind(code, offset, exc):
    if _frames:
        _leave(sys._getframe(1), True, exc)


# A generator or coroutine that suspends gives `cur` back, and takes it again when resumed, from whoever resumes it
# (a generator closed by the garbage collector inside another request leaves that request's context as it was).
def _on_yield(code, offset, value):
    rec = _frames.get(sys._getframe(1)) if _frames else None
    if rec is not None:
        rec.paused = time.perf_counter()
        cur.set(rec.saved)


def _on_resume(code, offset, exc=None):
    rec = _frames.get(sys._getframe(1)) if _frames else None
    if rec is not None:
        rec.paused = None
        rec.saved = cur.get()
        cur.set(rec)


# Steps still open when their request ends are recorded as they stood when they last suspended, and let go: a generator
# abandoned to the garbage collector, or closed without running (3.12.3's close() fires no event when it isn't in a try).
def finish_open(root):
    for frame, rec in list(_frames.items()):
        if rec.root is root and _frames.pop(frame, None) is rec:
            rec.event["durationMs"] = round(((rec.paused or time.perf_counter()) - rec.t0) * 1000, 2)
            emit(rec.event)


_tool = None
_hooked = set()


def _hook(code):
    if code not in _hooked:
        _hooked.add(code)
        E = _M.events
        _M.set_local_events(_tool, code, E.PY_RETURN | E.PY_YIELD | E.PY_RESUME)


def install():
    global _tool
    _tool = next((i for i in (4, 3, 2) if _M.get_tool(i) is None), None)
    if _tool is None:
        return False
    E = _M.events
    _M.use_tool_id(_tool, "shrike")
    for ev, fn in ((E.PY_START, _on_start), (E.PY_RETURN, _on_return), (E.PY_UNWIND, _on_unwind), (E.PY_YIELD, _on_yield), (E.PY_RESUME, _on_resume), (E.PY_THROW, _on_resume)):
        _M.register_callback(_tool, ev, fn)
    _M.set_events(_tool, E.PY_START | E.PY_UNWIND | E.PY_THROW)
    return True
