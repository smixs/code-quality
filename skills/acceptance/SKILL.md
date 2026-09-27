---
name: acceptance
description: "Acceptance runbook for code changes in any project: pick the level by risk, write a spec with a finish line and a failure table, build in one pass, verify one frozen candidate with parallel lanes (the gate, two reviewers from different model families, a blind QA, a live check), one batched repair, two rounds, a done table built from evidence, each defect class turned into a mechanism. Use for: acceptance, accept a change, is it done, definition of done, ready to merge, verify a branch."
---

# Acceptance

## The idea

A three-star kitchen. The chef does not re-cook every plate or read the cooks' reports. The chef trusts the brigade because:

1. The recipe is fixed before service: what goes on the plate and what to do when something goes wrong.
2. The cook tastes before sending the plate to the pass.
3. No plate reaches the dining room without the pass, and the people at the pass did not cook it.
4. The chef tastes what the dish depends on.
5. A plate goes back to the station once, with every note at once. The menu does not change mid-service.
6. After service the lesson goes into the recipe and the equipment, not into shouting.

Trust comes from evidence produced by people who did not write the code, on the candidate that will land. Speed comes from parallel checks, one repair, two rounds and no paperwork for its own sake.

## What the trust rests on

- The verifier is never the author. Reviewers, QA and the live lane did not write this code. A lead does not accept their own risky change alone.
- The candidate is frozen: base SHA and head SHA are recorded before the pass and nobody touches them until the verdict.
- The gate catches test tampering: a deleted or skipped test, a weakened assertion, a mock of the module under test, a hook bypass.
- Mutants prove the tests are not idle.
- Three model families look from different sides.
- The live lane is mandatory for a user path. Without it the result is "accepted locally", not "done".
- Rejected findings reach the owner together with the fact they were rejected on.

## 0. Level

Pick the level by risk, not by line count. When unsure, go one level up. Level 3: money, auth and secrets, access to someone else's data, data and migrations, updaters, deploys, locks, queues and races, shared contracts, multi-module refactors, releases, or the owner's word.

| Level | What applies |
|---|---|
| 1 | Self-check by risk: the diff, the relevant test, typecheck and lint where present. Commit and push only if the task and the project allow it. |
| 2 | Executor with the self-check from §3, lane A. Lane B when a risk is named in the task or found while reading the code and its consumers. Lane E when a user path changes. |
| 3 | The whole runbook. |

## 1. The recipe: a spec before code

Write the spec with [references/spec-card.md](references/spec-card.md). It carries a version number and must have:

- **Finish line.** What the user or consumer will observe, as checkable lines. At the end these lines become the done table. No separate DoD file.
- **Failure table** for every new outbound call, durable write and side effect, with the failure modes that apply. In the seven-round case below, every defect sat in a failure the spec did not describe.
- **Platform facts with the strongest available proof:** `file:line` in the dependency source, an official contract with its version, or a reproducible probe. An assumption without proof does not become a decision.
- Out of scope and do-not-touch. The highest test seam. PBT for invariants. A TLA+ model by the rule in spec-card, written by the lead before code.

One reviewer pass over the spec, from another model family, asked for every finding at once (brief in spec-card). The lead applies all of it in one edit. If the edit closed a blocker or a high finding, a second pass reads only the changed paragraphs and the sections that depend on them. Then the spec version is frozen.

A late finding becomes a new spec version and goes to the executor and every lane. If it changes a mechanism, the scope or permissions, the changed sections get one reviewer pass while the executor continues with the unaffected parts.

## 2. The station: a project card

Each project has one card per [references/station-card.md](references/station-card.md): the gate command and a fallback gate, what counts as touched tests, the live check before merge and after release, machine limits, known red tests, deploy and rollback. The card lives in a project document or in `.scratch/work/station.md`; the root `AGENTS.md` or `CLAUDE.md` only links to it.

No card: the lead assembles a draft from existing commands and runs it once. Saving the card into the project needs permission to change its instructions. A card that was never run does not allow a release acceptance.

## 3. The cook: the executor in one pass

