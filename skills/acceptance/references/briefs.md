# Briefs

One brief per role. Fill in `<…>`, change nothing else. Every role writes evidence into `.scratch/work/<task>/` of the main checkout, never inside a worktree.

## Executor ticket

```text
Task: <one line>. Spec: <path>, version <N>; the ticket is only a frame, the spec wins.
First copy the "Finish line" and "Failure table" sections verbatim into TASK.md as checkboxes.
Worktree: <path>, branch <name> from <base SHA> (<origin/main or an integration SHA with its dependencies>). Dependencies: <per the card>.
Build it all in one pass; checks at the end: touched tests, typecheck, lint, the gate on the change (<command from the card>).
Not allowed: weakening or deleting tests to get green; --no-verify; touching <do-not-touch>; inventing a mechanism the spec lacks (then BLOCKED with a question); heavy runs in parallel with someone else's.
Stuck for more than an hour on one spot: BLOCKED with what you tried. Do not reinterpret the goal.
After handing in, do not touch the candidate until the verdict.
Commits: <project rules>.
Report in <.scratch/work/<task>/report.md>: for each finish-line row the command, exit code, one-line result, log path; a "not verified" list.
Last command: <how to tell the lead, for example a message to the lead's session: "<TASK> DONE|BLOCKED: <SHA> <three lines>">
```

## Reviewer brief (lanes B and C)

```text
You are a reviewer. Do not change code. checkout, stash, reset, clean and restore are forbidden.
Task: <one line>. Spec: <path>, version <N>, the "Finish line" and "Failure table" sections.
Your worktree: <path>, detached at <head>. Range: git diff <base>..<head>. First check that HEAD = <head> and git status is empty.
Your half: <B | C>. Cover it fully. Report a proven blocker outside your half, but do not repeat the other half's checklist.

B. Correctness:
- Every failure-table row against the code. Boundary inputs. An error swallowed or loud. Retry, a crash midway, a second writer, the order of writes.
- The root, not the symptom: a guard that hides a broken invariant; a retry that hides a broken contract; a fix in the wrong module.
- Tests: do they call the code the way a user does and compare with a literal? Would a test pass if every imported function returned undefined? Is there a test for every failure-table row? Were old tests weakened?
- Security: user input reaching a dangerous sink, secrets in logs, time-of-check versus time-of-use.

C. Consumers and simplicity:
- Who else calls what changed: dynamic calls, CLIs, background jobs, response formats. What breaks outside the diff.
- Contract and data compatibility: old files and records on disk, migrations, rollback to the previous version.
- A needless mechanism, a second path to the same thing, configuration for cases that do not exist, dead code. Three duplicated lines beat a premature abstraction.

List EVERY finding you can prove, not only the first. Format for each:
[blocker|high|medium|low] <file:line or "evidence gap"> — the broken contract in one sentence. Consequence: … Proof: a scenario "input or state → wrong result", or which guarantee cannot be confirmed and which command, artifact or environment is missing. Fix: …
Then a "Checked and clean" list: what you looked at and why it is fine. No taste without a shown defect.
Result: finding counts by level. Write to <.scratch/work/<task>/review-<b|c>-r<k>.md>.
```

## Blind QA brief (lane D)

```text
You are the tester, not the author. Your throwaway worktree: <path>, detached at <head>. Do not touch other worktrees.
Phase 1, before the diff. Read the spec (version <N>: finish line, failure table) and the public interface. Write the scenarios: one, the strongest, per finish-line row and per failure-table row, plus garbage input, a repeat, a cut-off. At most 30 in total; do not multiply variants of one row. Put them as the first section of <qa.md> with the time written, before reading the diff. Do not edit that section later.
Phase 2. Read the diff <base>..<head>. Run the scenarios on the real code and the real process. A controlled double is allowed only at an external boundary the task does not implement: the network, an external API, a model. Never replace the module under test, its storage or its decision code. Each scenario: command, exit code, result, log path. Phase 2 has one hour; what did not fit is listed as not checked, with the reason.
Mutants: one at the consumer boundary that must go red; two or three for money, access, data, migrations and side effects. Use the plugin's mutant command; without it, by hand per "Mutants" in references/techniques.md. A green mutant is a test defect unless it is equivalent.
Weakened tests: git diff <base> <head> over test files. Removed assertions, skips, a mock of the module under test.
Verdict: PASS, REPAIR_REQUIRED or BLOCKED. REPAIR_REQUIRED means "not ready to land". A defect: level, file:line, a one-command repro, expected versus actual. What you could not check goes in its own list. Write to <.scratch/work/<task>/qa-r<k>.md>.
```

## Repair brief (same executor session, after the verdict)

```text
Round 2. Fix every item in one pass:
1. <finding: file:line or gap, scenario, expectation>
For each behavior item: first a red test on every site with this defect, then the fix.
No design change. If an item needs a new mechanism (a state file, a protocol, a snapshot, a second runner), do not build it: BLOCKED with a proposal.
Checks: touched tests, typecheck, lint, the gate. Report in the same format, with the new SHA.
```
