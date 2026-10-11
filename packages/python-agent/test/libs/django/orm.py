# Stand-in for Django's sqlite backend: its own cursor class passed as factory=, and its bookkeeping queries.
import sqlite3


class SQLiteCursorWrapper(sqlite3.Cursor):
    def execute(self, query, params=None):
        return super().execute(query.replace("%s", "?"), params or ())


def get_new_connection(database):
    conn = sqlite3.connect(database)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _quote_params_for_last_executed_query(conn, params):
    return conn.cursor().execute("SELECT " + ", ".join(["QUOTE(?)"] * len(params)), params).fetchone()


def query(conn, sql, params):
    cursor = conn.cursor(factory=SQLiteCursorWrapper)
    cursor.execute(sql, params)
    _quote_params_for_last_executed_query(conn, params)
    return cursor.fetchall()
