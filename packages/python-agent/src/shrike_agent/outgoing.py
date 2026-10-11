# A SHRIKE_CALLER script (cron, test): each HTTP call it makes outside a request starts a trip (node-agent's outgoing.mjs).
# http.client carries urllib, urllib3 and requests; the call gets a traceparent, so the server's side nests under it.
import os
import sys

from . import trace
from .trace import cur, quietly

KINDS = {"browser", "curl", "postman", "explorer", "agent", "cron", "test", "service", "other"}


def _caller(value):
    c = {"kind": value if value in KINDS else "other", "label": value}
    script = trace.user_file(os.path.abspath(sys.argv[0])) if sys.argv and sys.argv[0] else None
    if script:
        c["command"] = f"python {script}"
    return c


def _host(conn):
    port = conn.port or (443 if conn.default_port == 443 else 80)
    host = "localhost" if conn.host in ("127.0.0.1", "::1") else conn.host
    return host if port == conn.default_port else f"{host}:{port}"


def _begin(conn, method, url, caller):
    host = _host(conn)
    path = url if url.startswith("/") else "/" + url.split("://", 1)[-1].partition("/")[2]
    scheme = "https" if conn.default_port == 443 else "http"
    name = host.split(":")[0]
    label = host.upper() if "." not in name or name.replace(".", "").isdigit() else name.split(".")[-2].upper()
    event = {
        "id": trace.new_id(),
        "traceId": trace.new_trace_id(),
        "origin": "server",
        "kind": "external_call",
        "name": f"{method} {host}{path.split('?')[0]}",
        "startMs": trace.now_ms(),
        "status": "ok",
        "http": {"method": method, "url": f"{scheme}://{host}{path}"},
        "place": {"kind": "outside", "id": f"outside:{host}", "name": label, "detail": host},
        "caller": caller,
    }
    site = trace.caller_site(sys._getframe(3))
    if site:
        event["source"] = site
    return event


def _end(event, status, err):
    event["durationMs"] = round(trace.now_ms() - event["startMs"], 2)
    if status is not None:
        event["http"]["status"] = status
        if status >= 400:
            event["status"] = "error"
    if err is not None:
        event["status"] = "error"
        event["error"] = trace.error_info(err)
    trace.emit(event)


def patch(http_client, ingest):
    value = (os.environ.get("SHRIKE_CALLER") or "").strip()
    if not value or getattr(http_client, "_shrike", False):
        return
    caller = _caller(value)
    Conn = http_client.HTTPConnection
    putrequest, getresponse, close = Conn.putrequest, Conn.getresponse, Conn.close

    def putrequest_(self, method, url, *a, **kw):
        result = putrequest(self, method, url, *a, **kw)
        if cur.get() is None and not trace.busy() and (self.host, self.port) != ingest:
            event = quietly(_begin, self, method, url, caller)
            if event is not None:
                self._shrike_event = event
                self.putheader("traceparent", f"00-{event['traceId']}-{event['id']}-01")
        return result

    def getresponse_(self, *a, **kw):
        event = self.__dict__.pop("_shrike_event", None)
        try:
            res = getresponse(self, *a, **kw)
        except BaseException as e:
            if event is not None:
                quietly(_end, event, None, e)
            raise
        if event is not None:
            quietly(_end, event, res.status, None)
        return res

    def close_(self):
        event = self.__dict__.pop("_shrike_event", None)  # sent but never answered (connection refused, timeout)
        if event is not None:
            quietly(_end, event, None, ConnectionError("no response"))
        return close(self)

    Conn.putrequest, Conn.getresponse, Conn.close = putrequest_, getresponse_, close_
    http_client._shrike = True
