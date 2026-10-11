# Database drivers -> db_query events, and the rows a write changed (`change`), like node-agent's drivers/common.mjs:
# psycopg 3, psycopg2, asyncpg, PyMySQL and mysqlclient, patched right after they load. sqlite.py uses run() and change().
import contextvars
import datetime
import functools
import json
import math
import os
import re
import sys
import time

from . import trace
from .trace import SECRET, cur, quietly

_inside = contextvars.ContextVar("shrike_db", default=False)  # a call being recorded: the driver calls it makes aren't
LOOPBACK = {"127.0.0.1", "::1", "[::1]", "0.0.0.0", "::", "localhost"}
LABEL = {"postgres": "POSTGRES", "mysql": "MYSQL", "sqlite": "SQLITE"}

# Framework bookkeeping, not the app's queries: Django's connection setup and health check, DEBUG quoting params.
_PLUMBING = {"get_new_connection", "init_connection_state", "ensure_timezone", "_configure_timezone", "_configure_role", "is_usable", "register_type_handlers", "_quote_params_for_last_executed_query"}
_ASYNCPG = f"{os.sep}asyncpg{os.sep}"


# data:postgres:localhost:5432/app, "POSTGRES · app": serverPlace in node-agent's common.mjs, so both agents share a lane.
def server_place(system, host, port, database):
    h = str(host or "localhost")
    h = "localhost" if h in LOOPBACK or h.startswith("/") else h
    where = f"{h}:{port}" if port else h
    if isinstance(database, bytes):
        database = database.decode(errors="replace")
    if database:
        where += f"/{database}"
    return {"kind": "data", "id": f"data:{system}:{where}", "name": f"{LABEL[system]} · {database}" if database else LABEL[system], "detail": where}


def _plumbing(frame):
    if frame is not None and _ASYNCPG in frame.f_code.co_filename and not frame.f_code.co_filename.endswith("pool.py"):
        return True  # asyncpg's own BEGIN, ROLLBACK and checks (its Pool hands the app's call on, so that one counts)
    for _ in range(8):
        if frame is None:
            return False
        if frame.f_code.co_name in _PLUMBING and "django" in frame.f_code.co_filename:
            return True
        frame = frame.f_back
    return False


def _start(system, place, sql, params, frame):
    if _plumbing(frame):
        return None
    parent = cur.get()
    statement = sql.decode(errors="replace") if isinstance(sql, bytes) else str(sql)
    if not statement.strip(" ;\n\t"):
        return None  # SQLAlchemy's ";" ping
    event = {
        "id": trace.new_id(),
        "traceId": parent.trace_id,
        "parentId": parent.id,
        "origin": "db",
        "kind": "db_query",
        "name": re.sub(r"\s+", " ", statement).strip()[:60],
        "startMs": trace.now_ms(),
        "status": "ok",
        "db": {"system": system, "statement": statement},
    }
    try:
        event["place"] = place()
    except Exception:
        event["place"] = {"kind": "data", "id": f"data:{system}", "name": LABEL[system]}
    if params is not None and not (isinstance(params, (tuple, list, dict)) and not params):
        event["db"]["params"] = trace.preview(mask_params(statement, params))
    site = trace.caller_site(frame)
    if site:
        event["source"] = site
    return event, time.perf_counter()


def _finish(begun, err, settle):
    event, t0 = begun
    event["durationMs"] = round((time.perf_counter() - t0) * 1000, 2)
    if err is not None:
        event["status"] = "error"
        event["error"] = trace.error_info(err)
    elif settle is not None:
        event.update(settle(event["db"]["statement"]) or {})
    trace.emit(event)


def _skip():
    return cur.get() is None or _inside.get() or trace.busy()


# One driver call: returns exactly what the driver returned. settle(statement) -> {"change": ...} or {"returned": ...}.
def run(system, place, sql, params, call, settle=None, frame=None):
    begun = None if _skip() else quietly(_start, system, place, sql, params, frame)
    if begun is None:
        return call()
    token = _inside.set(True)
    try:
        result = call()
    except BaseException as e:
        quietly(_finish, begun, e, None)
        raise
    finally:
        _inside.reset(token)
    quietly(_finish, begun, None, settle and (lambda s: settle(s, result)))
    return result


