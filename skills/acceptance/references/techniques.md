# Techniques

The process is in SKILL.md; this file holds only the how.

## PBT

- Where: parsers, validators, resolvers, normalizers, codecs, state predicates. Not for mappings, configs or I/O wrappers.
- Property catalog: round trip; comparison with a simple independent model; boundaries; an invariant after an operation; multi-step flows through `fc.commands` or `fc.modelRun` (Python: `RuleBasedStateMachine`).
- "Does not crash on garbage" means invalid input gets the designed rejection, not a silent success.
- A failure prints its seed, the seed reproduces it. A counterexample is kept as a regression test with its seed.
- A property that restates the implementation or filters out almost every input does not count.

## Mutants

- One at the consumer boundary: a call from a shell, an agent or a child process, a send, a write of a fact. For money, auth, someone else's data, side effects and migrations, two or three from the contract-violation catalog: a skipped auth check, a foreign tenant, a repeated side effect, a wrong error type, a non-atomic write. The landing run repeats one QA mutant on the new SHA with its tests only.
- The verifier picks the mutant after the executor's tests, never the executor.
- Tool: `bun <plugin-root>/scripts/quality.ts mutant --repo <worktree> --file <path> --find '<exact text>' --replace '<text>'` (exact replace, run, restore from a copy, a proof that the file is clean).
- By hand, without the command, and only in the QA lane's throwaway worktree: a `trap` that restores; the anchor as an exact string via `grep -F`; a copy of the file; the edit; `cmp` that the file changed; the run; restore from the copy; `git status --porcelain` before and after match. `git checkout --` and `stash` are forbidden. BSD sed has no `0,/re/`. Check the test path with `ls` before the run. An interrupted worktree is spoiled and removed; the candidate and other lanes' worktrees are never mutated.
- A green mutant does not prove a defect by itself: first check equivalence and reachability. An equivalent mutant is recorded without an artificial test.
- A mutation caught only by reading the source with a regex does not count.
- Report: the mutant, the exact test that went red, the seed or input.

## Headless reviewers

- `codex exec` started from a script or in the background waits for stdin and hangs: always `codex exec … < /dev/null`, output with `-o <file>`.
- A reviewer in a terminal session gets the brief as a file path, not pasted text.

## Landing

- A script where each check is its own line, output goes to a file, and a failure stops the run. A pipe on a checking command (`| tail`, `| grep`) is forbidden: it hides the exit code.
- The landing run happens in a clean worktree with the card's test environment. Personal and production `.env` files are not copied.
- The head SHA is fixed at hand-in. The published ref is compared before a release. An empty ref or a different SHA blocks the release.
- One integrator builds the candidate, the next one waits. Machine limit by default: two executors, one heavy run, one browser.
- Several small accepted branches land in one run. A red run is split.
- Before rerunning a failed run, read the whole log of the step, not the tail.
- A known flaky test is rerun alone, only when it is the single red test.
- "Regression" only after reproducing it on both SHAs in one environment. Until then: "the test is red for me, cause not found".

## Deploy

- A green landing run is a technical acceptance. Publishing and deploying need the task's permissions.
- A release without the agreed live check is not accepted. A local task does not turn into a release.
- After a frontend deploy, check the cache.
- A UI diff is grepped for hex, oklch, rgb, arbitrary values and new color tokens; a match means "not accepted".
