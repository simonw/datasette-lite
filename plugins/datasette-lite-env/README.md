# datasette-lite-env

Set environment variables from Datasette plugin configuration.

[Datasette Lite](https://lite.datasette.io/) runs Python in the browser, where there is no shell to `export` variables from. This plugin copies the `env` dictionary from its configuration into `os.environ` when Datasette starts:

```yaml
plugins:
  datasette-lite-env:
    env:
      OPENAI_BASE_URL: http://localhost:8010/v1
```

Anything that reads its settings when it is used, rather than when it is imported, sees them. A value of `null` removes a variable.

Configuration is fetched from a URL, so only put a secret such as an API key in it if that URL is on your own machine.

## Using it with Datasette Lite

The plugin is not on PyPI. Build a wheel and serve it alongside Datasette Lite:

```bash
uv build --wheel plugins/datasette-lite-env
./serve.sh
```

Then pass the wheel's URL to `?install=`, and a configuration file to `?config=`:

    http://localhost:8009/?install=http://localhost:8009/plugins/datasette-lite-env/dist/datasette_lite_env-0.1-py3-none-any.whl&config=http://localhost:8009/local/datasette.json

See [Running Datasette Agent](../../README.md#running-datasette-agent) for an example.