async def arun(system, place, sql, params, call, settle=None, frame=None):
    begun = None if _skip() else quietly(_start, system, place, sql, params, frame)
    if begun is None:
        return await call()
    token = _inside.set(True)
    try:
        result = await call()
    except BaseException as e:
        quietly(_finish, begun, e, None)
        raise
    finally:
        _inside.reset(token)
    quietly(_finish, begun, None, settle and (lambda s: settle(s, result)))
    return result


# ---- what a write changed: from the statement, its params, the driver's row count and any RETURNING rows. No extra queries.

WRITE = re.compile(r"^\s*(INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+(?:[\w$\"`]+\.)?[\"`]?([\w$]+)[\"`]?", re.I)
_PH = r"\$\d+|\?|%s|%\(\w+\)s|(?<![:\w]):\w+"
ONE_KEY = re.compile(r"\bWHERE\s+(?:[\w$\"`]+\.)?[\"`]?([\w$]+)[\"`]?\s*=\s*(" + _PH + r")(?:::[\w\[\] ]+)?\s*(?:RETURNING\b[\s\S]*?)?;?\s*$", re.I)
_TOKENS = re.compile(r"'(?:[^']|'')*'|::[\w\[\]]+|(\?|%s)")  # string literals and casts skipped; group 1 is positional
MAX_ROWS = 5


def _npos(text):
    return sum(1 for m in _TOKENS.finditer(text) if m.group(1))


def write_of(sql):
    m = WRITE.match(sql)
    if not m:
        return None
    verb = m[1].split()[0].upper()
    plan = {"op": "update" if verb == "UPDATE" else "delete" if verb == "DELETE" else "insert", "table": m[2], "returning": bool(re.search(r"\bRETURNING\b", sql, re.I))}
    w = ONE_KEY.search(sql) if plan["op"] != "insert" else None
    if w:
        plan["where"] = (w[1], w[2], w.start(2))
    return plan


def _split(s):
    out, depth, cur_, q = [], 0, "", ""
    for ch in s:
        if q:
            if ch == q:
                q = ""
        elif ch in "'\"`":
            q = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == "," and depth == 0:
            out.append(cur_.strip())
            cur_ = ""
            continue
        cur_ += ch
    if cur_.strip():
        out.append(cur_.strip())
    return out


def _unq(c):
    return re.sub(r"^[`\"\[]|[`\"\]]$", "", c.strip())


# A VALUES item or SET right-hand side -> (value,), or None when it's an expression (default, now(), lower(%s)).
def _value(token, params, nxt):
    t = re.sub(r"(::[\w\[\] ]+)+$", "", token.strip())
    try:
        m = re.fullmatch(r"\$(\d+)", t)
        if m:
            return (params[int(m[1]) - 1],)
        if t in ("?", "%s"):
            nxt[0] += 1
            return (params[nxt[0] - 1],)
        m = re.fullmatch(r"%\((\w+)\)s|:(\w+)", t)
        if m:
            return (params[m[1] or m[2]],)
    except (IndexError, KeyError, TypeError, ValueError):
        return None
    if re.fullmatch(r"-?\d+(\.\d+)?", t):
        return (float(t) if "." in t else int(t),)
    if re.fullmatch(r"'.*'", t, re.S):
        return (t[1:-1].replace("''", "'"),)
    if t.lower() in ("null", "true", "false"):
        return ({"null": None, "true": True, "false": False}[t.lower()],)
    nxt[0] += _npos(t)
    return None


