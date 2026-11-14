"""Responses that Datasette sends over time - server-sent events, as used by
chat interfaces - reach the page as they are produced, and Datasette is told
when the page stops reading one."""
import re
import time

import pytest
from playwright.sync_api import Page

from conftest import boot, datasette_frame


@pytest.fixture(scope="module")
def page(shared_context, static_server, stream_plugin):
    "One Datasette Lite tab for the whole module, with the test stream plugin"
    page = shared_context.new_page()
    boot(page, static_server + "/?memory=1&install=" + stream_plugin)
    yield page
    page.close()


def stream_url(page: Page, n, delay):
    base = re.match(r"(/app/[^/]+)", datasette_frame(page).evaluate("location.pathname")).group(1)
    return "{}/-/test-stream?n={}&delay={}".format(base, n, delay)


def stream_state(page: Page):
    "The plugin's counters, read through the shell so the iframe can be elsewhere"
    return datasette_frame(page).evaluate(
        "async () => (await fetch(location.pathname.match(/^.*?\\/app\\/[^/]+/)[0] + '/-/test-stream-state')).json()"
    )


def wait_for_state(page: Page, key, value, timeout=10):
    deadline = time.time() + timeout
    while True:
        state = stream_state(page)
        if state[key] == value or time.time() > deadline:
            return state
        time.sleep(0.1)


READ_STREAM = """async (url) => {
    const started = performance.now();
    const response = await fetch(url);
    const headersAt = performance.now() - started;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const reads = [];
    while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        reads.push([performance.now() - started, decoder.decode(value)]);
    }
    return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        headersAt,
        reads,
        total: performance.now() - started,
    };
}"""


def test_streamed_response_arrives_as_it_is_produced(page):
    result = datasette_frame(page).evaluate(READ_STREAM, stream_url(page, 5, 0.4))
    assert result["status"] == 200
    assert result["contentType"] == "text/event-stream"
    assert "".join(text for _, text in result["reads"]) == "".join(
        "data: tick {}\n\n".format(i) for i in range(5)
    )
    # Five events 0.4s apart: the whole response takes two seconds, but the
    # headers and the first event are there straight away, and the events
    # are read one after another rather than all together at the end
    assert result["total"] > 1900
    assert result["headersAt"] < 1000
    assert result["reads"][0][0] < 1000
    assert len(result["reads"]) >= 3
    assert page.evaluate("pending.size") == 0


def test_aborting_a_streamed_response_tells_datasette(page):
    before = stream_state(page)
    datasette_frame(page).evaluate(
        """async (url) => {
            const controller = new AbortController();
            const response = await fetch(url, {signal: controller.signal});
            await response.body.getReader().read();
            controller.abort();
        }""",
        stream_url(page, 100, 0.1),
    )
    state = wait_for_state(page, "disconnected", before["disconnected"] + 1)
    assert state["disconnected"] == before["disconnected"] + 1
    # It stopped early, rather than sending all 100 events to nobody
    assert state["sent"] - before["sent"] < 50
    assert state["finished"] == before["finished"]
    assert page.evaluate("pending.size") == 0


def test_navigating_away_from_a_streamed_response_tells_datasette(page):
    before = stream_state(page)
    frame = datasette_frame(page)
    frame.evaluate(
        """async (url) => {
            window.streamResponse = await fetch(url);
            await window.streamResponse.body.getReader().read();
        }""",
        stream_url(page, 100, 0.1),
    )
    with page.expect_event("framenavigated"):
        frame.evaluate("location.reload()")
    state = wait_for_state(page, "disconnected", before["disconnected"] + 1)
    assert state["disconnected"] == before["disconnected"] + 1
    assert state["finished"] == before["finished"]


def test_head_request_for_a_streamed_response(page):
    before = stream_state(page)
    result = datasette_frame(page).evaluate(
        """async (url) => {
            const response = await fetch(url, {method: "HEAD"});
            return {status: response.status, text: await response.text()};
        }""",
        stream_url(page, 100, 0.1),
    )
    assert result == {"status": 200, "text": ""}
    # Nothing is going to read the body, so the stream is called off
    state = wait_for_state(page, "disconnected", before["disconnected"] + 1)
    assert state["disconnected"] == before["disconnected"] + 1


def test_service_worker_that_cannot_stream_gets_the_whole_response(page):
    """A service worker from before streaming does not ask for it, and is
    sent each response in one message once it is complete - as it expects."""
    url = stream_url(page, 3, 0.1)
    result = page.evaluate(
        """async (url) => {
            const channel = new MessageChannel();
            const messages = [];
            const first = new Promise((resolve) => {
                channel.port1.onmessage = (event) => {
                    messages.push(event.data);
                    resolve();
                };
            });
            callWorker(
                {method: "GET", url: location.origin + url, headers: [], body: null},
                channel.port2,
                false,
            );
            await first;
            await new Promise((resolve) => setTimeout(resolve, 300));
            return {
                count: messages.length,
                status: messages[0].status,
                stream: messages[0].stream || false,
                text: new TextDecoder().decode(messages[0].body),
            };
        }""",
        url,
    )
    assert result == {
        "count": 1,
        "status": 200,
        "stream": False,
        "text": "data: tick 0\n\ndata: tick 1\n\ndata: tick 2\n\n",
    }


def test_worker_error_breaks_off_a_streamed_response(shared_context, static_server, stream_plugin):
    "If the Pyodide worker dies part way through, the read fails rather than hanging"
    page = shared_context.new_page()
    try:
        boot(page, static_server + "/?memory=1&install=" + stream_plugin)
        frame = datasette_frame(page)
        frame.evaluate(
            """async (url) => {
                const response = await fetch(url);
                window.streamReader = response.body.getReader();
                await window.streamReader.read();
            }""",
            stream_url(page, 100, 0.1),
        )
        page.evaluate("datasetteWorker.terminate()")
        page.evaluate(
            "datasetteWorker.dispatchEvent(new ErrorEvent('error', {message: 'out of memory'}))"
        )
        result = frame.evaluate(
            """async () => {
                const failed = (async () => {
                    try {
                        while (!(await window.streamReader.read()).done) {}
                        return "ended";
                    } catch (error) {
                        return "failed";
                    }
                })();
                return Promise.race([
                    failed,
                    new Promise((resolve) => setTimeout(() => resolve("timed out"), 5000)),
                ]);
            }"""
        )
        assert result == "failed"
        assert page.evaluate("pending.size") == 0
    finally:
        page.close()
