# Outgoing HTTP -> external_call events and a traceparent, like node-agent's outgoing.mjs: httpx (sync and async) and
# http.client (urllib, and requests through urllib3). Inside a request the call nests under it; in a SHRIKE_CALLER script
# (cron, test) a call outside any request starts its own trip, so the server's side nests under it.
import functools
import os
import re
import sys
import time
from urllib.parse import urlsplit

from . import trace
from .trace import cur, quietly

BODY_LIMIT = 64 * 1024
LOOPBACK = {"127.0.0.1", "::1", "0.0.0.0", "::", "localhost"}
READABLE = re.compile(r"json|text/(?!event-stream)|xml|x-www-form-urlencoded", re.I)
KINDS = {"browser", "curl", "postman", "explorer", "agent", "cron", "test", "service", "other"}
caller = None  # set by configure() in a SHRIKE_CALLER process
ingest = None  # (host, port) of Shrike's ingest: the exporter's own posts are never calls


def configure(ingest_at):
    global caller, ingest
    ingest = ingest_at
    value = (os.environ.get("SHRIKE_CALLER") or "").strip()
    if value:
        caller = {"kind": value if value in KINDS else "other", "label": value}


def _caller():
    # sys.argv isn't set yet when sitecustomize starts the agent, so the script is named on the first call
    if "command" not in caller and getattr(sys, "argv", None) and sys.argv[0]:
        script = trace.user_file(os.path.abspath(sys.argv[0]))
        if script:
            caller["command"] = f"python {script}"
    return caller


# "localhost:4101" for loopback (matches a service's detail), else host[:port]; place.mjs hostKey and hostLabel.
def _place(scheme, host, port):
    h = "localhost" if host in LOOPBACK else host
    key = f"{h}:{port}" if port and port != (443 if scheme == "https" else 80) else h
    name = key.split(":")[0]
    parts = name.split(".")
    label = key.upper() if not name or re.fullmatch(r"[\d.]+", name) or "." not in name else parts[-2].upper()
    return {"kind": "outside", "id": f"outside:{key}", "name": label, "detail": key}


def _start(method, url, frame):
    parent = cur.get()
    u = urlsplit(url)
    if parent is None and (caller is None or (u.hostname, u.port) == ingest):
        return None
    place = _place(u.scheme, u.hostname or "", u.port)
    event = {
        "id": trace.new_id(),
        "traceId": parent.trace_id if parent else trace.new_trace_id(),
        "origin": "server",
        "kind": "external_call",
        "name": f"{method} {place['detail']}{u.path or '/'}",
        "startMs": trace.now_ms(),
        "status": "ok",
        "http": {"method": method, "url": url},
        "place": place,
    }
    if parent:
        event["parentId"] = parent.id
    else:
        event["caller"] = dict(_caller())
    site = trace.caller_site(frame)
    if site:
        event["source"] = site
    return event, time.perf_counter()


def _traceparent(event):
    return f"00-{event['traceId']}-{event['id']}-01"


def _text(data, content_type):
    if not data or not READABLE.search(content_type or ""):
        return None
    s = bytes(data[: BODY_LIMIT + 1]).decode("utf-8", "replace")
    return s[:BODY_LIMIT] + "…[truncated]" if len(data) > BODY_LIMIT else s


def _done(begun, status=None, headers=None, body=None, err=None):
    event, t0 = begun
    event["durationMs"] = round((time.perf_counter() - t0) * 1000, 2)
    if status is not None:
        event["http"]["status"] = status
        event["http"]["resHeaders"] = headers or {}
        if body is not None:
            event["http"]["resBody"] = body
        if status >= 400:
            event["status"] = "error"  # ponytail: as node-agent, any 4xx counts; the trip's own status decides the verdict
    if err is not None:
        event["status"] = "error"
        event["error"] = trace.error_info(err)
    trace.emit(event)


# ---- httpx


