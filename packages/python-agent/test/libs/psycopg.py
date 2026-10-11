# A stand-in for psycopg 3: Connection, Cursor and AsyncCursor over an in-memory `users` table, no server.
import re
from types import SimpleNamespace


def tuple_row(cursor):
    return tuple


def dict_row(cursor):
    return lambda values: dict(zip([c[0] for c in cursor.description], values))


def namedtuple_row(cursor):
    return tuple


rows = SimpleNamespace(tuple_row=tuple_row, dict_row=dict_row, namedtuple_row=namedtuple_row)


class Connection:
    def __init__(self, host="localhost", port=5432, dbname="app"):
        self.info = SimpleNamespace(host=host, port=port, dbname=dbname)
        self.table = []

    def cursor(self, row_factory=tuple_row):
        return Cursor(self, row_factory)

    def execute(self, query, params=None):
        return self.cursor().execute(query, params)

    def run(self, sql, params):
        if sql.startswith("FAIL"):
            raise RuntimeError("relation does not exist")
        m = re.match(r"INSERT INTO users \(name, password\) VALUES \(%s, %s\)( RETURNING (.*))?", sql)
        if m:
            row = {"id": len(self.table) + 1, "name": params[0], "password": params[1]}
            self.table.append(row)
            cols = [c.strip() for c in m[2].split(",")] if m[2] else []
            return cols, [tuple(row[c] for c in cols)] if cols else [], 1
        m = re.match(r"UPDATE users SET name = %s WHERE id = %s", sql)
        if m:
            hit = [r for r in self.table if r["id"] == params[1]]
            for r in hit:
                r["name"] = params[0]
            return [], [], len(hit)
        if sql.startswith("SELECT"):
            return ["id", "name"], [(r["id"], r["name"]) for r in self.table], len(self.table)
        return [], [], -1


def connect(**kwargs):
    return Connection(**kwargs)


class Cursor:
    def __init__(self, connection, row_factory=tuple_row):
        self.connection, self.row_factory = connection, row_factory
        self.description, self.pgresult, self.rowcount, self._rows, self._pos = None, None, -1, [], 0

    def execute(self, query, params=None, *, prepare=None):
        cols, self._rows, self.rowcount = self.connection.run(query, params)
        self.description = [(c,) for c in cols] or None
        self.pgresult = object() if cols else None
        self._pos = 0
        return self

    def executemany(self, query, params_seq, *, returning=False):
        n = 0
        for p in params_seq:
            Cursor.execute(self, query, p)
            n += self.rowcount
        self.rowcount = n

    @property
    def rownumber(self):
        return self._pos if self.pgresult is not None else None

    def _make(self, values):
        return self.row_factory(self)(values)

    def fetchall(self):
        out = [self._make(r) for r in self._rows[self._pos :]]
        self._pos = len(self._rows)
        return out

    def fetchone(self):
        if self._pos >= len(self._rows):
            return None
        self._pos += 1
        return self._make(self._rows[self._pos - 1])

    def scroll(self, value, mode="relative"):
        self._pos = value if mode == "absolute" else self._pos + value


class AsyncCursor(Cursor):
    async def execute(self, query, params=None, *, prepare=None):
        return Cursor.execute(self, query, params)

    async def executemany(self, query, params_seq, *, returning=False):
        return Cursor.executemany(self, query, params_seq)

    async def fetchall(self):
        return Cursor.fetchall(self)

    async def fetchone(self):
        return Cursor.fetchone(self)

    async def scroll(self, value, mode="relative"):
        return Cursor.scroll(self, value, mode)