# ponytail: single-table INSERT ... (cols) VALUES and UPDATE/DELETE ... WHERE col = <param>; anything fancier gets counts only.
def rows_from_params(plan, sql, params):
    if not isinstance(params, (tuple, list, dict)):
        return {}
    if plan["op"] == "insert":
        m = re.search(r"\(([^()]*)\)\s*VALUES\s*([\s\S]*?)(?:\bON\s+(?:CONFLICT|DUPLICATE)\b|\bRETURNING\b|;|$)", sql, re.I)
        if not m:
            return {}
        cols = [_unq(c) for c in _split(m[1])]
        nxt = [_npos(sql[: m.start(2)])]
        after = []
        for t in re.finditer(r"\(((?:[^()]|\([^()]*\))*)\)", m[2]):
            row = {}
            for i, tok in enumerate(_split(t[1])):
                v = _value(tok, params, nxt)
                if v and i < len(cols):
                    row[cols[i]] = v[0]
            after.append(row)
            if len(after) >= MAX_ROWS:
                break
        return {"after": after}
    if "where" not in plan:
        return {}
    col, token, at = plan["where"]
    v = _value(token, params, [_npos(sql[:at])])
    if v is None:
        return {}
    key = {col: v[0]}
    if plan["op"] == "delete":
        return {"before": [key]}
    row = dict(key)
    s = re.search(r"\bSET\b([\s\S]*?)\bWHERE\b", sql, re.I)
    if s:
        nxt = [_npos(sql[: s.start(1)])]
        for part in _split(s[1]):
            eq = part.find("=")
            if eq < 0:
                continue
            got = _value(part[eq + 1 :], params, nxt)
            if got:
                row[_unq(re.sub(r"^.*\.", "", part[:eq].strip()))] = got[0]
    return {"after": [row]}


def cell(v):
    if v is None or isinstance(v, bool):
        return v
    if isinstance(v, int):
        return v if abs(v) <= 2**53 else str(v)
    if isinstance(v, float):
        return v if math.isfinite(v) else str(v)
    if isinstance(v, str):
        return trace.cut(v, 300)
    if isinstance(v, (datetime.date, datetime.time)):
        return v.isoformat()
    if isinstance(v, (bytes, bytearray, memoryview)):
        return f"<{len(v)} bytes>"
    if isinstance(v, (dict, list, tuple)):
        try:
            return trace.cut(json.dumps(v, default=str), 300)
        except Exception:
            pass
    return trace.cut(str(v) if type(v).__module__ in ("decimal", "uuid") else trace.preview(v), 300)


def row_out(r):
    return {str(k): "[redacted]" if v is not None and SECRET.search(str(k)) else cell(v) for k, v in r.items()}


def _key(v):
    return "true" if v is True else "false" if v is False else str(v)


def change_of(plan, count, before=None, after=None):
    rows = []
    if plan["op"] == "insert":
        rows = [{"pk": _key(a["id"]), "after": row_out(a)} if "id" in a else {"after": row_out(a)} for a in (after or [])[:MAX_ROWS]]
    elif plan["op"] == "delete":
        rows = [{"pk": _key(b["id"]), "before": row_out(b)} if "id" in b else {"before": row_out(b)} for b in (before or [])[:MAX_ROWS]]
    else:
        for i in range(min(MAX_ROWS, max(len(before or []), len(after or [])))):
            b = before[i] if before and i < len(before) else None
            a = after[i] if after and i < len(after) else None
            r = {}
            if "id" in (a or b):
                r["pk"] = _key((a or b)["id"])
            if b:
                r["before"] = row_out(b)
            if a:
                r["after"] = row_out(a)
            rows.append(r)
    out = {"table": plan["table"], "op": plan["op"], "count": count}
    if rows and count:
        out["rows"] = rows
    return out


