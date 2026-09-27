# Station card

One per project. It lives in a project document (for example `docs/acceptance-station.md`) or in `.scratch/work/station.md`; the root `AGENTS.md` or `CLAUDE.md` only links to it. Keep it short, about 40 lines, but complete commands and permissions matter more than the line count. The runbook links to the card and never copies its commands.

## Sections

1. **Repository.** The main branch, where worktrees live, how dependencies appear in a worktree (a symlink, a copy, an install) and what is forbidden there.
2. **Commands.** Touched tests. All tests. Typecheck. Lint. Build. Mutant. The landing run.
3. **Touched tests.** How they are chosen: by default the plugin's selection by name and by import. A project exception is written here, for example "a change under `apps/admin` runs the whole `apps/admin` suite, because render harnesses hide the import".
4. **Gate.** One runnable gate command for the change and its expected output. A fallback when the code-quality plugin is absent: touched tests with their exit code, a `git diff` of test files for deleted and weakened assertions, a secret scan, typecheck and lint. Neither one nor the other means acceptance is BLOCKED.
5. **Live check** (shaped like the pstack verify skill), for two surfaces: "before merge" (the candidate built from head: a local run, a preview, a staging stand, a branch on a server) and "after release" (production):
   - Launch: how to start it or where to deploy, and the sign that it is ready.
   - Doctor: one check that this instance is worth driving.
   - Scenario: how to walk the user path, with concrete commands or buttons.
   - Evidence: what to capture and where to put it.
   - Cleanup: what to tear down; evidence stays.
   - Rollback.
   - For a tool other projects use, the before-merge check runs on a real consumer repo, not on a sample (27.09: 1.3.0 passed a harness sample and missed 73 render tests of the sotish admin).
6. **Test and landing environment.** A test environment without production secrets; personal and production `.env` files are never copied into a worktree.
7. **Machine limits.** Executors, heavy runs, browsers. The load threshold for a heavy run. Read-only reviewers do not count against the limit; gate runs and mutants queue.
8. **Known red tests outside the task.** Test name, cause, since when. So nobody mistakes them for a regression.
9. **What needs the owner's word.** Commit, merge, push, deploy, release, version, messages to people.

## Checking the card

The lead walks the card once: the gate, launch, doctor, one scenario, evidence, cleanup. A card nobody ran is a draft, and no release acceptance runs on it.
