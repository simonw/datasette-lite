"""A tiny stand-in for the OpenAI Responses API, for testing datasette-agent
in Datasette Lite without a real model or API key.

    python tests/mock_openai.py 8010

It sends CORS headers, as api.openai.com does, since the requests come from
fetch() in a browser. POST /v1/responses plays a fixed script, streamed slowly
enough to watch it arrive: a list_databases_and_tables tool call, then a
sql_query tool call, then a sentence that quotes the result of that query.
GET /_requests lists what each request carried."""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DELAY = 0.15
SQL = "select count(*) as number_of_items from items"
ANSWER = "The mock model streamed this answer one word at a time. The query returned: {}"
requests = []


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            self.headers.get("Access-Control-Request-Headers", "*"),
        )

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def event(self, payload):
        self.seq += 1
        payload["sequence_number"] = self.seq
        data = "event: {}\ndata: {}\n\n".format(payload["type"], json.dumps(payload))
        chunk = data.encode("utf-8")
        self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
        self.wfile.flush()
        time.sleep(DELAY)

    def do_GET(self):
        body = json.dumps(requests).encode("utf-8")
        self.send_response(200 if self.path == "/_requests" else 404)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        requests.append({
            "path": self.path,
            "authorization": self.headers.get("Authorization"),
            "model": body.get("model"),
            "stream": body.get("stream"),
            "tools": [tool.get("name") for tool in body.get("tools") or []],
        })
        if not self.path.endswith("/responses"):
            self.send_response(404)
            self.cors()
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        items = body["input"] if isinstance(body.get("input"), list) else []
        outputs = [i for i in items if i.get("type") == "function_call_output"]
        self.seq = 0
        self.send_response(200)
        self.cors()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        base = {
            "id": "resp_mock_%d" % len(outputs), "object": "response",
            "created_at": int(time.time()), "model": body.get("model"),
            "status": "in_progress", "output": [], "tools": [],
            "parallel_tool_calls": True, "tool_choice": "auto",
        }
        self.event({"type": "response.created", "response": base})
        if len(outputs) == 0:
            item = self.tool_call("list_databases_and_tables", {})
        elif len(outputs) == 1:
            item = self.tool_call(
                "sql_query", {"database": "data", "sql": SQL, "display": "both"}
            )
        else:
            item = self.text(ANSWER.format(str(outputs[-1].get("output"))[:200]))
        usage = {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15,
                 "input_tokens_details": {"cached_tokens": 0},
                 "output_tokens_details": {"reasoning_tokens": 0}}
        self.event({"type": "response.completed", "response": dict(
            base, status="completed", output=[item], usage=usage)})
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def tool_call(self, name, arguments):
        n = self.seq
        item = {"id": "fc_%d" % n, "type": "function_call", "call_id": "call_%d" % n,
                "name": name, "arguments": "", "status": "in_progress"}
        self.event({"type": "response.output_item.added", "output_index": 0, "item": item})
        args = json.dumps(arguments)
        for i in range(0, len(args), 12):
            self.event({"type": "response.function_call_arguments.delta",
                        "item_id": item["id"], "output_index": 0, "delta": args[i:i + 12]})
        self.event({"type": "response.function_call_arguments.done",
                    "item_id": item["id"], "output_index": 0, "arguments": args, "name": name})
        done = dict(item, arguments=args, status="completed")
        self.event({"type": "response.output_item.done", "output_index": 0, "item": done})
        return done

    def text(self, text):
        item = {"id": "msg_1", "type": "message", "role": "assistant",
                "status": "in_progress", "content": []}
        self.event({"type": "response.output_item.added", "output_index": 0, "item": item})
        part = {"type": "output_text", "text": "", "annotations": []}
        self.event({"type": "response.content_part.added", "item_id": "msg_1",
                    "output_index": 0, "content_index": 0, "part": part})
        for word in text.split(" "):
            self.event({"type": "response.output_text.delta", "item_id": "msg_1",
                        "output_index": 0, "content_index": 0, "delta": word + " ",
                        "logprobs": []})
        self.event({"type": "response.output_text.done", "item_id": "msg_1",
                    "output_index": 0, "content_index": 0, "text": text, "logprobs": []})
        done_part = dict(part, text=text)
        self.event({"type": "response.content_part.done", "item_id": "msg_1",
                    "output_index": 0, "content_index": 0, "part": done_part})
        done = dict(item, status="completed", content=[done_part])
        self.event({"type": "response.output_item.done", "output_index": 0, "item": done})
        return done


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8010
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
