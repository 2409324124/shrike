# A stand-in for flask.app: the agent wraps Flask.wsgi_app when this module loads.
class Flask:
    def __init__(self, view):
        self.view = view

    def wsgi_app(self, environ, start_response):
        stream = environ["wsgi.input"]
        if environ["PATH_INFO"].endswith("-into"):  # werkzeug's LimitedStream reads with readinto
            buf = bytearray(64)
            data = bytes(buf[: stream.readinto(buf)])
        else:
            data = stream.read()
        body = self.view(data)
        start_response("201 Created", [("Content-Type", "text/plain")])
        return [body]
