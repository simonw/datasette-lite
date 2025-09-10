#!/bin/sh
uv run --with-requirements dev-requirements.txt playwright install
uv run --with-requirements dev-requirements.txt pytest