# The change field for a SQL write, or None when it isn't one or the driver can't say how many rows it changed
# (an unknown count stays a write without rows, which the inspector reads as "can't tell", never "nothing changed").
# returned(): the statement's RETURNING rows as dicts, read only when it has a RETURNING clause. last_id: the driver's lastrowid.
def change(sql, params, count, returned=None, last_id=None, many=False):
    plan = write_of(sql)
    if plan is None or not isinstance(count, int) or count < 0:
        return None
    if many:
        after = []
        for p in params if isinstance(params, (list, tuple)) else ():
            after += rows_from_params(plan, sql, p).get("after", [])
            if len(after) >= MAX_ROWS:
                break
        rows = {"after": after} if plan["op"] == "insert" else {}
    else:
        rows = rows_from_params(plan, sql, params)
    got = returned() if plan["returning"] and returned else None
    if got:
        if plan["op"] == "delete":
            rows = {"before": got}
        else:
            base = rows.get("after") or []
            rows = {"after": [{**(base[i] if i < len(base) else {}), **r} for i, r in enumerate(got)]}
    elif plan["op"] == "insert" and last_id and count == 1 and len(rows.get("after") or []) == 1:
        rows["after"][0] = {"id": last_id, **rows["after"][0]}
    return change_of(plan, count, **rows)


def _dicts(rows, description):
    names = [d[0] for d in description or ()]
    out = []
    for r in list(rows)[:MAX_ROWS]:
        if isinstance(r, (tuple, list)) and names:
            out.append(dict(zip(names, r)))
        elif hasattr(r, "keys"):
            out.append({k: r[k] for k in r.keys()})
    return out


def _count_of(status):
    m = re.fullmatch(r"(?:INSERT \d+|UPDATE|DELETE|MERGE|SELECT) (\d+)", (status or "").strip())
    return int(m[1]) if m else None


def _rows_note(n):
    return {"returned": f"{n} row{'' if n == 1 else 's'}"}


# Params whose column names a secret (password, api_token, ...) show [redacted]: maskParams in common.mjs.
def mask_params(sql, params):
    if not isinstance(params, (list, tuple)) or not params:
        return params
    try:
        cols = {}
        ins = re.search(r"\(([^()]*)\)\s*VALUES\s*\(([^()]*)\)", sql, re.I)
        names = [_unq(c) for c in _split(ins[1])] if ins else []
        i = 0
        for m in _TOKENS.finditer(sql):
            if not m.group(1):
                continue
            if ins and ins.start(2) <= m.start() < ins.end(2):
                k = len(_split(sql[ins.start(2) : m.start()] + "x")) - 1
                col = names[k] if k < len(names) else None
            else:
                c = re.search(r"[\"`]?([\w$]+)[\"`]?\s*(?:=|<>|!=|>=|<=|>|<|\bLIKE|\bIN\s*\()\s*$", sql[max(0, m.start() - 80) : m.start()], re.I)
                col = c and c[1]
            if col:
                cols[i] = col
            i += 1
        for m in re.finditer(r"\$(\d+)", sql):
            c = re.search(r"[\"`]?([\w$]+)[\"`]?\s*(?:=|<>|!=|>=|<=|>|<|\bLIKE|\bIN\s*\()\s*$", sql[max(0, m.start() - 80) : m.start()], re.I)
            if c:
                cols[int(m[1]) - 1] = c[1]
        if ins:
            for k, tok in enumerate(_split(ins[2])):
                n = re.fullmatch(r"\$(\d+)(?:::[\w\[\] ]+)?", tok)
                if n and k < len(names):
                    cols[int(n[1]) - 1] = names[k]
        if not any(SECRET.search(c) for c in cols.values()):
            return params
        return type(params)("[redacted]" if v is not None and SECRET.search(cols.get(i, "")) else v for i, v in enumerate(params))
    except Exception:
        return params


# ---- psycopg 3: Cursor and AsyncCursor (Connection.execute, ClientCursor, Django and SQLAlchemy all go through them)


def _pg3_place(cursor):
    info = cursor.connection.info
    return server_place("postgres", info.host, info.port, info.dbname)


def _drive(coro):
    try:
        coro.send(None)
    except StopIteration as e:
        return e.value
    coro.close()
    raise RuntimeError("would wait")


def _settler(c, params, many, fetch):
    def settle(sql, _result):
        ch = change(sql, params, c.rowcount, None if many else (lambda: fetch(c)), many=many)
        return {"change": ch} if ch else _rows_note(c.rowcount) if c.description and c.rowcount >= 0 and not many else None

    return settle


