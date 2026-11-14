"""Pure-Python unit tests of the ASGI bridge that runs inside Pyodide.

The Python source is extracted from the String.raw block in webworker.js,
so the code tested here is exactly the code that ships."""
import asyncio
import pathlib
import re

import pytest

WEBWORKER = pathlib.Path(__file__).parent.parent / "webworker.js"


def extract(name):
    source = WEBWORKER.read_text()
    match = re.search(
        r"// PYTHON-BEGIN {name}\n.*?String\.raw`(.*?)`;\n// PYTHON-END {name}".format(name=name),
        source,
        re.S,
    )
    assert match, name
    return match.group(1)


@pytest.fixture(scope="module")
def bridge():
    namespace = {}
    exec(extract("bridge"), namespace)
    return namespace


def run(coro):
    return asyncio.run(coro)


def test_python_blocks_are_string_raw_safe():
    for name in ("bridge", "startup"):
        source = extract(name)
        assert "`" not in source
        assert "${" not in source


def make_echo_app(set_cookies=()):
    async def app(scope, receive, send):
        if scope["type"] == "lifespan":
            message = await receive()
            if message["type"] == "lifespan.startup":
                await send({"type": "lifespan.startup.complete"})
            return
        body = b""
        while True:
            message = await receive()
            body += message.get("body", b"")
            if not message.get("more_body"):
                break
        headers = dict((k.decode(), v.decode()) for k, v in scope["headers"])
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"text/plain")]
                + [(b"set-cookie", c.encode()) for c in set_cookies],
            }
        )
        out = "{} {} {} {} cookie={} host={} body={}".format(
            scope["method"],
            scope["path"],
            scope["raw_path"].decode(),
            scope["query_string"].decode(),
            headers.get("cookie"),
            headers.get("host"),
            body.decode(),
        )
        await send({"type": "http.response.body", "body": out.encode()})

    return app


def test_scope_and_body(bridge):
    b = bridge["ASGIBridge"](make_echo_app())

    async def go():
        await b.startup()
        return await b.handle(
            "post", "/app/x/my table", "a=1", [["content-type", "text/plain"]], b"hello",
            host="localhost", port=8123, raw_path="/app/x/my%20table",
        )

    response = run(go())
    assert response["status"] == 200
    assert response["body"].decode() == (
        "POST /app/x/my table /app/x/my%20table a=1 cookie=None host=localhost:8123 body=hello"
    )


def test_cookie_jar_round_trip(bridge):
    cookies = ["ds_actor=abc; Path=/", "csrftoken=xyz; Path=/; SameSite=Lax"]
    b = bridge["ASGIBridge"](make_echo_app(cookies))

    async def go():
        first = await b.handle("GET", "/app/x/", "", [])
        second = await b.handle("GET", "/app/x/db", "", [])
        return first, second

    first, second = run(go())
    # Set-Cookie is consumed by the jar, never returned to the service worker
    assert not [h for h in first["headers"] if h[0].lower() == "set-cookie"]
    assert "cookie=None" in first["body"].decode()
    assert "cookie=ds_actor=abc; csrftoken=xyz" in second["body"].decode()


def test_cookie_jar_expiry_and_paths(bridge):
    jar = bridge["CookieJar"]()
    jar.store("a=1; Path=/", "/app/x/")
    jar.store("b=2; Path=/app/x/db", "/app/x/db")
    jar.store("c=3", "/app/x/db/table")  # default path /app/x/db
    assert jar.header_for("/app/x/") == "a=1"
    assert jar.header_for("/app/x/db/table") == "b=2; c=3; a=1"
    assert jar.header_for("/app/x/dbother") == "a=1"
    jar.store("a=deleted; Path=/; Max-Age=0", "/")
    assert jar.header_for("/app/x/") == ""
    jar.store('b=gone; Path=/app/x/db; expires=Thu, 01 Jan 1970 00:00:00 GMT', "/")
    assert jar.header_for("/app/x/db") == "c=3"
    jar.store("d=4; Path=/; expires=Fri, 01 Jan 2100 00:00:00 GMT", "/")
    assert "d=4" in jar.header_for("/")
    # Garbage is ignored
    jar.store("no-equals-sign", "/")
    jar.store("=novalue", "/")
    assert jar.as_dict() == {"c": "3", "d": "4"}


def test_signed_cookie_values_preserved(bridge):
    jar = bridge["CookieJar"]()
    value = '"eyJhIjp7ImlkIjoicm9vdCJ9fQ.abc_DEF-123"'
    jar.store("ds_actor={}; Path=/; HttpOnly".format(value), "/")
    assert jar.header_for("/") == "ds_actor=" + value


