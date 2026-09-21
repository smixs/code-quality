# The repo's own hooks: the chain

`core.hooksPath` hides the hooks in `.git/hooks`, so every file in `hooks/` calls `hooks/_chain` at the
end: that runs the repo's hook of the same name, with the same arguments and the same stdin, and
returns its exit code. The repo's hook is looked up where git would look without the skill:

- `install-hooks` found another `core.hooksPath` (husky: `.husky/_`, `.husky`) - the path is recorded in
  `code-quality.previousHooksPath` of the local config, the chain goes there (a relative path is taken
  from the work tree root), `uninstall-hooks` puts it back into `core.hooksPath`;
- otherwise the `core.hooksPath` from `--global` or `--system` (read on every run, not remembered);
- otherwise `<git common dir>/hooks` (shared by worktrees).

In a repo where `core.hooksPath` is no longer ours (husky overwrote it) `uninstall-hooks` drops the
stale `code-quality.previousHooksPath`.

Order: `pre-commit`, `commit-msg`, `pre-push` give their verdict first, the repo's hook runs only on
green, and its red fails the operation. `pre-push` keeps the list of refs from stdin in a temporary
file and feeds it to both the gate and the repo's hook (Git LFS uploads objects right there). The
other names (`post-checkout`, `post-commit`, `post-merge`, `post-rewrite`,
`prepare-commit-msg`, `pre-rebase`, `pre-merge-commit`, `pre-auto-gc`, `applypatch-msg`,
`pre-applypatch`, `post-applypatch`) are symlinks to `_chain` and carry no check of their own. No
repo hook, or a non-executable one - exit 0. `install-hooks` prints which repo hooks joined the chain.

Verified 19.09.2026: a scratch repo with `git lfs install --local` and a png under LFS - after
`install-hooks` a push to a local bare repo calls `git-lfs pre-push`, the object lands in `lfs/objects`
of the remote; LFS also gets `post-checkout` and `post-commit`; a husky layout `.husky/_` with `h`
runs `.husky/pre-commit`, and `uninstall-hooks` restores `.husky/_`. Tests: `pipeline.test.ts`,
block `install-hooks chains the repo's own hooks` (including a `--global` `core.hooksPath`).
Repeat on 19.09.2026 in a scratch clone of another repo with `lfs.url=file://<bare>`: a commit with
complexity 12 was stopped, a clean first commit went through, `git-lfs pre-push` was called through
`hooks/pre-push`, the object landed in `lfs/objects` of the local bare repo, and the push log held no
`https://` at all.

The first commit of a repo without history is judged against an empty tree: git 2.55 does not know the
empty tree hash without the object, so the script writes it first (`git hash-object -t tree -w /dev/null`).