def _text(c, query):
    if isinstance(query, bytes):
        return query.decode(errors="replace")
    return query if isinstance(query, str) else query.as_string(c)


def _wrap_pg3(cls, is_async, plain):
    # The RETURNING rows are already in memory: read them, then put the cursor back on the first row.
    # ponytail: only with psycopg's own row factories (a class_row would run the app's constructor twice).
    def fetch(c):
        if c.row_factory not in plain or c.pgresult is None or c.rownumber != 0 or not c.description:
            return None
        try:
            got = _drive(c.fetchall()) if is_async else c.fetchall()
        finally:
            _drive(c.scroll(0, "absolute")) if is_async else c.scroll(0, "absolute")
        return _dicts(got, c.description)

    execute, executemany = cls.execute, cls.executemany
    if is_async:

        async def execute_(self, query, params=None, *args, **kwargs):
            return await arun("postgres", lambda: _pg3_place(self), quietly(_text, self, query) or query, params, lambda: execute(self, query, params, *args, **kwargs), _settler(self, params, False, fetch), sys._getframe(1))

        async def executemany_(self, query, params_seq, *args, **kwargs):
            return await arun("postgres", lambda: _pg3_place(self), quietly(_text, self, query) or query, params_seq, lambda: executemany(self, query, params_seq, *args, **kwargs), _settler(self, params_seq, True, fetch), sys._getframe(1))

    else:

        def execute_(self, query, params=None, *args, **kwargs):
            return run("postgres", lambda: _pg3_place(self), quietly(_text, self, query) or query, params, lambda: execute(self, query, params, *args, **kwargs), _settler(self, params, False, fetch), sys._getframe(1))

        def executemany_(self, query, params_seq, *args, **kwargs):
            return run("postgres", lambda: _pg3_place(self), quietly(_text, self, query) or query, params_seq, lambda: executemany(self, query, params_seq, *args, **kwargs), _settler(self, params_seq, True, fetch), sys._getframe(1))

    cls.execute = functools.wraps(execute)(execute_)
    cls.executemany = functools.wraps(executemany)(executemany_)
    cls._shrike = True


def patch_psycopg(psycopg):
    rows_mod = getattr(psycopg, "rows", None)
    plain = {getattr(rows_mod, n, None) for n in ("tuple_row", "dict_row", "namedtuple_row")} - {None}
    for name, is_async in (("Cursor", False), ("AsyncCursor", True)):
        cls = getattr(psycopg, name, None)
        if cls is not None and not cls.__dict__.get("_shrike"):
            _wrap_pg3(cls, is_async, plain)


# ---- psycopg2: its cursor is a C type, so connect() hands out a connection whose cursors are recording subclasses (like sqlite.py)


def patch_psycopg2(psycopg2):
    if getattr(psycopg2, "_shrike", False):
        return
    ext = psycopg2.extensions
    base = ext.cursor

    def place(c):
        info = c.connection.info
        return server_place("postgres", info.host, info.port, info.dbname)

    def fetch(c):
        if c.name is not None or c.rownumber != 0 or not c.description:
            return None
        try:
            got = base.fetchall(c)  # the C methods: a factory's own fetchall may keep state of its own
        finally:
            base.scroll(c, 0, "absolute")
        return _dicts(got, c.description)

    @functools.cache
    def recording_cursor(factory):
        def execute(self, query, vars=None):
            return run("postgres", lambda: place(self), quietly(_text, self, query) or query, vars, lambda: factory.execute(self, query, vars), _settler(self, vars, False, fetch), sys._getframe(1))

        def executemany(self, query, vars_list):
            return run("postgres", lambda: place(self), quietly(_text, self, query) or query, vars_list, lambda: factory.executemany(self, query, vars_list), _settler(self, vars_list, True, fetch), sys._getframe(1))

        return type(factory.__name__, (factory,), {"execute": execute, "executemany": executemany, "_shrike": True, "__module__": factory.__module__})

    @functools.cache
    def recording_connection(factory):
        def cursor(self, *args, **kwargs):
            if len(args) < 2:
                f = kwargs.get("cursor_factory") or self.cursor_factory or base
                if isinstance(f, type) and issubclass(f, base) and not f.__dict__.get("_shrike"):
                    kwargs["cursor_factory"] = quietly(recording_cursor, f) or f
            return factory.cursor(self, *args, **kwargs)

        return type(factory.__name__, (factory,), {"cursor": cursor, "__module__": factory.__module__})

    connect = psycopg2.connect

    @functools.wraps(connect)
    def connect_(*args, **kwargs):
        cf = kwargs.get("connection_factory") or ext.connection
        if len(args) < 2 and isinstance(cf, type) and issubclass(cf, ext.connection):
            kwargs["connection_factory"] = quietly(recording_connection, cf) or cf
        return connect(*args, **kwargs)

    psycopg2.connect = connect_
    psycopg2._shrike = True