def html_app(body, location=None, status=200):
    async def app(scope, receive, send):
        headers = [(b"content-type", b"text/html; charset=utf-8"), (b"content-length", str(len(body)).encode())]
        if location:
            headers.append((b"location", location))
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body})

    return app


def call(bridge, app, path):
    b = bridge["ASGIBridge"](bridge["datasette_base_url_fixes"](app, "/app/s1/"))
    return run(b.handle("GET", path, "", []))


def test_base_url_fixes_jump(bridge):
    r = call(bridge, html_app(b'<navigation-search url="/-/jump"></navigation-search>'), "/app/s1/")
    assert r["body"] == b'<navigation-search url="/app/s1/-/jump"></navigation-search>'
    # content-length is dropped because the body changed
    assert not [h for h in r["headers"] if h[0] == "content-length"]


def test_base_url_fixes_double_prefix(bridge):
    body = (
        b'<a href="/app/s1/app/s1/data/items.json">json</a>'
        b'<a href="http://localhost:8000/app/s1/app/s1/data/items?_sort=id">sort</a>'
        b'<a href="/app/s1/app">db named app</a>'
    )
    r = call(bridge, html_app(body), "/app/s1/data/items")
    assert r["body"] == (
        b'<a href="/app/s1/data/items.json">json</a>'
        b'<a href="http://localhost:8000/app/s1/data/items?_sort=id">sort</a>'
        b'<a href="/app/s1/app">db named app</a>'
    )


def test_base_url_fixes_redirect(bridge):
    for location, expected in (
        (b"/data/-/query?sql=1", "/app/s1/data/-/query?sql=1"),
        (b"/app/s1/app/s1/data/items?name__exact=x", "/app/s1/data/items?name__exact=x"),
        (b"/app/s1/data", "/app/s1/data"),
        (b"//example.com/", "//example.com/"),
        (b"https://example.com/", "https://example.com/"),
    ):
        r = call(bridge, html_app(b"", location=location, status=302), "/app/s1/data")
        assert dict(r["headers"])["location"] == expected


def test_json_double_prefix_fixed_but_jump_untouched(bridge):
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": b'{"url": "/-/jump", "next_url": "http://x/app/s1/app/s1/db/t.json"}'})

    r = call(bridge, app, "/app/s1/")
    assert r["body"] == b'{"url": "/-/jump", "next_url": "http://x/app/s1/db/t.json"}'


def test_other_content_types_untouched(bridge):
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/csv")]})
        await send({"type": "http.response.body", "body": b"/app/s1/app/s1/"})

    r = call(bridge, app, "/app/s1/")
    assert r["body"] == b"/app/s1/app/s1/"


# --- Against a real Datasette (skipped if Datasette is not installed) ---------


@pytest.fixture
def datasette_bridge(bridge):
    pytest.importorskip("datasette")
    from datasette.app import Datasette

    async def make():
        ds = Datasette(memory=True, settings={"base_url": "/app/s1/", "num_sql_threads": 0})
        await ds.invoke_startup()
        b = bridge["ASGIBridge"](bridge["datasette_base_url_fixes"](ds.app(), "/app/s1/"))
        await b.startup()
        return ds, b

    return make


def test_real_datasette_root_login_csrf_post_and_messages(datasette_bridge):
    import secrets

    async def go():
        ds, b = await datasette_bridge()
        ds.root_enabled = True
        ds._root_token = secrets.token_hex(16)
        r = await b.handle("GET", "/app/s1/-/auth-token", "token=" + ds._root_token, [])
        assert r["status"] == 302
        assert "ds_actor" in b.cookies.as_dict()
        r = await b.handle("GET", "/app/s1/-/actor.json", "", [])
        assert b'"id": "root"' in r["body"]
        # GET the logout form: asgi-csrf sets its csrftoken cookie
        r = await b.handle("GET", "/app/s1/-/logout", "", [])
        html = r["body"].decode()
        token = re.search(r'name="csrftoken" value="([^"]+)"', html).group(1)
        assert "ds_csrftoken" in b.cookies.as_dict()
        # POST without the token is rejected...
        r = await b.handle(
            "POST", "/app/s1/-/logout", "",
            [["content-type", "application/x-www-form-urlencoded"]], b"",
        )
        assert r["status"] == 403
        # ...with it, succeeds, and redirects inside base_url
        r = await b.handle(
            "POST", "/app/s1/-/logout", "",
            [["content-type", "application/x-www-form-urlencoded"]],
            ("csrftoken=" + token).encode(),
        )
        assert r["status"] == 302
        headers = {k.lower(): v for k, v in r["headers"]}
        assert headers["location"].startswith("/app/s1/")
        # ds_actor was deleted from the jar; a ds_messages cookie was set
        assert "ds_actor" not in b.cookies.as_dict()
        r = await b.handle("GET", "/app/s1/", "", [])
        assert "You are now logged out" in r["body"].decode()
        # Messages are shown once
        r = await b.handle("GET", "/app/s1/", "", [])
        assert "You are now logged out" not in r["body"].decode()

    run(go())


