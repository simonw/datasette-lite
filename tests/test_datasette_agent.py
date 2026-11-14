"""datasette-agent - an LLM chat assistant that queries the databases with
tools - running in Datasette Lite.

Everything happens in the browser: the model is called by the OpenAI client
library inside Pyodide, whose HTTP requests are made with fetch() from the
Web Worker. Here they go to a stand-in for the OpenAI API (mock_openai.py)."""
import base64
import json
import os
import urllib.request

from playwright.sync_api import expect

from conftest import boot

API_KEY = "sk-entered-on-the-secrets-page"


def test_datasette_agent_chat(shared_context, static_server, plugin_wheels, mock_openai, generated_fixtures):
    (generated_fixtures / "agent-config.json").write_text(
        json.dumps(
            {
                "plugins": {
                    "datasette-llm": {"default_model": "gpt-5.4-mini"},
                    # Lets the API key be entered on the /-/secrets page
                    "datasette-secrets": {
                        "encryption-key": base64.urlsafe_b64encode(os.urandom(32)).decode()
                    },
                    # Sends the OpenAI client library to the stand-in API
                    "datasette-lite-env": {"env": {"OPENAI_BASE_URL": mock_openai + "/v1"}},
                }
            }
        )
    )
    page = shared_context.new_page()
    try:
        frame = boot(
            page,
            static_server
            + "/?root=1&install=datasette-agent&install="
            + plugin_wheels["datasette-lite-env"]
            + "&config=tests/fixtures/generated/agent-config.json"
            + "&csv=tests/fixtures/items.csv#/-/agent",
            wait_for="#new-message",
        )
        # No API key yet, so there are no models to choose from
        expect(frame.locator("#new-model")).to_have_count(0)

        # Enter the key in the browser - it is never in a file or a URL
        page.evaluate("location.hash = '#/-/secrets/OPENAI_API_KEY'")
        frame.locator("textarea[name=secret]").fill(API_KEY)
        frame.locator("input[name=note]").fill("Entered by the test")
        frame.locator("input[type=submit]").click()
        expect(frame.locator("body")).to_contain_text("Secret OPENAI_API_KEY updated")

        page.evaluate("location.hash = '#/-/agent'")
        expect(frame.locator("#new-model")).to_have_value("gpt-5.4-mini")
        frame.locator("#new-message").fill("How many items are there?")
        frame.locator("#new-chat-form button[type=submit]").click()

        # The answer is streamed: its first words are on the page while the
        # rest - which quotes the result of the SQL query - is still to come
        answer = frame.locator(".agent-message-assistant")
        expect(answer).to_contain_text("The mock model streamed", timeout=60 * 1000)
        assert "number_of_items" not in answer.inner_text()
        expect(answer).to_contain_text('"number_of_items": 3', timeout=30 * 1000)

        # Both tool calls ran against the database in Pyodide, and the result
        # of the query was shown as a table
        expect(frame.locator(".agent-tool-name")).to_have_text(
            ["list_databases_and_tables", "sql_query"]
        )
        expect(frame.locator("#messages table th").first).to_have_text("number_of_items")
        expect(frame.locator("#messages table td").first).to_have_text("3")
    finally:
        page.close()

    with urllib.request.urlopen(mock_openai + "/_requests") as response:
        requests = json.load(response)
    # One request to the model for each step: two tool calls, then the answer
    assert [request["path"] for request in requests] == ["/v1/responses"] * 3
    for request in requests:
        assert request["authorization"] == "Bearer " + API_KEY
        assert request["model"] == "gpt-5.4-mini"
        assert request["stream"] is True
        assert "sql_query" in request["tools"]
