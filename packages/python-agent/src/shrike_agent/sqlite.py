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


def _run(cursor, sql, params, call):
    begun = quietly(_build, cursor, sql, params) if cur.get() is not None else None
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

    class Cursor(sqlite3.Cursor):
        def execute(self, sql, parameters=(), /):
            return _run(self, sql, parameters, lambda: super(Cursor, self).execute(sql, parameters))

        def executemany(self, sql, seq_of_parameters, /):
            return _run(self, sql, seq_of_parameters, lambda: super(Cursor, self).executemany(sql, seq_of_parameters))

        def executescript(self, sql_script, /):
            return _run(self, sql_script, None, lambda: super(Cursor, self).executescript(sql_script))

    class Connection(sqlite3.Connection):
        def cursor(self, factory=Cursor):
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