def test_real_datasette_links_prefixed(datasette_bridge):
    async def go():
        ds, b = await datasette_bridge()
        r = await b.handle("GET", "/app/s1/_memory", "sql=select+1", [])
        html = r["body"].decode()
        assert 'href="/app/s1/-/static/app.css' in html
        assert "/app/s1/app/s1/" not in html
        r = await b.handle("GET", "/app/s1/_memory.json", "sql=select+1+as+n&_shape=array", [])
        assert r["body"] == b'[{"n": 1}]'

    run(go())


def test_hardcoded_root_relative_attributes(bridge):
    body = (
        b'<form action="/-/password-tool" method="post">'
        b"<a href='/-/plugins'>x</a><script src=\"/-/static/x.js\"></script>"
        b'<a href="/app/s1/-/ok">ok</a><a href="/other">other</a>'
        b'<p>Text mentioning href="/-/not-an-attribute"</p>'
    )
    r = call(bridge, html_app(body), "/app/s1/")
    assert r["body"] == (
        b'<form action="/app/s1/-/password-tool" method="post">'
        b"<a href='/app/s1/-/plugins'>x</a><script src=\"/app/s1/-/static/x.js\"></script>"
        b'<a href="/app/s1/-/ok">ok</a><a href="/other">other</a>'
        b'<p>Text mentioning href="/app/s1/-/not-an-attribute"</p>'
    )


def chunked_html_app(chunks):
    async def app(scope, receive, send):
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"text/html; charset=utf-8")],
            }
        )
        for i, chunk in enumerate(chunks):
            await send(
                {"type": "http.response.body", "body": chunk, "more_body": i < len(chunks) - 1}
            )

    return app


def test_rewrites_apply_across_chunk_boundaries(bridge):
    # A doubled prefix split across two chunks
    r = call(
        bridge,
        chunked_html_app([b'<a href="/app/s1/ap', b'p/s1/data/items.json">json</a>']),
        "/app/s1/data/items",
    )
    assert r["body"] == b'<a href="/app/s1/data/items.json">json</a>'
    # A hardcoded /-/ attribute split across three chunks, one of them empty
    r = call(
        bridge,
        chunked_html_app([b'<form action="/', b"", b'-/password-tool">']),
        "/app/s1/",
    )
    assert r["body"] == b'<form action="/app/s1/-/password-tool">'


def test_rewritten_body_is_sent_as_one_message(bridge):
    messages = []

    async def send(message):
        messages.append(message)

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    app = bridge["datasette_base_url_fixes"](
        chunked_html_app([b"<p>one", b" two", b" three</p>"]), "/app/s1/"
    )
    run(app({"type": "http", "method": "GET", "path": "/app/s1/"}, receive, send))
    bodies = [m for m in messages if m["type"] == "http.response.body"]
    assert bodies == [{"type": "http.response.body", "body": b"<p>one two three</p>", "more_body": False}]


# --- Streamed responses -------------------------------------------------------


def sse_app(events, delay=0.05, observed=None, set_cookies=()):
    "Sends each event as its own body message, as Datasette's AsgiStream does"

    async def app(scope, receive, send):
        await receive()
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"text/event-stream")]
                + [(b"set-cookie", c.encode()) for c in set_cookies],
            }
        )
        if observed is not None:
            # A real server answers receive() once the client has gone
            async def watch():
                observed.append((await receive())["type"])

            watcher = asyncio.ensure_future(watch())
        for event in events:
            await send({"type": "http.response.body", "body": event, "more_body": True})
            await asyncio.sleep(delay)
        await send({"type": "http.response.body", "body": b"", "more_body": False})
        if observed is not None:
            await watcher

    return app


def stream_recorder(bridge):
    "A ResponseStream that records what it is given, and when"
    calls = []
    stream = bridge["ResponseStream"](
        lambda status, headers: calls.append(("start", status, headers)),
        lambda chunk: calls.append(("chunk", chunk, asyncio.get_event_loop().time())),
    )
    return stream, calls


