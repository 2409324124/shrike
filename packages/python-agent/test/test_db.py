# Database hooks (db.py, sqlite.py) against stand-ins for each driver's cursor API: no database server needed.
import asyncio
import importlib
import os
import sqlite3
import sys
import types
import unittest

from test_agent import HERE, SRC, run_app

sys.path.insert(0, SRC)
sys.path.insert(0, os.path.join(HERE, "libs"))
from shrike_agent import db, sqlite, trace  # noqa: E402

fake_pg = importlib.import_module("psycopg")  # test/libs/psycopg.py
db.patch_psycopg(fake_pg)
sqlite.patch(sqlite3)


class Recorded(unittest.TestCase):
    def setUp(self):
        trace.project, trace._files = os.path.realpath(HERE), {fake_pg.__file__: None}  # the stand-in plays a site-packages driver
        self.got = []
        trace.sink = self.got.append
        self.token = trace.cur.set(trace.Rec("a" * 32, "b" * 16))

    def tearDown(self):
        trace.cur.reset(self.token)

    def queries(self):
        return [e for e in self.got if e["kind"] == "db_query"]


class Changes(unittest.TestCase):
    def test_rows_from_each_placeholder_style(self):
        ins = "INSERT INTO users (name, password, n) VALUES (%s, %s, 3)"
        self.assertEqual(db.change(ins, ("ada", "pw"), 1), {"table": "users", "op": "insert", "count": 1, "rows": [{"after": {"name": "ada", "password": "[redacted]", "n": 3}}]})
        self.assertEqual(db.change("INSERT INTO t (a) VALUES (%(a)s::VARCHAR) RETURNING t.id", {"a": "x"}, 1, lambda: [{"id": 7}])["rows"], [{"pk": "7", "after": {"a": "x", "id": 7}}], "RETURNING merged over the params")
        self.assertEqual(db.change('UPDATE "t" SET "a" = $1 WHERE "t"."id" = $2', ("y", 4), 1)["rows"], [{"pk": "4", "after": {"id": 4, "a": "y"}}])
        self.assertEqual(db.change("DELETE FROM t WHERE id = :id", {"id": 9}, 1)["rows"], [{"pk": "9", "before": {"id": 9}}])
        self.assertEqual(db.change("UPDATE t SET a = 'it''s ?', b = ? WHERE id = ?", (5, 6), 1)["rows"], [{"pk": "6", "after": {"id": 6, "a": "it's ?", "b": 5}}], "a ? in a string literal isn't a param")
        self.assertEqual(db.change("INSERT INTO t (a) VALUES (?)", [(1,), (2,)], 2, many=True)["rows"], [{"after": {"a": 1}}, {"after": {"a": 2}}])
        self.assertEqual(db.change("INSERT INTO t (a) VALUES (?)", ("x",), 1, last_id=12)["rows"], [{"pk": "12", "after": {"id": 12, "a": "x"}}])

    def test_unknown_counts_and_reads_carry_no_change(self):
        self.assertIsNone(db.change("UPDATE t SET a = 1", (), -1), "a driver that can't count leaves the write as can't tell")
        self.assertIsNone(db.change("UPDATE t SET a = 1", (), None))
        self.assertIsNone(db.change("SELECT 1", (), 1))
        self.assertEqual(db.change("UPDATE t SET a = ? WHERE id = ?", (1, 2), 0), {"table": "t", "op": "update", "count": 0}, "nothing matched: no rows")
        self.assertEqual(db.change("DELETE FROM t WHERE id IN (?, ?)", (1, 2), 2), {"table": "t", "op": "delete", "count": 2}, "counts only past the simple shapes")

    def test_places_match_node_agent(self):
        self.assertEqual(db.server_place("postgres", "127.0.0.1", 5432, "app"), {"kind": "data", "id": "data:postgres:localhost:5432/app", "name": "POSTGRES · app", "detail": "localhost:5432/app"})
        self.assertEqual(db.server_place("mysql", "/var/run/mysqld.sock", 3306, b"shop")["id"], "data:mysql:localhost:3306/shop")
        self.assertEqual(db.server_place("postgres", "db.example.com", 6543, None)["name"], "POSTGRES")

    def test_secret_columns_masked_in_params(self):
        self.assertEqual(db.mask_params("INSERT INTO u (name, password) VALUES (%s, %s)", ("ada", "pw")), ("ada", "[redacted]"))
        self.assertEqual(db.mask_params("UPDATE u SET api_token = $1 WHERE id = $2", ["t", 1]), ["[redacted]", 1])
        self.assertEqual(db.mask_params("SELECT * FROM u WHERE id = ?", (1,)), (1,))


