"""A plugin for the Datasette Lite tests: responses that arrive over time.

    /-/test-stream?n=5&delay=0.3   n server-sent events, delay seconds apart
    /-/test-stream-state           what the streams have seen so far, as JSON

Written as an asgi_wrapper so it can watch for http.disconnect itself."""
import asyncio
import json
from urllib.parse import parse_qs

from datasette import hookimpl

state = {"started": 0, "sent": 0, "finished": 0, "disconnected": 0}


async def stream(scope, receive, send):
    query = parse_qs(scope["query_string"].decode())
    n = int(query.get("n", ["5"])[0])
    delay = float(query.get("delay", ["0.3"])[0])
    await receive()
    state["started"] += 1
    await send(
        {
            "type": "http.response.start",
            "status": 200,
            "headers": [
                (b"content-type", b"text/event-stream"),
                (b"cache-control", b"no-cache"),
            ],
        }
    )
    gone = asyncio.Event()

    async def watch():
        message = await receive()
        if message["type"] == "http.disconnect":
            gone.set()

    watcher = asyncio.ensure_future(watch())
    for i in range(n):
        if gone.is_set():
            state["disconnected"] += 1
            return
        await send(
            {
                "type": "http.response.body",
                "body": "data: tick {}\n\n".format(i).encode(),
                "more_body": True,
            }
        )
        state["sent"] += 1
        await asyncio.sleep(delay)
    await send({"type": "http.response.body", "body": b"", "more_body": False})
    state["finished"] += 1
    watcher.cancel()


@hookimpl
def asgi_wrapper(datasette):
    def wrap(app):
        async def wrapped(scope, receive, send):
            path = scope.get("path") or ""
            if scope["type"] == "http" and path.endswith("/-/test-stream"):
                await stream(scope, receive, send)
            elif scope["type"] == "http" and path.endswith("/-/test-stream-state"):
                await send(
                    {
                        "type": "http.response.start",
                        "status": 200,
                        "headers": [(b"content-type", b"application/json")],
                    }
                )
                await send(
                    {"type": "http.response.body", "body": json.dumps(state).encode()}
                )
            else:
                await app(scope, receive, send)

        return wrapped

    return wrap
