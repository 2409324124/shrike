# Server http_request events from the app's ASGI or WSGI entry, and the request context every step nests under.
import functools
import re

from . import trace
from .trace import Rec, cur, quietly

BODY_LIMIT = 64 * 1024
TRACEPARENT = re.compile(r"^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$")
on_port = lambda port: None  # says hello again with the address, once


class _Body:
    def __init__(self):
        self.chunks, self.size = [], 0

    def add(self, chunk):
        if self.size <= BODY_LIMIT and isinstance(chunk, (bytes, bytearray)) and chunk:
            self.chunks.append(bytes(chunk))
            self.size += len(chunk)

    def text(self):
        if not self.size:
            return None
        data = b"".join(self.chunks)
        s = data[:BODY_LIMIT].decode("utf-8", "replace")
        return s + "…[truncated]" if len(data) > BODY_LIMIT else s


def _q(s):
    return "'" + s.replace("'", "'\\''") + "'"


# Who sent a request that is not part of a browser trip, from its user-agent (node-agent's place.mjs callerFromRequest).
def caller_from(headers, method, url, body):
    ua = headers.get("user-agent", "")
    if re.match(r"curl/", ua, re.I):
        host = f"http://{headers['host']}" if headers.get("host") else ""
        command = f"curl{'' if method == 'GET' else ' -X ' + method} {_q(host + url)}"
        if headers.get("content-type") and body:
            command += f" -H {_q('content-type: ' + headers['content-type'])}"
        if body:
            command += f" -d {_q(body[:500] + '…' if len(body) > 500 else body)}"
        return {"kind": "curl", "label": "curl", "command": command}
    if re.search(r"PostmanRuntime", ua, re.I):
        return {"kind": "postman", "label": "Postman"}
    if re.search(r"shrike-explorer", ua, re.I):
        return {"kind": "explorer", "label": "API explorer"}
    if re.search(r"shrike-agent", ua, re.I):
        return {"kind": "agent", "label": "agent"}
    if ua.startswith("Mozilla/"):
        return {"kind": "browser", "label": "browser"}
    m = re.match(r"([\w.-]+)", ua)
    return {"kind": "other", "label": m.group(1).lower() if m else "unknown"}


def _begin(method, url, headers, port):
    on_port(port)
    tp = TRACEPARENT.match(headers.get("traceparent", "").strip().lower())
    valid = tp and set(tp.group(1)) != {"0"} and set(tp.group(2)) != {"0"}
    rec = Rec(tp.group(1) if valid else trace.new_trace_id(), trace.new_id())
    rec.event = {
        "id": rec.id,
        "traceId": rec.trace_id,
        "origin": "server",
        "kind": "http_request",
        "name": f"{method} {url.split('?')[0]}",
        "startMs": trace.now_ms(),
        "status": "ok",
        "http": {"method": method, "url": url, "reqHeaders": headers},
    }
    if valid:
        rec.event["parentId"] = tp.group(2)
    return rec, _Body(), _Body(), {}


def _finish(rec, body_in, body_out, resp, err):
    trace.finish_open(rec)
    e = rec.event
    h = e["http"]
    e["durationMs"] = trace.elapsed(rec)
    h["status"] = resp.get("status") or (500 if err is not None else 200)
    h["resHeaders"] = resp.get("headers", {})
    for key, body in (("reqBody", body_in), ("resBody", body_out)):
        text = body.text()
        if text is not None:
            h[key] = text
    if "parentId" not in e:
        e["caller"] = caller_from(h["reqHeaders"], h["method"], h["url"], h.get("reqBody"))
    if err is None and h["status"] >= 500:
        err = rec.error  # Flask and Django answer 500 themselves: the exception that escaped the app's code
    if h["status"] >= 500 or err is not None:
        e["status"] = "error"
    if err is not None:
        e["error"] = trace.error_info(err)
    trace.emit(e)


def _headers(pairs):
    out = {}
    for k, v in pairs or ():
        k = (k.decode("latin-1") if isinstance(k, bytes) else str(k)).lower()
        v = v.decode("latin-1") if isinstance(v, bytes) else str(v)
        out[k] = f"{out[k]}, {v}" if k in out else v
    return out


def _asgi_begin(scope):
    path = scope.get("raw_path")
    path = path.decode("latin-1") if isinstance(path, bytes) else scope.get("path", "/")
    qs = scope.get("query_string") or b""
    url = path + ("?" + qs.decode("latin-1") if qs else "")
    server = scope.get("server") or (None, None)
    return _begin(scope.get("method", "GET"), url, _headers(scope.get("headers")), server[1] if len(server) > 1 else None)


