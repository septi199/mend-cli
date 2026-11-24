# mend-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/septi199/mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/septi199/mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it applies unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON editor tool calls to a tree of text files, changing every file or none. Old lines are found at the first of three matching tiers (exact, trailing-whitespace-normalised, indentation-tolerant), so edits land even when the model drifted the whitespace or got the line numbers wrong.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file, or `-`/absent for stdin. `--format` is `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, which detects the format). `--check` reports what would change without writing anything; `--strict` matches lines exactly. See `SPEC.md` in the competition kit for the full contract; the implementation is `main.ts` (Node 22, standard library only, deterministic).

---

<sub>Entered on [make.fun](https://make.fun/?ref=xaqxgz17&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
