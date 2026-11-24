"""Run one verifier query with the complete libpq URI supplied on stdin."""

import ctypes as c
from ctypes.util import find_library
import sys


def query(uri, sql):
    try:
        library = find_library("pq")
        if not library:
            return 10
        pq = c.CDLL(library)
    except OSError:
        return 10

    pointer = c.c_void_p
    string = c.c_char_p
    integer = c.c_int
    for name, result, arguments in (
        ("PQconnectdb", pointer, [string]),
        ("PQstatus", integer, [pointer]),
        ("PQexec", pointer, [pointer, string]),
        ("PQresultStatus", integer, [pointer]),
        ("PQntuples", integer, [pointer]),
        ("PQgetvalue", string, [pointer, integer, integer]),
        ("PQclear", None, [pointer]),
        ("PQfinish", None, [pointer]),
    ):
        function = getattr(pq, name)
        function.restype = result
        function.argtypes = arguments

    connection = pq.PQconnectdb(uri)
    try:
        if not connection or pq.PQstatus(connection) != 0:  # CONNECTION_OK
            return 11
        result = pq.PQexec(connection, sql)
        try:
            if not result or pq.PQresultStatus(result) != 2:  # PGRES_TUPLES_OK
                return 12
            for row in range(pq.PQntuples(result)):
                sys.stdout.buffer.write(pq.PQgetvalue(result, row, 0) + b"\n")
        finally:
            pq.PQclear(result)
    finally:
        pq.PQfinish(connection)
    return 0


if __name__ == "__main__":
    sys.exit(query(sys.stdin.buffer.readline().removesuffix(b"\n"), sys.argv[1].encode()))