def wrap_asgi(call):
    @functools.wraps(call)
    async def __call__(self, scope, receive, send):
        # Lifespan, websockets, and a mounted sub-app inside a request pass straight through.
        if not isinstance(scope, dict) or scope.get("type") != "http" or cur.get() is not None:
            return await call(self, scope, receive, send)
        begun = quietly(_asgi_begin, scope)
        if begun is None:
            return await call(self, scope, receive, send)
        rec, body_in, body_out, resp = begun

        async def receive_(*a):
            msg = await receive(*a)
            if isinstance(msg, dict) and msg.get("type") == "http.request":
                quietly(body_in.add, msg.get("body"))
            return msg

        async def send_(msg, *a):
            if isinstance(msg, dict):
                if msg.get("type") == "http.response.start":
                    resp["status"], resp["headers"] = msg.get("status"), quietly(_headers, msg.get("headers")) or {}
                elif msg.get("type") == "http.response.body":
                    quietly(body_out.add, msg.get("body"))
            return await send(msg, *a)

        token = cur.set(rec)
        err = None
        try:
            return await call(self, scope, receive_, send_)
        except BaseException as e:
            err = e
            raise
        finally:
            quietly(_finish, rec, body_in, body_out, resp, err)
            try:
                cur.reset(token)
            except Exception:
                pass

    return __call__


class _Input:
    def __init__(self, stream, body):
        self._stream, self._body = stream, body

    def _keep(self, data):
        quietly(self._body.add, data)
        return data

    def read(self, *a):
        return self._keep(self._stream.read(*a))

    def readinto(self, b):  # werkzeug's LimitedStream (Flask) reads this way
        n = self._stream.readinto(b)
        if n:
            quietly(self._body.add, bytes(memoryview(b)[:n]))
        return n

    def readline(self, *a):
        return self._keep(self._stream.readline(*a))

    def readlines(self, *a):
        lines = self._stream.readlines(*a)
        for line in lines:
            self._keep(line)
        return lines

    def __iter__(self):
        return (self._keep(line) for line in self._stream)

    def __getattr__(self, name):
        return getattr(self._stream, name)


class _Result:
    def __init__(self, result, body, done):
        self._result, self._body, self._done = result, body, done

    def __iter__(self):
        for chunk in self._result:
            quietly(self._body.add, chunk)
            yield chunk

    def __len__(self):
        return len(self._result)

    def close(self):
        try:
            close = getattr(self._result, "close", None)
            if close:
                close()
        finally:
            self._done()


def _wsgi_begin(environ):
    path = environ.get("PATH_INFO", "/")
    try:
        path = (environ.get("SCRIPT_NAME", "") + path).encode("latin-1").decode("utf-8")
    except Exception:
        pass
    from urllib.parse import quote

    url = quote(path, safe="/:@!$&'()*+,;=-._~%") + ("?" + environ["QUERY_STRING"] if environ.get("QUERY_STRING") else "")
    headers = {k[5:].replace("_", "-").lower(): str(v) for k, v in environ.items() if k.startswith("HTTP_")}
    for k in ("CONTENT_TYPE", "CONTENT_LENGTH"):
        if environ.get(k):
            headers[k.replace("_", "-").lower()] = str(environ[k])
    return _begin(environ.get("REQUEST_METHOD", "GET"), url, headers, environ.get("SERVER_PORT"))


# ponytail: steps that run while the server iterates a streamed WSGI body (after the app returned) are not nested under the request.
def wrap_wsgi(call):
    @functools.wraps(call)
    def wsgi(self, environ, start_response):
        if not isinstance(environ, dict) or cur.get() is not None:
            return call(self, environ, start_response)
        begun = quietly(_wsgi_begin, environ)
        if begun is None:
            return call(self, environ, start_response)
        rec, body_in, body_out, resp = begun
        finished = []

        def done(err=None):
            if not finished:
                finished.append(True)
                quietly(_finish, rec, body_in, body_out, resp, err)

        def start_response_(status, headers, *a):
            try:
                resp["status"], resp["headers"] = int(str(status).split()[0]), _headers(headers)
            except Exception:
                pass
            write = start_response(status, headers, *a)
            return lambda data: (quietly(body_out.add, data), write(data))[1]

        if environ.get("wsgi.input") is not None:
            environ["wsgi.input"] = _Input(environ["wsgi.input"], body_in)
        token = cur.set(rec)
        try:
            result = call(self, environ, start_response_)
        except BaseException as e:
            done(e)
            raise
        finally:
            try:
                cur.reset(token)
            except Exception:
                pass
        return _Result(result, body_out, done)

    return wsgi
