"""A plugin that uses the standard library's sqlite3 module, as most plugins
do, to test that ?sqlite= changes the SQLite version for those as well.

    select stdlib_sqlite_version()

is the version of SQLite that "import sqlite3" gave this plugin."""
import sqlite3

from datasette import hookimpl


@hookimpl
def prepare_connection(conn):
    conn.create_function("stdlib_sqlite_version", 0, lambda: sqlite3.sqlite_version)
    conn.create_function(
        "stdlib_error_is_caught", 0, lambda: _stdlib_error_is_caught(conn)
    )


def _stdlib_error_is_caught(conn):
    # An error raised by Datasette's connection is caught by naming the
    # exception class from the standard library module
    try:
        sqlite3.connect(":memory:").execute("select * from no_such_table")
    except sqlite3.OperationalError:
        return 1
    return 0