class Psycopg(Recorded):
    def test_sync_write_read_and_error(self):
        conn = fake_pg.connect(host="127.0.0.1", port=5433, dbname="shop")
        row = conn.execute("INSERT INTO users (name, password) VALUES (%s, %s) RETURNING id, name", ("ada", "pw")).fetchone()
        self.assertEqual(row, (1, "ada"), "the app still reads its RETURNING row")
        conn.execute("UPDATE users SET name = %s WHERE id = %s", ("bea", 1))
        conn.execute("SELECT id, name FROM users").fetchall()
        with self.assertRaises(RuntimeError):
            conn.execute("FAIL")
        ins, upd, sel, bad = self.queries()
        self.assertEqual(ins["place"], {"kind": "data", "id": "data:postgres:localhost:5433/shop", "name": "POSTGRES · shop", "detail": "localhost:5433/shop"})
        self.assertEqual((ins["db"]["system"], ins["db"]["params"], ins["parentId"]), ("postgres", "('ada', '[redacted]')", "b" * 16))
        self.assertEqual(ins["change"], {"table": "users", "op": "insert", "count": 1, "rows": [{"pk": "1", "after": {"name": "ada", "password": "[redacted]", "id": 1}}]})
        self.assertEqual(ins["source"]["file"], "test_db.py")
        self.assertEqual(upd["change"]["rows"], [{"pk": "1", "after": {"id": 1, "name": "bea"}}])
        self.assertEqual((sel.get("change"), sel["returned"]), (None, "1 row"))
        self.assertEqual((bad["status"], bad["error"]["message"]), ("error", "relation does not exist"))

    def test_executemany_is_one_event(self):
        fake_pg.connect().cursor().executemany("INSERT INTO users (name, password) VALUES (%s, %s)", [("a", "1"), ("b", "2")])
        (q,) = self.queries()
        self.assertEqual((q["change"]["count"], len(q["change"]["rows"])), (2, 2))

    def test_class_rows_are_never_built_twice(self):
        built = []
        conn = fake_pg.connect()
        cur = conn.cursor(row_factory=lambda c: lambda v: built.append(v) or v)
        cur.execute("INSERT INTO users (name, password) VALUES (%s, %s) RETURNING id", ("a", "b"))
        self.assertEqual(built, [])
        self.assertEqual((cur.fetchone(), built), ((1,), [(1,)]))
        self.assertEqual(self.queries()[0]["change"]["rows"], [{"after": {"name": "a", "password": "[redacted]"}}])

    def test_async_cursor(self):
        cur = fake_pg.AsyncCursor(fake_pg.connect(), fake_pg.dict_row)
        row = asyncio.run(self._insert(cur))
        self.assertEqual(row, {"id": 1, "name": "ada"})
        (q,) = self.queries()
        self.assertEqual(q["change"]["rows"], [{"pk": "1", "after": {"name": "ada", "password": "[redacted]", "id": 1}}])
        self.assertEqual(q["source"]["file"], "test_db.py")

    async def _insert(self, cur):
        await cur.execute("INSERT INTO users (name, password) VALUES (%s, %s) RETURNING id, name", ("ada", "pw"))
        return await cur.fetchone()

    def test_outside_a_request_and_a_broken_place_change_nothing(self):
        trace.cur.set(None)
        self.assertEqual(fake_pg.connect().execute("SELECT 1").rowcount, 0)
        self.assertEqual(self.got, [])
        trace.cur.set(trace.Rec("a" * 32, "b" * 16))
        conn = fake_pg.connect()
        del conn.info
        self.assertEqual(conn.execute("SELECT 1").rowcount, 0)
        self.assertEqual(self.queries()[0]["place"]["id"], "data:postgres")

    def test_django_connection_setup_is_not_the_apps(self):
        code = compile("def init_connection_state(conn):\n    conn.execute('SET TIME ZONE UTC')\n", os.path.join("site-packages", "django", "db", "backends", "base.py"), "exec")
        ns = {}
        exec(code, ns)
        ns["init_connection_state"](fake_pg.connect())
        self.assertEqual(self.got, [])


