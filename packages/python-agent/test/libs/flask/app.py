# A stand-in for flask.app: the agent wraps Flask.wsgi_app when this module loads.
class Flask:
    def __init__(self, view):
        self.view = view

    def wsgi_app(self, environ, start_response):
        body = self.view(environ["wsgi.input"].read())
        start_response("201 Created", [("Content-Type", "text/plain")])
        return [body]