- A role from your team roster, in the environment the project uses (for example a visible terminal session). Its own worktree from the base SHA in the task: fresh origin/main by default, the exact SHA with its dependencies listed for a dependent task. The task in one message, from the ticket in [references/briefs.md](references/briefs.md).
- First the executor copies the finish line and the failure table verbatim into `TASK.md` as checkboxes. That is its "yes, chef".
- It builds everything in one pass and tastes it: touched tests, typecheck, lint, the gate on the change.
- It reports `DONE|BLOCKED: <SHA> + three lines`. Every claim carries the command, exit code, a one-line result and the path to the full log. What it did not check goes into a "not verified" list.
- It does not invent a mechanism the spec lacks: BLOCKED with a question.
- Forbidden: weakening or deleting tests to get green, `--no-verify`, leaving the scope.

## 4. The pass: one parallel check of a frozen candidate

- The lead records base SHA and head SHA. The executor does not touch the candidate until the verdict.
- Each lane works in its own worktree detached at head (`git worktree add --detach`). Mutants run only in the QA lane's throwaway worktree. Evidence goes outside the worktrees, into the task folder `.scratch/work/<task>/`.
- Before the start each lane is "required" or "n/a: reason". Lanes start in one message. Code reading runs in parallel. Heavy commands (tests, mutants, builds, browsers) queue by the card's machine limits; waiting for a resource is not a hang.
- Nothing runs hidden. Every lane except the QA subagent runs in a terminal pane the owner can watch (Herdr: `herdr pane run <pane> "<command>; herdr agent prompt <lead> '<lane>: <result>'"`); the pane reports to the lead itself as its last command. No `nohup`, `&`, background tasks or watchers for the work. Fewer shell panes than lanes: one script runs the lanes in turn in one pane; QA is the longest lane anyway.
- Unattended work starts with a resource check: every required model and tool answers a short probe, and every role has a named substitute.
- Target for the pass: one hour after resources are ready. Each lane has its own limit. A stuck lane gets one restart and one substitute from the roster. After that the state is `WAITING_RESOURCE` with the state saved, never "done".

| Lane | Role | What it does | Limit |
|---|---|---|---|
| A. Gate | the lead, with the card's command | `check --since <base> --tests` of this plugin: touched tests with coverage, CRAP and complexity of changed functions, coverage of added lines, test tampering, secrets, cycles. Without the plugin, the card's fallback gate | 15 min |
| B. Correctness | a senior from a model family other than the author's | the shared brief, fully: the failure table against the code, tests, security | 45 min |
| C. Consumers | a third model family | the shared brief, fully: consumers outside the diff, contract and data compatibility, migrations, needless complexity | 30 min |
| D. Blind QA | a fresh agent that did not write the code | scenarios from the spec before reading the diff, the real process with real failures, mutants, a check for weakened tests | 60 min |
| E. Live | per the card, the "before merge" surface | the user path on a surface built from head; evidence from a log, a screen or a stored record | per card |
| F. Model | the lead | TLC on `specs/<module>.tla` and a model mutant, when spec-card says a model applies | 15 min |

- One brief for both reviewers ([references/briefs.md](references/briefs.md)). Each covers its half fully and reports a proven blocker outside it, without repeating the other half's checklist.
- A finding counts when it names the broken contract, the consequence, and either `file:line` with a scenario "input → wrong result" or an exact evidence gap: which guarantee cannot be confirmed and which command, artifact or environment is missing.
- A level-3 result exists only after every required lane reported on the current candidate. A skipped required lane is not closed by a note in the verdict.
- The live lane may start before the gate once the candidate is frozen; its result counts only for the same head.
- No safe surface for the candidate before merge: the result is "accepted locally, release not verified", and the live check moves to §8. The old production is not a check of the candidate.

## 5. The chef tastes: the lead's verdict

While the lanes run, the lead proves the load-bearing safety fact of the change, one per independent risk class in the spec (usually one, at most three), and takes it to "ran it and saw it" (the pstack `blast-radius` skill does exactly this). An unproven fact stays a limitation and blocks the release when safety cannot be confirmed without it.

When the lanes are back, the lead writes the verdict per [references/verdict-and-done.md](references/verdict-and-done.md):

- **Fix.** The lead reproduced the finding (read the line, reran the repro) or two lanes agree. Duplicates of one cause merge. Usually five items or fewer; a confirmed finding is never dropped to keep the count.
- **Next wave.** Real but non-blocking findings, each with an owner and a date or a return event.
- **Rejected.** With a fact: a file, a version, a run. "I would have done it differently" without a shown defect is rejected.

## 6. Back to the station: one batched repair

