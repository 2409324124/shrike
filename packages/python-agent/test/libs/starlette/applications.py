# A stand-in for starlette.applications: the agent wraps Starlette.__call__ when this module loads.
class Starlette:
    def __init__(self, handler):
        self.handler = handler

    async def __call__(self, scope, receive, send):
        await receive()
        try:
            body = await self.handler(scope)
        except Exception:
            await send({"type": "http.response.start", "status": 500, "headers": [(b"content-type", b"text/plain")]})
            await send({"type": "http.response.body", "body": b"Internal Server Error"})
            raise
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": body})
