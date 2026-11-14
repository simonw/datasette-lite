"""Set environment variables from Datasette plugin configuration.

Datasette Lite runs Python in the browser, where there is no shell to export
variables from - but plenty of libraries are configured that way. This plugin
copies the "env" dictionary from its configuration into os.environ as
Datasette starts:

    plugins:
      datasette-lite-env:
        env:
          OPENAI_API_KEY: sk-...

Anything that reads its settings when it is used, rather than when it is
imported, will see them - LLM API keys, for example."""
import os

from datasette import hookimpl


@hookimpl(tryfirst=True)
def startup(datasette):
    config = datasette.plugin_config("datasette-lite-env") or {}
    for name, value in (config.get("env") or {}).items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = str(value)