class Psycopg2(Recorded):
    def setUp(self):
        super().setUp()
        rows = {"n": 0}

        class cursor:
            def __init__(self, conn, name=None):
                self.connection, self.name, self.description, self.rowcount, self._rows, self.rownumber = conn, name, None, -1, [], 0

            def execute(self, query, vars=None):
                if "RETURNING" in query:
                    rows["n"] += 1
                    self._rows, self.description, self.rowcount = [(rows["n"], vars[0])], [("id",), ("name",)], 1
                else:
                    self._rows, self.description, self.rowcount = [], None, 1
                self.rownumber = 0

            def executemany(self, query, vars_list):
                for v in vars_list:
                    self.execute(query, v)
                self.rowcount = len(vars_list)

            def fetchall(self):
                out, self.rownumber = self._rows[self.rownumber :], len(self._rows)
                return out

            def fetchone(self):
                self.rownumber += 1
                return self._rows[self.rownumber - 1]

            def scroll(self, value, mode="relative"):
                self.rownumber = value

        class connection:
            cursor_factory = None

            def __init__(self, dsn=None, **kw):
                self.info = types.SimpleNamespace(host="localhost", port=5432, dbname="app")

            def cursor(self, name=None, cursor_factory=None):
                return (cursor_factory or cursor)(self, name)

        class DictLike(cursor):
            def fetchall(self):
                raise AssertionError("python-agent reads with the base cursor's own fetchall")

        def connect(dsn=None, connection_factory=None, cursor_factory=None, **kwargs):
            conn = (connection_factory or connection)(dsn, **kwargs)
            if cursor_factory:
                conn.cursor_factory = cursor_factory
            return conn

        self.mod = types.SimpleNamespace(connect=connect, extensions=types.SimpleNamespace(cursor=cursor, connection=connection), DictLike=DictLike)
        db.patch_psycopg2(self.mod)

    def test_connect_hands_out_recording_cursors(self):
        conn = self.mod.connect("dbname=app")
        cur = conn.cursor()
        cur.execute("INSERT INTO users (name) VALUES (%s) RETURNING id, name", ("ada",))
        self.assertEqual(cur.fetchone(), (1, "ada"))
        conn.cursor(cursor_factory=self.mod.DictLike).execute("UPDATE users SET name = %s WHERE id = %s", ("b", 1))
        cur.executemany("INSERT INTO users (name) VALUES (%s)", [("x",), ("y",)])
        ins, upd, many = self.queries()
        self.assertEqual(ins["place"]["id"], "data:postgres:localhost:5432/app")
        self.assertEqual(ins["change"]["rows"], [{"pk": "1", "after": {"name": "ada", "id": 1}}])
        self.assertEqual(upd["change"]["rows"], [{"pk": "1", "after": {"id": 1, "name": "b"}}])
        self.assertEqual(many["change"]["count"], 2, "executemany is one event")