# ---- asyncpg: Connection's query methods (a Pool hands them on) and PreparedStatement's (SQLAlchemy's asyncpg dialect)


def _apg_place(conn):
    addr = getattr(conn, "_addr", None)
    params = getattr(conn, "_params", None)
    host, port = (addr[0], addr[1]) if isinstance(addr, tuple) else ("localhost", None)
    if not port and isinstance(addr, str):  # a Unix socket: /tmp/.s.PGSQL.5432
        port = addr.rsplit(".", 1)[-1] if addr.rsplit(".", 1)[-1].isdigit() else None
    return server_place("postgres", host, port or 5432, getattr(params, "database", None) or getattr(params, "user", None))


def _returning_col(sql):
    m = re.search(r"\bRETURNING\s+(?:[\w$\"`]+\.)?[\"`]?([\w$]+)[\"`]?\s*;?\s*$", sql, re.I)
    return m and m[1]


def _apg_settle(method, args, status=None):
    def settle(sql, result):
        if method == "execute":
            ch = change(sql, args, _count_of(result) if isinstance(result, str) else None)
            return {"change": ch} if ch else None
        if method in ("executemany", "fetchmany"):
            # ponytail: no count comes back; a plain INSERT adds one row per argument set, anything else stays "can't tell".
            plan = write_of(sql)
            seq = args if isinstance(args, (list, tuple)) else ()
            n = len(seq) if seq and plan and plan["op"] == "insert" and not re.search(r"\bON\s+CONFLICT\b", sql, re.I) else None
            ch = change(sql, seq, n, many=True)
            return {"change": ch} if ch else None
        if method == "fetchval":
            col = _returning_col(sql)
            rows = [{col: result}] if col and result is not None else []
        else:
            rows = [result] if method == "fetchrow" and result is not None else list(result or []) if method == "fetch" else []
        got = _dicts(rows, None)
        n = _count_of(status()) if status else None
        plan = write_of(sql)
        if n is None and plan and plan["returning"]:
            # ponytail: Connection.fetch* don't expose the command status. fetch's rows are all of them; fetchrow and fetchval
            # count one row only for a single-row INSERT or a write keyed on `id`, else the write stays "can't tell".
            single = method == "fetch" or (plan["op"] == "insert" and len(rows_from_params(plan, sql, args).get("after", [])) == 1) or plan.get("where", ("",))[0] == "id"
            n = len(got) if single else None
        ch = change(sql, args, n, lambda: got)
        if ch:
            return {"change": ch}
        return _rows_note(len(rows)) if method == "fetch" and not plan else None

    return settle


