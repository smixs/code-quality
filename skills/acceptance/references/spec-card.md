# Spec card

The spec is the recipe. The header carries a version number. An empty section says "n/a: reason" and stays. Words come from the project glossary.

1. **The task in one line.** What changes for the user or the consumer.
2. **Finish line.** The fewest independent observable lines "done when …", usually one to ten, each with its check: a command, a scenario, a screen, a record on disk. With more lines, first check whether the task splits; never drop lines to hit a number.
3. **Decisions.** Modules, interfaces, data formats, the order of operations. A hash, a cache or a compare-before-write gets its format in bytes. Existing seams are named and reused. One rule in one place.
4. **Failure table.** A row for every new outbound call (a model, the network, git, the file system), every durable write (a file, a database, a cache, a marker) and every operation on a lock, a session or a queue.

   | Call or write | Failure | What the user sees | What the code does | Test |
   |---|---|---|---|---|

   Pick the modes by what the boundary does. For a write or a side effect always: half done, retry after a crash, a second concurrent writer. For a read: unavailable, garbage, stale, cut off. A mode that does not apply is not written out; when in doubt, one line "n/a: why".
5. **Platform facts.** The claim, the version and the strongest available proof: `file:line` in the dependency source, an official contract with its version, or a reproducible probe. Proof weaker than the source is marked as a limitation.
6. **Tests.** The highest seam. Required scenarios, taken from the failure table. PBT with a generator and a seed for parsers, validators and invariants. Mutants at the consumer boundary that must go red.
7. **TLA+ model.** Needed when correctness depends on how two actors interleave, on lock or queue transitions, or on the order of durable writes across a crash: the invariants in words and the path to the `.tla`. Otherwise "n/a: correctness does not depend on event order".
8. **Out of scope.** Do-not-touch, what is deleted, what stays.
9. **Limits.** Time, money, machine resources.

## Spec review brief (one pass)

```text
Read the spec <path> (version <N>) and the code it points to at <base SHA>. Project canon: <glossary, ADRs, philosophy>.
Find EVERY place where:
- two developers would build it differently;
- a failure of a call or a write is not described;
- a platform fact is wrong or has no proof;
- the spec contradicts the canon;
- a mechanism is needless or duplicates an existing seam.
Every finding at once, grouped: blocker / high / medium. For each: the spec quote, why it is a problem, the exact text fix.
Change nothing. Result: READY or NOT READY. Write to <file>.
```

Reviewer effort for a spec: medium. The second pass after blocker fixes reads only the changed paragraphs and the sections that depend on them.
