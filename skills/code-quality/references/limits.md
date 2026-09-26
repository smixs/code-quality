# Limits

## Scanners and network

- `secret/gitleaks` checks the history `project.base..HEAD`. It does not check an uncommitted file.
  The fast `secret/*` regexes check the added lines of the working change separately.
- Without `gitleaks` installed the gate writes `secret/gitleaks: not installed (brew install gitleaks)`
  and keeps going. There is no automatic install.
- `deps/lock-age` understands text `bun.lock`, npm lockfile v2/v3, `pnpm-lock.yaml`, `uv.lock`
  and `poetry.lock`. Local, workspace, git and file dependencies have no registry date and are skipped.
- No network, or no local OSV database - not a block. `deps/lock-age` writes `not checked (offline)`,
  and OSV Scanner gives `not run: deps/audit (OSV database unavailable)`. A missing lockfile is
  different and gives `not run: deps/audit (osv-scanner: no packages found)`. An unreadable answer or
  another tool failure stays a gate error.
- `cycles`, `dead`, `form` and `audit` findings are kept in the baseline under shared keys. A new
  finding blocks, an existing one stays debt. An old baseline without the adapter lists asks for
  `--update-baseline` and does not declare the old debt new.

## Working tree, hooks, tools

- The analysis reads the working tree, so `pre-commit` refuses when a staged file also has unstaged
  edits (a partial `git add -p`): otherwise the commit would carry text that was never checked. Fix:
  stage the file whole, or `git stash push --keep-index`, commit, `git stash pop`.
- `doc/symbol` does not know external names: a field of someone else's API or library in backticks
  (`accessNotConfigured`) looks like a missing symbol.
- An anonymous function's name is the eslint label, `#n` by order in the file: a new anonymous function
  higher up shifts the numbers in Drift. Fixed with `--update-baseline` after the merge.
- jscpd runs on changed files only: a clone of changed code with an unchanged file stays invisible.
- Native `cycles`, `dead`, `form` and `audit` are not swapped for another language's tool. When an
  adapter command is not installed, the report writes the exact `not run` with the install command.
- The very first commit of a repo (no HEAD yet) is not checked by the hooks: the report fails on
  `git rev-parse HEAD`. Make the first commit with `--no-verify`, the hook works from there.
- The script's own tests: `bun test scripts/` in the plugin root (seam behaviour, Jev with a stubbed
  HTTP layer, one `check` run on a temporary repo, the hook chain with `.git/hooks` and with a husky
  path, the Stop key; the script's own mean CRAP is 3.6 at the coverage from these tests).
- Jev sees the test hunks of the language adapter's `testGlobs`; over a whole workflow there are fewer
  true positives than in a curated sample, so `textual_test` precision is lower (about 0.65).
- Flaky tests move coverage: on a changed function that can give a false CRAP > 30, rerun.
- `pre-push` runs the tests of the working tree, not of the pushed commit. It prints `touched tests: N
  by name, M by import`; importers are searched one level deep and cut off by the shared
  `hooks.pre_push_max_tests` limit. The first push of a new branch without `project.base` (no
  `origin/main`) takes the diff from the parent, the root commit from an empty tree.
- The tests and tools a hook starts run without git's repository variables (`GIT_DIR`,
  `GIT_INDEX_FILE`, `GIT_WORK_TREE` and the rest of `git rev-parse --local-env-vars`): a test's
  `git init` in a temp dir stays there. Only the gate's own git in the hooked work tree keeps them.
- husky in `prepare` (`npm install`) rewrites `core.hooksPath` to `.husky/_` on its own and the skill's
  hooks switch off: run `install-hooks` again after installing dependencies. `git lfs install` in a repo
  with our `core.hooksPath` writes its hooks into the stable code-quality home (or refuses when a file is already
  there): install LFS hooks before `install-hooks`, or with `--local` after `uninstall-hooks`.
- A trial push of an LFS repo goes into a scratch clone only (`GIT_LFS_SKIP_SMUDGE=1 git clone
  --shared`) where `origin` is removed, a remote named after a local bare repo exists and
  `lfs.url=file://<bare>`; before the push `git lfs env` must show `Endpoint=file://...`, and after it
  the log must hold no `https://`. With a bare path git-lfs takes the LFS address of `origin` and
  uploads objects to the real server (this happened on 19.09.2026 in a worktree of another repo: one
  trial png of 27 bytes went into the LFS store of GitHub, no refs were pushed; an object can be
  deleted from GitHub LFS only together with the repo). The `GIT_TRACE` log of such a push holds
  temporary tokens: do not keep it, delete it right after the check.
- Tools are installed through `npx -y pkg@version` and into `~/.cache/quality-gate` (eslint, when the
  repo has none, and sonarjs); the first run without network fails with an error instead of passing
  silently. Raise the versions by hand, comparing the report before and after.
