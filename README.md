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

This example SQL file creates a table and populates it with three records:

    https://gist.githubusercontent.com/simonw/ac4e19920b4b360752ac0f3ce85ba238/raw/90d31cf93bf1d97bb496de78559798f849b17e85/demo.sql

You can paste this into the "Load SQL by URL" prompt, or you can pass it as the `?sql=` parameter [like this](https://lite.datasette.io/?sql=https%3A%2F%2Fgist.githubusercontent.com%2Fsimonw%2Fac4e19920b4b360752ac0f3ce85ba238%2Fraw%2F90d31cf93bf1d97bb496de78559798f849b17e85%2Fdemo.sql).

SQL will be executed before any CSV imports, so you can use initial SQL to create a table and then use `?csv=` to import data into it.
