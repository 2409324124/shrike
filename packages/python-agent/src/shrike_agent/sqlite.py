# sqlite3 statements -> db_query events in a data:sqlite:<file> place, like node-agent's sqlite.mjs.
import functools
import os
import re
import sys

from . import db
from .trace import quietly


def _place(database):
    name = ":memory:"
    try:
        path = os.fsdecode(database)
        if path and path != ":memory:" and not path.startswith("file::memory:"):
            name = os.path.basename(path.split("?")[0].removeprefix("file:"))
    except Exception:
        pass
    return {"kind": "data", "id": f"data:sqlite:{name}", "name": f"SQLITE · {name}"}


# ponytail: rows come from the statement's params, rowcount and lastrowid, with no extra reads, so an UPDATE has no
# "before" (node-agent's sqlite.mjs reads the row first). RETURNING rows are read only as the app fetches them and
# rowcount counts them as it goes, so such a write stays "can't tell".
def _settle(cursor, params, many):
    def settle(sql, _result):
        if re.search(r"\bRETURNING\b", sql, re.I):
            return None
        ch = db.change(sql, params, cursor.rowcount, last_id=cursor.lastrowid, many=many)
        return {"change": ch} if ch else None

    return settle


def _run(cursor, sql, params, call, settle, frame):
    return db.run("sqlite", lambda: getattr(cursor.connection, "_shrike_place", None) or _place(None), sql, params, call, settle, frame)


# ponytail: connections made with the app's own factory= class, or through a driver that wraps _sqlite3 directly, are left to OpenTelemetry.
def patch(sqlite3):
    if getattr(sqlite3, "_shrike", False):
        return

    # Signatures stay open: a cursor class the app passes as factory= (Django's) has its own.
    class Recording:
        def execute(self, sql, *args, **kwargs):
            params = args[0] if args else next(iter(kwargs.values()), ())
            return _run(self, sql, params, lambda: super(Recording, self).execute(sql, *args, **kwargs), _settle(self, params, False), sys._getframe(1))

        def executemany(self, sql, *args, **kwargs):
            params = args[0] if args else None
            return _run(self, sql, params, lambda: super(Recording, self).executemany(sql, *args, **kwargs), _settle(self, params, True), sys._getframe(1))

        def executescript(self, sql_script, /):
            return _run(self, sql_script, None, lambda: super(Recording, self).executescript(sql_script), None, sys._getframe(1))

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