class Asyncpg(Recorded):
    def setUp(self):
        super().setUp()

        class Record(dict):
            pass

        class Connection:
            _addr, _params = ("127.0.0.1", 5432), types.SimpleNamespace(database="app", user="me")

            async def execute(self, query, *args, timeout=None):
                return "UPDATE 2" if query.startswith("UPDATE") else "INSERT 0 1"

            async def fetch(self, query, *args, timeout=None):
                return [Record(id=1, name=args[0])] if "RETURNING" in query else [Record(id=1), Record(id=2)]

            async def fetchrow(self, query, *args, timeout=None):
                return Record(id=5, name=args[0])

            async def fetchval(self, query, *args, column=0, timeout=None):
                return 9

            async def executemany(self, command, args, *, timeout=None):
                return None

            async def fetchmany(self, query, args, *, timeout=None):
                return []

        class PreparedStatement:
            def __init__(self, conn, query):
                self._connection, self._query = conn, query

            def get_query(self):
                return self._query

            def get_statusmsg(self):
                return "UPDATE 3"

            async def fetch(self, *args, timeout=None):
                return []

        self.Connection = Connection
        self.mod = types.SimpleNamespace(Connection=Connection, prepared_stmt=types.SimpleNamespace(PreparedStatement=PreparedStatement))
        db.patch_asyncpg(self.mod)

    def test_connection_and_prepared_statement(self):
        async def go():
            c = self.Connection()
            await c.execute("UPDATE users SET name = $1 WHERE active", "x")
            await c.fetch("INSERT INTO users (name) VALUES ($1) RETURNING *", "ada")
            await c.fetchrow("UPDATE users SET name = $1 WHERE id = $2 RETURNING *", "bo", 5)
            await c.fetchval("INSERT INTO users (name) VALUES ($1) RETURNING id", "cy")
            await c.fetchrow("UPDATE users SET name = $1 WHERE team = $2 RETURNING *", "bo", 5)
            await c.executemany("INSERT INTO users (name) VALUES ($1)", [("a",), ("b",)])
            await c.fetch("SELECT * FROM users")
            await self.mod.prepared_stmt.PreparedStatement(c, "UPDATE users SET name = $1::VARCHAR WHERE users.id = $2::INTEGER").fetch("z", 4)

        asyncio.run(go())
        ex, fetch, row, val, team, many, sel, prep = self.queries()
        self.assertEqual(ex["place"]["id"], "data:postgres:localhost:5432/app")
        self.assertEqual(ex["change"], {"table": "users", "op": "update", "count": 2})
        self.assertEqual(fetch["change"]["rows"], [{"pk": "1", "after": {"name": "ada", "id": 1}}])
        self.assertEqual(row["change"]["rows"], [{"pk": "5", "after": {"id": 5, "name": "bo"}}])
        self.assertEqual(val["change"]["rows"], [{"pk": "9", "after": {"name": "cy", "id": 9}}])
        self.assertNotIn("change", team, "fetchrow can't say how many rows a non-key UPDATE changed")
        self.assertEqual((many["change"]["count"], many["db"]["params"]), (2, "[('a',), ('b',)]"))
        self.assertEqual(sel["returned"], "2 rows")
        self.assertEqual(prep["change"], {"table": "users", "op": "update", "count": 3, "rows": [{"pk": "4", "after": {"id": 4, "name": "z"}}]})
        self.assertTrue(all(q["source"]["file"] == "test_db.py" for q in self.queries()))

    def test_asyncpg_own_transaction_queries_are_left_out(self):
        code = compile("async def start(conn):\n    await conn.execute('BEGIN')\n", os.path.join("site-packages", "asyncpg", "transaction.py"), "exec")
        ns = {}
        exec(code, ns)
        asyncio.run(ns["start"](self.Connection()))
        self.assertEqual(self.got, [])