def test_response_in_pieces_is_streamed(bridge):
    b = bridge["ASGIBridge"](sse_app([b"data: one\n\n", b"data: two\n\n", b"data: three\n\n"]))

    async def go():
        stream, calls = stream_recorder(bridge)
        started = asyncio.get_event_loop().time()
        response = await b.handle("POST", "/app/x/-/stream", "", [], stream=stream)
        return response, calls, started

    response, calls, started = run(go())
    assert response["streamed"] is True
    assert response["status"] == 200
    assert response["body"] == b""
    assert calls[0] == ("start", 200, [["content-type", "text/event-stream"]])
    chunks = [call for call in calls[1:] if call[0] == "chunk"]
    assert b"".join(chunk for _, chunk, _ in chunks) == b"data: one\n\ndata: two\n\ndata: three\n\n"
    # Delivered as they were produced, not all together at the end
    assert len(chunks) == 3
    assert chunks[0][2] - started < 0.05
    assert chunks[-1][2] - chunks[0][2] > 0.08


def test_response_in_one_piece_is_not_streamed(bridge):
    b = bridge["ASGIBridge"](make_echo_app())

    async def go():
        stream, calls = stream_recorder(bridge)
        return await b.handle("GET", "/app/x/", "", [], stream=stream), calls

    response, calls = run(go())
    assert calls == []
    assert "streamed" not in response
    assert response["body"].startswith(b"GET /app/x/")


def test_response_in_pieces_is_buffered_without_a_stream(bridge):
    b = bridge["ASGIBridge"](sse_app([b"one ", b"two ", b"three"], delay=0))
    response = run(b.handle("GET", "/app/x/-/stream", "", []))
    assert "streamed" not in response
    assert response["body"] == b"one two three"


def test_streamed_response_stores_cookies(bridge):
    b = bridge["ASGIBridge"](sse_app([b"data: one\n\n"], set_cookies=["seen=yes; Path=/"]))

    async def go():
        stream, calls = stream_recorder(bridge)
        await b.handle("GET", "/app/x/-/stream", "", [], stream=stream)
        return calls

    calls = run(go())
    # Kept in the jar, never sent on to the service worker
    assert b.cookies.as_dict() == {"seen": "yes"}
    assert calls[0] == ("start", 200, [["content-type", "text/event-stream"]])


def test_pieces_sent_together_are_combined(bridge):
    rows = [b"%d,row\n" % i for i in range(1000)]
    b = bridge["ASGIBridge"](sse_app(rows, delay=0))

    async def go():
        stream, calls = stream_recorder(bridge)
        await b.handle("GET", "/app/x/data.csv", "", [], stream=stream)
        return calls

    calls = run(go())
    chunks = [call[1] for call in calls if call[0] == "chunk"]
    assert b"".join(chunks) == b"".join(rows)
    assert len(chunks) < 10


def test_large_stream_is_passed_on_before_it_is_complete(bridge):
    Stream = bridge["ResponseStream"]
    rows = [b"x" * 1024] * 200

    async def go():
        calls = []
        stream = Stream(lambda *args: None, calls.append)
        stream.start(200, [])
        for row in rows:
            # Never yields to the event loop, as a query run inline does not
            stream.write(row)
        before_flush = len(calls)
        stream.flush()
        return before_flush, calls

    before_flush, chunks = run(go())
    assert before_flush == 3
    assert all(len(chunk) == Stream.FLUSH_BYTES for chunk in chunks[:3])
    assert b"".join(chunks) == b"".join(rows)


def test_disconnect_reaches_the_app_and_stops_delivery(bridge):
    observed = []
    events = [b"data: %d\n\n" % i for i in range(10)]
    b = bridge["ASGIBridge"](sse_app(events, observed=observed))

    async def go():
        stream, calls = stream_recorder(bridge)
        task = asyncio.ensure_future(
            b.handle("GET", "/app/x/-/stream", "", [], stream=stream)
        )
        await asyncio.sleep(0.12)
        seen_before = len(calls)
        stream.disconnect()
        await asyncio.sleep(0.01)
        told = list(observed)
        # The app carries on to the end; nothing more is delivered
        response = await task
        return seen_before, calls, told, response

    seen_before, calls, told, response = run(go())
    assert told == ["http.disconnect"]
    assert 1 < seen_before < 6
    assert len(calls) == seen_before
    assert response["streamed"] is True