- The repair starts after the verdict. Every fix item goes in one message into the same executor session (repair brief in briefs).
- Every behavior finding is closed by a **red test** that covers every site with the same defect. Where no test can show it, a repro.
- **No design change in a repair.** If a defect cannot be closed without a new mechanism (a state file, a protocol, a snapshot, a second runner), the candidate is BLOCKED and does not land. The mechanism becomes a new version of the task: a spec paragraph, one reviewer pass, its own pass. In the seven-round case, a snapshot mechanism added by a round-four repair brought five new findings.
- The repair check looks only at what changed. The gate always runs. QA reruns its red scenarios and the new tests. The reviewer with more findings reads the repair diff `prev..head`. The live lane reruns when the user path changed.

## 7. Two rounds

- Round 1 is the pass. Round 2 is one batched repair and a check of what changed.
- After round 2 the candidate lands if no open defect of the "must not ship" class remains. The rest goes to the next wave.
- "Must not ship": lost or corrupted data; money; secrets, auth, access to someone else's data; a broken user path; a silently wrong result.
- Such a defect blocks the release at any round count. Round 3 changes the verification method or the owner of the node, not only the model. Work continues until the defect is closed, the owner stops it, or the task is BLOCKED.
- Iterations toward a quality bar (a reference design, a measured target) before the candidate is handed in are not acceptance rounds.

## 8. Service: landing and the live check

- Before landing the lead checks the permissions for commit, merge and push separately. No permission means a local delivery.
- The landing run per the card: rebase on origin/main, typecheck, lint, the full suite **once** with a wait for a free machine, the build, the QA mutant on the new SHA with its tests only, fast-forward merge, push. A red test outside the task is named and checked on the base. A red on the test's own time limit is rerun alone on the same SHA: green alone means a false red from load, and the test's limit goes up to the common one.
- After a rebase the gate and the full suite always run on the new SHA. Reviewer and QA verdicts carry over when `git patch-id` of the change is unchanged; otherwise the changed part is checked as in §6.
- Release and deploy only on the owner's word and by the project's runbook. After the deploy the same scenario runs in production (the card's "after release" surface).
- Techniques for landing, mutants, PBT and reviewers in a pane: [references/techniques.md](references/techniques.md).

## 9. The done table and the report

- The lead fills the done table at the end from finished files: the finish-line rows, the lanes, the landing. Only PASS on the current candidate goes in. Not applicable: "n/a: reason".
- The decision trail is the round verdicts plus the executor reports. No separate decision log and no third-model audit of it. In unattended work the round verdict is updated at every lane status change and read first after a context compaction or a restart.
- Before cleanup the evidence sits in the task folder outside the worktrees. Then own worktrees and temp files are removed and own agents are stopped by the environment's normal means.
- The report to the owner: the result on the first line; what is on main and what is in production; what was not verified; the next wave; one line "what I need from you".

## 10. The lesson into structure

After delivery the lead answers one question per defect class that reached the pass: what catches it next time without a human? Pick the strongest mechanism:

1. a type that makes the wrong state fail to compile;
2. a lint or gate rule;
3. a shared helper or script;
4. a runtime check;
5. a line in the spec card or a brief, with an example of the failure.

The mechanism becomes a ticket for the project or for this plugin. Text is allowed only where judgment is needed. One rule lives in one place.

## What we do not do

Measured on two production repos in September 2026: one change took seven rounds and a day and a half; a comparable change took two rounds in one day.

| We do not | Why |
|---|---|
| Use the full gate over the whole tree as the verdict | Red on old debt (827 findings in one repo, 21 tests in the other); it says nothing about the change. Debt is measured separately. |
| Run Jev during acceptance | Only false notes in both repos. Turn it on by hand for an experiment. |
| Add a third reviewer of the same diff | Three families are already there, counting QA. |
| Review the spec one blocker per pass | Ten passes of one blocker each versus one pass with everything at once. |
| Keep a DoD file from the start or a third-model audit of a decision log | Paper. The spec's finish line and the round verdicts do the same. |
| Run the full suite every round | Once in the landing run; touched tests in rounds. |
| Repeat a green check without a new reason | Time without new information. |

## Not evidence

- A self-report by the executor or QA without the command, exit code and log.
- "The build is green" instead of a real call, a screen or a stored value.
- A lane verdict on another SHA, in a modified worktree, or against another spec version.
- At level 3, a review by one model without a second family.
- A "local" smoke instead of the card's surface; the old production instead of the candidate.
- A comment about a race instead of a model or a test.