def _httpx_begin(request, frame):
    begun = _start(str(request.method).upper(), str(request.url), frame)
    if begun is None:
        return None
    event = begun[0]
    if "traceparent" not in request.headers:
        request.headers["traceparent"] = _traceparent(event)
    event["http"]["reqHeaders"] = dict(request.headers)
    try:
        body = _text(request.content, request.headers.get("content-type"))
        if body is not None:
            event["http"]["reqBody"] = body
    except Exception:
        pass  # a streamed request body isn't read here
    return begun


def _httpx_end(begun, response, streamed):
    body = None
    if not streamed:
        try:
            body = _text(response.content, response.headers.get("content-type"))
        except Exception:
            pass
    _done(begun, response.status_code, dict(response.headers), body)


def patch_httpx(httpx):
    if getattr(httpx, "_shrike", False):
        return
    send, asend = httpx.Client.send, httpx.AsyncClient.send

    @functools.wraps(send)
    def send_(self, request, *args, **kwargs):
        begun = None if trace.busy() else quietly(_httpx_begin, request, sys._getframe(1))
        if begun is None:
            return send(self, request, *args, **kwargs)
        try:
            response = send(self, request, *args, **kwargs)
        except BaseException as e:
            quietly(_done, begun, None, None, None, e)
            raise
        quietly(_httpx_end, begun, response, kwargs.get("stream", False))
        return response

    @functools.wraps(asend)
    async def asend_(self, request, *args, **kwargs):
        begun = None if trace.busy() else quietly(_httpx_begin, request, sys._getframe(1))
        if begun is None:
            return await asend(self, request, *args, **kwargs)
        try:
            response = await asend(self, request, *args, **kwargs)
        except BaseException as e:
            quietly(_done, begun, None, None, None, e)
            raise
        quietly(_httpx_end, begun, response, kwargs.get("stream", False))
        return response

    httpx.Client.send, httpx.AsyncClient.send = send_, asend_
    httpx._shrike = True


# ---- http.client: the call starts at putrequest and ends at getresponse (or a failed send). Bodies are streamed: left out.
# ponytail: a caller that sets its own traceparent after putrequest sends two; upgrade path: check headers in endheaders.


def _hc_begin(conn, method, url, frame):
    scheme = "https" if getattr(conn, "default_port", 80) == 443 else "http"
    full = url if re.match(r"https?://", url) else f"{scheme}://{conn.host}{'' if conn.port in (None, 80 if scheme == 'http' else 443) else ':' + str(conn.port)}{url}"
    return _start(str(method).upper(), full, frame)


def patch_http_client(client):
    C = client.HTTPConnection
    if getattr(C, "_shrike", False):
        return
    putrequest, endheaders, getresponse = C.putrequest, C.endheaders, C.getresponse

    def end(conn, res, err):
        begun = conn.__dict__.pop("_shrike_call", None)
        if begun is not None:
            _done(begun, res and res.status, res and {k.lower(): v for k, v in res.getheaders()}, None, err)

    def finish(conn, res=None, err=None):
        quietly(end, conn, res, err)

    def begin(conn, method, url, frame):
        begun = _hc_begin(conn, method, url, frame)
        if begun is not None:
            conn._shrike_call = begun
            conn.putheader("traceparent", _traceparent(begun[0]))

    @functools.wraps(putrequest)
    def putrequest_(self, method, url, *args, **kwargs):
        finish(self)  # a call that never read its response
        result = putrequest(self, method, url, *args, **kwargs)
        if not trace.busy():  # a call Shrike itself makes (a __repr__ inside quietly) is never a step
            quietly(begin, self, method, url, sys._getframe(1))
        return result

    @functools.wraps(endheaders)
    def endheaders_(self, *args, **kwargs):
        try:
            return endheaders(self, *args, **kwargs)
        except BaseException as e:
            finish(self, err=e)
            raise

    @functools.wraps(getresponse)
    def getresponse_(self, *args, **kwargs):
        try:
            res = getresponse(self, *args, **kwargs)
        except BaseException as e:
            finish(self, err=e)
            raise
        finish(self, res)
        return res

    C.putrequest, C.endheaders, C.getresponse = putrequest_, endheaders_, getresponse_
    C._shrike = True
