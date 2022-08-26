# Datasette Lite

Datasette running in your browser using WebAssembly and [Pyodide](https://pyodide.org)

Live tool: https://lite.datasette.io/

More about this project:

- [Datasette Lite: a server-side Python web application running in a browser](https://simonwillison.net/2022/May/4/datasette-lite/)
- [Joining CSV files in your browser using Datasette Lite](https://simonwillison.net/2022/Jun/20/datasette-lite-csvs/)

## How this works

Datasette Lite runs the full server-side Datasette Python web application directly in your browser, using the [Pyodide](https://pyodide.org) build of Python compiled to WebAssembly.

When you launch the demo, your browser will download and start executing a full Python interpreter, install the [datasette](https://pypi.org/project/datasette/) package (and its dependencies), download one or more SQLite database files and start the application running in a browser window (actually a [Web Worker](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers) attached to that window).

## Loading CSV data

You can load data from a CSV file hosted online (provided it allows `access-control-allow-origin: *`) by passing that URL as a `?csv=` parameter - or by clicking the "Load CSV by URL" button and pasting in a URL.

This example loads a CSV of college fight songs from the [fivethirtyeight/data](https://github.com/fivethirtyeight/data/blob/master/fight-songs/README.md) GitHub repository:

- https://lite.datasette.io/?csv=https%3A%2F%2Fraw.githubusercontent.com%2Ffivethirtyeight%2Fdata%2Fmaster%2Ffight-songs%2Ffight-songs.csv

You can pass `?csv=` multiple times to load more than one CSV file. You can then execute SQL joins to combine that data.

This example loads [the latest Covid-19 per-county data](https://github.com/nytimes/covid-19-data) from the NY Times, the 2019 county populations data from the US Census, joins them on FIPS code and runs a query that calculates cases per million across that data:

[https://lite.datasette.io/?csv=https://raw.githubusercontent.com/nytimes/covid-19-data/master/us-counties-recent.csv&csv=https://raw.githubusercontent.com/simonw/covid-19-datasette/main/us_census_county_populations_2019.csv#/data?sql=select%0A++%5Bus-counties-recent%5D.*%2C%0A++us_census_county_populations_2019.population%2C%0A++1.0+*+%5Bus-counties-recent%5D.cases+%2F+us_census_county_populations_2019.population+*+1000000+as+cases_per_million%0Afrom%0A++%5Bus-counties-recent%5D%0A++join+us_census_county_populations_2019+on+us_census_county_populations_2019.fips+%3D+%5Bus-counties-recent%5D.fips%0Awhere%0A++population+%3E+10000%0Aorder+by%0A++cases_per_million+desc
](https://lite.datasette.io/?csv=https://raw.githubusercontent.com/nytimes/covid-19-data/master/us-counties-recent.csv&csv=https://raw.githubusercontent.com/simonw/covid-19-datasette/main/us_census_county_populations_2019.csv#/data?sql=select%0A++%5Bus-counties-recent%5D.*%2C%0A++us_census_county_populations_2019.population%2C%0A++1.0+*+%5Bus-counties-recent%5D.cases+%2F+us_census_county_populations_2019.population+*+1000000+as+cases_per_million%0Afrom%0A++%5Bus-counties-recent%5D%0A++join+us_census_county_populations_2019+on+us_census_county_populations_2019.fips+%3D+%5Bus-counties-recent%5D.fips%0Awhere%0A++date+%3D+%28select+max%28date%29+from+%5Bus-counties-recent%5D%29%0Aorder+by%0A++cases_per_million+desc)

## Loading SQLite databases

You can use this tool to open any SQLite database file that is hosted online and served with a `access-control-allow-origin: *` CORS header. Files served by GitHub Pages automatically include this header, as do database files that have been published online [using datasette publish](https://docs.datasette.io/en/stable/publish.html).

Copy the URL to the `.db` file and either paste it into the "Load SQLite DB by URL" prompt, or construct a URL like the following:

    https://lite.datasette.io/?url=https://latest.datasette.io/fixtures.db

Some examples to try out:

- [Global Power Plants](https://lite.datasette.io/?url=https://global-power-plants.datasettes.com/global-power-plants.db) - 33,000 power plants around the world
- [United States members of congress](https://lite.datasette.io/?url=https://congress-legislators.datasettes.com/legislators.db) - the example database from the [Learn SQL with Datasette](https://datasette.io/tutorials/learn-sql) tutorial

## Initializing with SQL

You can also initialize the `data.db` database by passing the URL to a SQL file. The easiest way to do this is to create a [GitHub Gist](https://gist.github.com/).

This [example SQL file](https://gist.githubusercontent.com/simonw/ac4e19920b4b360752ac0f3ce85ba238/raw/90d31cf93bf1d97bb496de78559798f849b17e85/demo.sql) creates a table and populates it with three records. It's hosted in [this Gist](https://gist.github.com/simonw/ac4e19920b4b360752ac0f3ce85ba238).

    https://gist.githubusercontent.com/simonw/ac4e19920b4b360752ac0f3ce85ba238/raw/90d31cf93bf1d97bb496de78559798f849b17e85/demo.sql

You can paste this URL into the "Load SQL by URL" prompt, or you can pass it as the `?sql=` parameter [like this](https://lite.datasette.io/?sql=https%3A%2F%2Fgist.githubusercontent.com%2Fsimonw%2Fac4e19920b4b360752ac0f3ce85ba238%2Fraw%2F90d31cf93bf1d97bb496de78559798f849b17e85%2Fdemo.sql).

SQL will be executed before any CSV imports, so you can use initial SQL to create a table and then use `?csv=` to import data into it.

## Installing plugins

Datasette has a number of [plugins](https://datasette.io/plugins) that enable new features.

You can install plugins into Datasette Lite by adding one or more `?install=name-of-plugin` parameters to the URL.

Not all plugins are compatible with Datasette Lite at the moment, for example plugins that load their own JavaScript and CSS do not currently work, see [issue #8](https://github.com/simonw/datasette-lite/issues/8).

Here's a list of plugins that have been tested with Datasette Lite, plus demo links to see them in action:

- [datasette-packages](https://datasette.io/plugins/datasette-packages) - Show a list of currently installed Python packages - [demo](https://lite.datasette.io/?install=datasette-packages#/-/packages)
- [datasette-dateutil](https://datasette.io/plugins/datasette-dateutil) - dateutil functions for Datasette - [demo](https://lite.datasette.io/?install=datasette-dateutil#/fixtures?sql=select%0A++dateutil_parse%28%2210+october+2020+3pm%22%29%2C%0A++dateutil_parse_fuzzy%28%22This+is+due+10+september%22%29%2C%0A++dateutil_parse%28%221%2F2%2F2020%22%29%2C%0A++dateutil_parse%28%222020-03-04%22%29%2C%0A++dateutil_parse_dayfirst%28%222020-03-04%22%29%3B)
- [datasette-schema-versions](https://datasette.io/plugins/datasette-schema-versions) - Datasette plugin that shows the schema version of every attached database - [demo](https://lite.datasette.io/?install=datasette-schema-versions#/-/schema-versions)
- [datasette-debug-asgi](https://datasette.io/plugins/datasette-debug-asgi) - Datasette plugin for dumping out the ASGI scope. - [demo](https://lite.datasette.io/?install=datasette-debug-asgi#/-/asgi-scope)
- [datasette-query-links](https://datasette.io/plugins/datasette-query-links) - Turn SELECT queries returned by a query into links to execute them - [demo](https://lite.datasette.io/?install=datasette-query-links#/fixtures?sql=select%0D%0A++'select+*+from+[facetable]'+as+query%0D%0Aunion%0D%0Aselect%0D%0A++'select+sqlite_version()'%0D%0Aunion%0D%0Aselect%0D%0A++'select+this+is+invalid+SQL+so+will+not+be+linked')
- [datasette-json-html](https://datasette.io/plugins/datasette-json-html) - Datasette plugin for rendering HTML based on JSON values - [demo](https://lite.datasette.io/?install=datasette-json-html#/fixtures?sql=select+%27%5B%0A++++%7B%0A++++++++%22href%22%3A+%22https%3A%2F%2Fsimonwillison.net%2F%22%2C%0A++++++++%22label%22%3A+%22Simon+Willison%22%0A++++%7D%2C%0A++++%7B%0A++++++++%22href%22%3A+%22https%3A%2F%2Fgithub.com%2Fsimonw%2Fdatasette%22%2C%0A++++++++%22label%22%3A+%22Datasette%22%0A++++%7D%0A%5D%27+as+output)
- [datasette-haversine](https://datasette.io/plugins/datasette-haversine) - Datasette plugin that adds a custom SQL function for haversine distances - [demo](https://lite.datasette.io/?install=datasette-haversine#/fixtures?sql=select+haversine%280%2C+154%2C+1%2C+131%29)
- [datasette-jellyfish](https://datasette.io/plugins/datasette-jellyfish) - Datasette plugin that adds custom SQL functions for fuzzy string matching, built on top of the Jellyfish Python library - [demo](https://lite.datasette.io/?install=datasette-jellyfish#/fixtures?sql=SELECT%0A++++levenshtein_distance%28%3As1%2C+%3As2%29%2C%0A++++damerau_levenshtein_distance%28%3As1%2C+%3As2%29%2C%0A++++hamming_distance%28%3As1%2C+%3As2%29%2C%0A++++jaro_similarity%28%3As1%2C+%3As2%29%2C%0A++++jaro_winkler_similarity%28%3As1%2C+%3As2%29%2C%0A++++match_rating_comparison%28%3As1%2C+%3As2%29%3B&s1=barrack+obama&s2=barrack+h+obama)
- [datasette-pretty-json](https://datasette.io/plugins/datasette-pretty-json) - Datasette plugin that pretty-prints any column values that are valid JSON objects or arrays. - [demo](https://lite.datasette.io/?install=datasette-pretty-json#/fixtures?sql=select+%27%7B%22this%22%3A+%5B%22is%22%2C+%22nested%22%2C+%22json%22%5D%7D%27)
- [datasette-yaml](https://datasette.io/plugins/datasette-yaml) - Export Datasette records as YAML - [demo](https://lite.datasette.io/?install=datasette-yaml#/fixtures/compound_three_primary_keys.yaml)
- [datasette-copyable](https://datasette.io/plugins/datasette-copyable) - Datasette plugin for outputting tables in formats suitable for copy and paste - [demo](https://lite.datasette.io/?install=datasette-copyable#/fixtures/compound_three_primary_keys.copyable?_table_format=github)
- [datasette-mp3-audio](https://datasette.io/plugins/datasette-mp3-audio) - Turn `.mp3` URLs into an audio player in the Datasette interface - [demo](https://lite.datasette.io/?install=datasette-mp3-audio&csv=https://gist.githubusercontent.com/simonw/0a30d52feeb3ff60f7d8636b0bde296b/raw/c078a9e5a0151331e2e46c04c1ebe7edc9f45e8c/scotrail-announcements.csv#/data/scotrail-announcements)
- [datasette-multiline-links](https://datasette.io/plugins/datasette-multiline-links) - Make multiple newline separated URLs clickable in Datasette - [demo](https://lite.datasette.io/?install=datasette-multiline-links&csv=https://docs.google.com/spreadsheets/d/1wZhPLMCHKJvwOkP4juclhjFgqIY8fQFMemwKL2c64vk/export?format=csv#/data?sql=select+edition%2C+headline%2C+text%2C+links%2C+hattips+from+export+where%0Atext+like+'%25'+||+%3Aq+||+'%25'+or+headline+like+'%25'+||+%3Aq+||+'%25'+order+by+edition+desc&q=loans)
