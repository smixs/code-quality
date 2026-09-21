# Report

`<repo>/<out_dir>/report.md` (`out_dir` is `.scratch/quality` unless `[project] out_dir` says otherwise, full gate) or `check.md` (`check` and the hooks), next to a `.json`
with every finding and tamper/cov note. The `Bypasses` section keeps the accepted bypasses with their
source and reason. The other sections: Gate (per rule), Escalate, Drift (unchanged functions worse
than the baseline, not gated), Summary, Worklist (CRAP × commits in 12 months, `tests` / `split` /
`tests+split`), Hotspots, Top 30 CRAP, Dependencies, Dead code. The folder also holds `lcov.info`,
`lcov.meta.json`, `tests.log`, `pre-push.log`, the temporary configs `depcruise.cjs`,
`knip.config.json` and the `jscpd/` report.
