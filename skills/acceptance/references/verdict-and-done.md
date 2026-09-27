# Round verdict and done table

## Round verdict

In unattended work this file is updated at every lane status change and read first after a context compaction or a restart.

```markdown
# Round <k> verdict: <task>, spec v<N>, base <SHA>, head <SHA>

| Lane | Status before start | Who | Result | File |
|---|---|---|---|---|
| A. Gate | required | lead | PASS / FAIL | <report> |
| B. Correctness | required | <model> | <N findings> | <file> |
| C. Consumers | required | <model> | <N findings> | <file> |
| D. Blind QA | required | <model> | PASS / REPAIR_REQUIRED / BLOCKED | <file> |
| E. Live | required / n/a: reason | <who> | <result> | <log, screen> |
| F. Model | required / n/a: correctness does not depend on event order | lead | <TLC> | <file> |

Load-bearing facts the lead proved: <fact, command, result> (one per risk class).
Waiting for resources: <lane, what, since when> or "none".

## Fix
1. <finding> — who found it; how the lead confirmed it: the line or the repro.

## Next wave
- <finding> — why it does not block; owner; date or return event.

## Rejected
- <finding> — the fact: file, version, run.
```

## Done table

Filled at the end from finished files. Only PASS on the current candidate goes in. Finish-line rows are copied from the spec verbatim.

```markdown
# Done: <task>, spec v<N>

| Row | Evidence | Result |
|---|---|---|
| <finish line 1> | <test, command, screen: path> | PASS |
| Gate on <head> | <gate report> | PASS |
| Reviewers, two families | <files>, verdict <file> | closed |
| Blind QA | <qa-r<k>.md> | PASS |
| Mutants | <log> | red N of N |
| Model | <tlc.log> or n/a: reason | |
| Live check before merge | <log, screen> or "accepted locally, release not verified" | |
| Landing | main <SHA>, <log> | |
| Live check after release | <log> or "no release" | |
| Not verified | <list> | |
| Next wave | <file> | |
```