def patch_asyncpg(asyncpg):
    conn_cls = getattr(asyncpg, "Connection", None)
    if conn_cls is not None and not conn_cls.__dict__.get("_shrike"):
        for name in ("execute", "fetch", "fetchrow", "fetchval", "executemany", "fetchmany"):
            orig = getattr(conn_cls, name, None)
            if orig is None:
                continue

            def make(orig=orig, name=name):
                async def method(self, query, *args, **kwargs):
                    params = (args[0] if args else None) if name in ("executemany", "fetchmany") else args
                    return await arun("postgres", lambda: _apg_place(self), query, params, lambda: orig(self, query, *args, **kwargs), _apg_settle(name, params), sys._getframe(1))

                return functools.wraps(orig)(method)

            setattr(conn_cls, name, make())
        conn_cls._shrike = True
    ps = getattr(getattr(asyncpg, "prepared_stmt", None), "PreparedStatement", None)
    if ps is not None and not ps.__dict__.get("_shrike"):
        for name in ("fetch", "fetchrow", "fetchval", "executemany", "fetchmany"):
            orig = getattr(ps, name, None)
            if orig is None:
                continue

            def make(orig=orig, name=name):
                async def method(self, *args, **kwargs):
                    params = (args[0] if args else None) if name in ("executemany", "fetchmany") else args
                    sql = quietly(self.get_query) or ""
                    status = getattr(self, "get_statusmsg", None)
                    return await arun("postgres", lambda: _apg_place(self._connection), sql, params, lambda: orig(self, *args, **kwargs), _apg_settle(name, params, status), sys._getframe(1))

                return functools.wraps(orig)(method)

            setattr(ps, name, make())
        ps._shrike = True


# ---- PyMySQL and mysqlclient (MySQLdb): their cursor classes are plain Python


def _mysql_settle(c, params, many):
    def settle(sql, _result):
        ch = change(sql, params, c.rowcount, last_id=getattr(c, "lastrowid", None), many=many)
        return {"change": ch} if ch else _rows_note(c.rowcount) if c.description and isinstance(c.rowcount, int) and c.rowcount >= 0 and not many else None

    return settle


def _patch_cursor(cls, place):
    if cls is None or cls.__dict__.get("_shrike"):
        return
    execute, executemany = cls.execute, cls.executemany

    def execute_(self, query, args=None):
        return run("mysql", lambda: place(self), query, args, lambda: execute(self, query, args), _mysql_settle(self, args, False), sys._getframe(1))

    def executemany_(self, query, args):
        return run("mysql", lambda: place(self), query, args, lambda: executemany(self, query, args), _mysql_settle(self, args, True), sys._getframe(1))

    cls.execute = functools.wraps(execute)(execute_)
    cls.executemany = functools.wraps(executemany)(executemany_)
    cls._shrike = True


def patch_pymysql(pymysql):
    def place(c):
        conn = c.connection
        return server_place("mysql", "localhost" if conn.unix_socket else conn.host, conn.port or 3306, conn.db)

    _patch_cursor(getattr(getattr(pymysql, "cursors", None), "Cursor", None), place)


def patch_mysqldb_cursors(cursors):
    def place(c):
        return getattr(c.connection, "_shrike_place", None) or server_place("mysql", "localhost", 3306, None)

    _patch_cursor(getattr(cursors, "BaseCursor", None), place)


# mysqlclient's connection keeps no host, port or database: note them as it's made.
def patch_mysqldb_connections(connections):
    cls = getattr(connections, "Connection", None)
    if cls is None or cls.__dict__.get("_shrike"):
        return
    init = cls.__init__

    @functools.wraps(init)
    def init_(self, *args, **kwargs):
        init(self, *args, **kwargs)
        try:
            kw = dict(zip(("host", "user", "passwd", "db", "port", "unix_socket"), args), **kwargs)
            self._shrike_place = server_place("mysql", "localhost" if kw.get("unix_socket") else kw.get("host"), kw.get("port") or 3306, kw.get("db") or kw.get("database"))
        except Exception:
            pass

    cls.__init__ = init_
    cls._shrike = True


PATCHES = {
    "psycopg": patch_psycopg,
    "psycopg2": patch_psycopg2,
    "asyncpg": patch_asyncpg,
    "pymysql": patch_pymysql,
    "MySQLdb.cursors": patch_mysqldb_cursors,
    "MySQLdb.connections": patch_mysqldb_connections,
}
