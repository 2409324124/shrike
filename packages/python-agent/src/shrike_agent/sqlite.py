# sqlite3 statements -> db_query events in a data:sqlite:<file> place, like node-agent's sqlite.mjs.
import functools
import os
import re
import sys
import time

from . import trace
from .trace import cur, quietly


def _place(database):
    name = ":memory:"
    try:
        db = os.fsdecode(database)
        if db and db != ":memory:" and not db.startswith("file::memory:"):
            name = os.path.basename(db.split("?")[0].removeprefix("file:"))
    except Exception:
        pass
    return {"kind": "data", "id": f"data:sqlite:{name}", "name": f"SQLITE · {name}"}


def _build(cursor, sql, params):
    parent = cur.get()
    statement = str(sql)
    event = {
        "id": trace.new_id(),
        "traceId": parent.trace_id,
        "parentId": parent.id,
        "origin": "db",
        "kind": "db_query",
        "name": re.sub(r"\s+", " ", statement).strip()[:60],
        "startMs": trace.now_ms(),
        "status": "ok",
        "db": {"system": "sqlite", "statement": statement},
        "place": getattr(cursor.connection, "_shrike_place", None) or _place(None),
    }
    if params is not None and params != ():
        event["db"]["params"] = trace.preview(params)
    site = trace.caller_site(sys._getframe(3))
    if site:
        event["source"] = site
    return event, time.perf_counter()


def _end(begun, err):
    event, t0 = begun
    event["durationMs"] = round((time.perf_counter() - t0) * 1000, 2)
    if err is not None:
        event["status"] = "error"
        event["error"] = trace.error_info(err)
    trace.emit(event)


# Django's own bookkeeping, not the app's queries: connection setup, and DEBUG quoting each query's params with another query.
_PLUMBING = {"get_new_connection", "_quote_params_for_last_executed_query"}


def _plumbing():
    f = sys._getframe(3)
    for _ in range(8):
        if f is None:
            return False
        if f.f_code.co_name in _PLUMBING and "django" in f.f_code.co_filename:
            return True
        f = f.f_back
    return False


def _run(cursor, sql, params, call):
    begun = quietly(_build, cursor, sql, params) if cur.get() is not None and not quietly(_plumbing) else None
    if begun is None:
        return call()
    try:
        result = call()
    except BaseException as e:
        quietly(_end, begun, e)
        raise
    quietly(_end, begun, None)
    return result


# ponytail: connections made with the app's own factory= class, or through a driver that wraps _sqlite3 directly, are left to OpenTelemetry.
def patch(sqlite3):
    if getattr(sqlite3, "_shrike", False):
        return

    # Signatures stay open: a cursor class the app passes as factory= (Django's) has its own.
    class Recording:
        def execute(self, sql, *args, **kwargs):
            params = args[0] if args else next(iter(kwargs.values()), ())
            return _run(self, sql, params, lambda: super(Recording, self).execute(sql, *args, **kwargs))

        def executemany(self, sql, *args, **kwargs):
            return _run(self, sql, args[0] if args else None, lambda: super(Recording, self).executemany(sql, *args, **kwargs))

        def executescript(self, sql_script, /):
            return _run(self, sql_script, None, lambda: super(Recording, self).executescript(sql_script))

    class Cursor(Recording, sqlite3.Cursor):
        pass

    @functools.cache
    def recording(factory):
        return type(factory.__name__, (Recording, factory), {"__module__": factory.__module__})

    class Connection(sqlite3.Connection):
        def cursor(self, factory=Cursor):
            if isinstance(factory, type) and issubclass(factory, sqlite3.Cursor) and not issubclass(factory, Recording):
                factory = quietly(recording, factory) or factory
            return super().cursor(factory)

        def execute(self, sql, parameters=(), /):
            return self.cursor().execute(sql, parameters)

        def executemany(self, sql, seq_of_parameters, /):
            return self.cursor().executemany(sql, seq_of_parameters)

        def executescript(self, sql_script, /):
            return self.cursor().executescript(sql_script)

    connect = sqlite3.connect

    @functools.wraps(connect)
    def connect_(*args, **kwargs):
        if len(args) > 5 or "factory" in kwargs:
            return connect(*args, **kwargs)
        conn = connect(*args, factory=Connection, **kwargs)
        try:
            conn._shrike_place = _place(args[0] if args else kwargs.get("database"))
        except Exception:
            pass
        return conn

    sqlite3.connect = connect_
    if getattr(sqlite3, "dbapi2", None) is not None:
        sqlite3.dbapi2.connect = connect_
    sqlite3._shrike = True
