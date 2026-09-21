# Jev: a classifier for test hunks

Jev is a classifier that answers atomic yes/no questions about a state with a calibrated probability. The gate uses it for questions the regexes cannot phrase. Model: `typesafe/jev-1.13-20260917`, pinned by version. Endpoint: `https://openrouter.ai/api/alpha/decisions`.

Five questions, each with its own state, threshold and switch:

| question | asked on | notes when |
|---|---|---|
| `textual_test` | every added test hunk | p >= 0.85 |
| `error_path_tested` | test hunks, only when the change adds an error path | p < 0.5 |
| `assertion_weakened` | a hunk with both removed and added lines | p >= 0.7 |
| `mock_hides_behavior` | a hunk with a mock or a local stub | p >= 0.7 |
| `property_is_tautology` | a hunk with `fc.assert`, `fc.property`, `@given` or `hypothesis` | p >= 0.7 |

## Enable

```bash
export OPENROUTER_API_KEY=...
```

```toml
[review]
jev = true
jev_model = "typesafe/jev-1.13-20260917"
jev_max_states = 12
textual_test_threshold = 0.85
error_path_tested_threshold = 0.5
assertion_weakened_threshold = 0.7
```

## Cost and contract

One request per test hunk, all applicable questions in the same request, at most `jev_max_states` hunks per change, about 5 s for the whole change. The state carries only the fields a question reads.

Jev never blocks. It adds `note: jev <question> p=<value> ...` to the report. Any failure becomes `jev: not available (<reason>)`, never a silent skip. Every answer is appended to `<main checkout>/.scratch/quality/jev-log.jsonl` with the question, the probability, the file, the hunk and the commit. That log is the input for revisiting the thresholds.

In the evaluation on two executors Jev produced one finding beyond the regexes (an `assertion_weakened` hunk at p=0.87, a real weakening). That is why `jev = false` is the default: turn it on to collect the log, not to gate.
