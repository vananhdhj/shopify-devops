#!/usr/bin/env python3
"""Expand/contract check for migrations (Phase 4, ADR-0021).

A release reaches the cells one wave at a time, and a cell's migration runs before its new pods
start, so the previous release's images always run, for a while, against the new schema. A
migration may only *expand* the schema. A statement that would break the previous images (drop,
rename, retype, tighten) is refused unless the file says it is a contract step:

    -- contract: <why it is safe now: the release after which no image uses what it removes>

Only the `-- migrate:up` section is checked; dollar-quoted bodies and comments are ignored.
    migration-lint.py <file>...      exit 1 with every refused statement, 0 when all pass
"""
import re
import sys

DESTRUCTIVE = [
    (r"^DROP\s+(TABLE|SCHEMA|VIEW|MATERIALIZED\s+VIEW|FUNCTION|PROCEDURE|TYPE|SEQUENCE)\b", "drops an object the previous images may use"),
    (r"^ALTER\s+TABLE\b.*\bDROP\s+(COLUMN\s+)?(?!CONSTRAINT\b|DEFAULT\b|NOT\s+NULL\b|IDENTITY\b|EXPRESSION\b)\"?\w+", "drops a column"),
    (r"\bRENAME\b", "renames something the previous images name"),
    (r"\bALTER\s+COLUMN\s+\"?\w+\"?\s+(SET\s+DATA\s+)?TYPE\b", "changes a column's type"),
    (r"\bSET\s+NOT\s+NULL\b", "makes a column NOT NULL (the previous images may not write it)"),
]
# A column added by ALTER TABLE, up to the next comma: `ADD [COLUMN] [IF NOT EXISTS] name type ...`.
ADDED_COLUMN = re.compile(
    r"\bADD\s+(?!CONSTRAINT\b|PRIMARY\b|UNIQUE\b|FOREIGN\b|CHECK\b|EXCLUDE\b)(COLUMN\s+)?(IF\s+NOT\s+EXISTS\s+)?\"?\w+\"?\s+[^,]*"
)


def up_section(text: str) -> str:
    start = text.find("-- migrate:up")
    end = text.find("-- migrate:down")
    return text[start if start >= 0 else 0 : end if end >= 0 else len(text)]


def statements(sql: str) -> list[str]:
    sql = re.sub(r"\$(\w*)\$.*?\$\1\$", "$$", sql, flags=re.S)  # function bodies
    sql = re.sub(r"--[^\n]*", "", sql)  # comments
    sql = re.sub(r"'(?:[^']|'')*'", "''", sql)  # string literals
    return [" ".join(part.split()).upper() for part in sql.split(";") if part.strip()]


def refusals(text: str) -> list[str]:
    found = []
    for statement in statements(up_section(text)):
        for pattern, why in DESTRUCTIVE:
            if re.search(pattern, statement):
                found.append(f"{why}: {statement[:120]}")
        # A new NOT NULL column without a default: the previous images' INSERTs omit it and fail.
        if statement.startswith("ALTER TABLE"):
            for match in ADDED_COLUMN.finditer(statement):
                column = match.group(0)
                if re.search(r"\bNOT\s+NULL\b", column) and not re.search(r"\bDEFAULT\b", column):
                    found.append(f"adds a NOT NULL column without a default: {statement[:120]}")
    return found


def main(paths: list[str]) -> int:
    failed = False
    for path in paths:
        text = open(path, encoding="utf-8").read()
        if re.search(r"^--\s*contract:\s*\S", text, flags=re.M):
            print(f"{path}: contract step, destructive statements allowed")
            continue
        problems = refusals(text)
        for problem in problems:
            print(f"::error file={path}::{problem} (expand/contract, ADR-0021: mark a deliberate contract step with '-- contract: <why it is safe now>')")
        if problems:
            failed = True
        else:
            print(f"{path}: expand only")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