class Mysql(Recorded):
    def make_cursor(self):
        class Cursor:
            description, lastrowid = None, None

            def __init__(self, connection):
                self.connection, self.rowcount = connection, -1

            def execute(self, query, args=None):
                self.rowcount, self.lastrowid = 1, 41
                self.description = (("id",),) if query.startswith("SELECT") else None
                return 1

            def executemany(self, query, args):
                self.rowcount = sum(self.execute(query, a) for a in args)  # PyMySQL's own loop
                return self.rowcount

        return Cursor

    def test_pymysql(self):
        Cursor = self.make_cursor()
        db.patch_pymysql(types.SimpleNamespace(cursors=types.SimpleNamespace(Cursor=Cursor)))
        conn = types.SimpleNamespace(host="127.0.0.1", port=3307, db=b"shop", unix_socket=None)
        Cursor(conn).execute("INSERT INTO orders (item, api_key) VALUES (%s, %s)", ("mug", "k"))
        Cursor(conn).executemany("UPDATE orders SET item = %s WHERE id = %s", [("a", 1), ("b", 2)])
        ins, many = self.queries()
        self.assertEqual(ins["place"], {"kind": "data", "id": "data:mysql:localhost:3307/shop", "name": "MYSQL · shop", "detail": "localhost:3307/shop"})
        self.assertEqual(ins["change"], {"table": "orders", "op": "insert", "count": 1, "rows": [{"pk": "41", "after": {"id": 41, "item": "mug", "api_key": "[redacted]"}}]})
        self.assertEqual(ins["db"]["params"], "('mug', '[redacted]')")
        self.assertEqual(many["change"], {"table": "orders", "op": "update", "count": 2}, "its own execute loop isn't recorded again")

    def test_mysqlclient(self):
        Cursor = self.make_cursor()

        class Connection:
            def __init__(self, *args, **kwargs):
                pass

        db.patch_mysqldb_cursors(types.SimpleNamespace(BaseCursor=Cursor))
        db.patch_mysqldb_connections(types.SimpleNamespace(Connection=Connection))
        Cursor(Connection(host="localhost", db="shop", port=3306)).execute("DELETE FROM orders WHERE id = %s", (3,))
        (q,) = self.queries()
        self.assertEqual((q["place"]["id"], q["change"]["rows"]), ("data:mysql:localhost:3306/shop", [{"pk": "3", "before": {"id": 3}}]))


class Sqlite(Recorded):
    def test_writes_carry_their_rows(self):
        conn = sqlite3.connect(":memory:")
        trace.cur.set(None)
        conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, token TEXT)")
        trace.cur.set(trace.Rec("a" * 32, "b" * 16))
        conn.execute("INSERT INTO t (name, token) VALUES (?, ?)", ("ada", "s3"))
        conn.execute("UPDATE t SET name = :n WHERE id = :id", {"n": "bea", "id": 1})
        conn.executemany("INSERT INTO t (name) VALUES (?)", [("x",), ("y",)])
        self.assertEqual(conn.execute("INSERT INTO t (name) VALUES ('z') RETURNING id").fetchone(), (4,))
        conn.execute("DELETE FROM t WHERE id = ?", (2,))
        ins, upd, many, ret, dele = self.queries()
        self.assertEqual(ins["change"], {"table": "t", "op": "insert", "count": 1, "rows": [{"pk": "1", "after": {"id": 1, "name": "ada", "token": "[redacted]"}}]})
        self.assertEqual(upd["change"]["rows"], [{"pk": "1", "after": {"id": 1, "name": "bea"}}])
        self.assertEqual(many["change"]["count"], 2)
        self.assertNotIn("change", ret, "RETURNING rows aren't read ahead of the app: can't tell")
        self.assertEqual(dele["change"]["rows"], [{"pk": "2", "before": {"id": 2}}])


class Wiring(unittest.TestCase):
    def test_import_hook_patches_psycopg_in_a_real_process(self):
        run = run_app(script="drivers.py")
        events = [e for _, _, m in run.got if m["type"] == "events" for e in m["events"]]
        qs = [e for e in events if e["kind"] == "db_query"]
        self.assertEqual(len(qs), 1, "the INSERT at startup is outside a request")
        step = next(e for e in events if e["id"] == qs[0]["parentId"])
        self.assertEqual((step["name"], qs[0]["source"]["file"], qs[0]["place"]["id"]), ("add_user()", "drivers.py", "data:postgres:localhost:5432/shop"))
        self.assertEqual(qs[0]["change"]["rows"], [{"pk": "2", "after": {"name": "ada", "password": "[redacted]", "id": 2}}])
        self.assertEqual(run.stdout.strip(), "(2, 'ada')")


if __name__ == "__main__":
    unittest.main()
