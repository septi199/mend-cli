# mend — implementation notes

Decisions taken where SPEC.md v1 is ambiguous, and what the practice set proved about them.
Nothing here changes the graded behaviour; it records why the code reads the way it does.

## 1. Tier-2 re-indent with an empty P (SPEC §5) — proven by practice

SPEC §5: at tier 2, a line of N that is not empty and not only whitespace, and
starts with P (the leading spaces/tabs of O's first line), has that P replaced by
F (the leading spaces/tabs of the file's first matched line).

When P is empty, every such line starts with P, so F is **prepended**. Practice
check `v-indent` (6b3a9d6e96db) proves the house reference does exactly this: O's
first line had no indent, the file's had two spaces, and the new line `} // node`
became `  } // node`. RESEARCH.md gotcha 1 claimed "if P is empty, nothing is
re-indented" — that is wrong; the first full practice run failed exactly that
check, and prepending F fixed it (100/100).

Context lines are never re-indented: they are written as the file's own matched
line. A non-context N line that does not start with P (P non-empty) is written
as-is.

## 2. A lone `--- ` line inside a hunk body is an old line (SPEC §6)

Body lines are those starting with ` `, `-`, `+`, `\`, or empty. A `--- x` line
starts with `-`, so it is an old line (`-- x`). Only a `--- ` line **followed by**
a `+++ ` line ends the body. RESEARCH.md gotcha 7 claims a lone `--- ` line ends
the body; the spec's literal text says otherwise, and the code follows the spec.
(Generated checks do not appear to produce a lone `--- ` body line either way.)

## 3. V4A blank lines are trimmed at section level only (SPEC §8)

"Blank lines at the end of a section (before the next section or `*** End Patch`)
are not part of it." The implementation collects a section's lines, trims trailing
blank lines, then parses chunks. Blank lines before an intermediate `@@` chunk
boundary, or before a `*** End of File` line, are therefore kept as body lines
(empty context lines). A `*** End of File` line with no open chunk is a parse
error at its line.

## 4. V4A `*** Move to:` must be the literal first line of its Update section

A blank line after the `*** Update File:` header starts chunk 1 (it is a body
line: an empty context line), so a `*** Move to:` after it is not first and is a
parse error at its line.

## 5. A second `--- ` + `+++ ` pair in a unified section header starts a new section

The first pair names the section's paths; a later pair is not "already part of a
section's header" and opens a new section. A `--- ` line not followed by `+++ `
inside a section's header is `error: parse <the line after it>`.

## 6. `*** End of File` is matched exactly

Unlike `*** Begin Patch` / `*** End Patch` (compared with surrounding whitespace
removed), `*** End of File` has no such note in SPEC §8, so it is matched
exactly. `*** Move to:` and `@@` anchors use their stated prefix/trim rules.

## 7. Directories at a path

A path that exists as a directory (not a file) counts as existing for `create`
and move-to (`exists`), and as missing for read/change/delete (`missing`). This
keeps the writer from ever trying to write a file over a directory.

## 8. `R` lines

Move edits are recorded per edit; at write time a record becomes an `R old ->
new` line only when the before/after states satisfy SPEC §2 (old existed before
and not after, new did not exist before and does after). If several records
touch the same paths, the first matching one wins and the rest fall back to
plain A/D/M rows. Rows sort by byte order, with `R` rows keyed by `<new>`.

## 9. Safety checks cover every path an edit names

For a unified section, both the old and the new path (when non-null) are checked
for safety, old first, before any missing/exists/matching check. For a move,
missing (old) is checked before exists (new).

## 10. SEARCH/REPLACE marker scan

`=======` and `>>>>>>> REPLACE` are found by a plain forward scan after the
SEARCH line, so a SEARCH line missing its own markers can swallow a later
block's markers (its old lines then run to that `=======`). The spec's parse
rule ("no `=======` and then `>>>>>>> REPLACE` after it") is read literally.

## 11. Degenerate cases

- A unified creation naming no file (`--- /dev/null` + `+++ /dev/null`) is a
  no-op success.
- An empty-O unified insertion index is clamped to `[0, lines.length]`.
- A unified hunk whose body is only blank lines inserts nothing and changes
  nothing (`ok: 0 files`).
