# Jev: test notes (never block)

After the deterministic checks, `check`, `pre-commit` and the Stop adapter ask Jev (TypeSafe) through
OpenRouter: `POST https://openrouter.ai/api/alpha/decisions`, the key `OPENROUTER_API_KEY` from the
environment, the model pinned by version `typesafe/jev-1.13-20260917` (a pinned slug exists on
OpenRouter; do not take the alias `~typesafe/jev-latest`, the thresholds would drift). Switch it on
with `[review] jev = true`. Code: `scripts/lib/jev.ts`. The first two questions come from pilot 2 with
its wording, state shape and threshold (the pilot report of 18.09.2026):

| question | when it is asked | state | note |
|---|---|---|---|
| `textual_test` (variant B) | every added hunk of a test file | `file`, `added_test_code` (+ hunk lines) | p ≥ 0.85: the test reads a project file and checks its text. Complements `ast/textual-test`: it also catches text checks of `.md`, `.css`, SQL |
| `error_path_tested` (variant A) | test hunks, only when the change adds `throw`, `catch`, `reject(`, an error return | `file`, `diff_hunk` (the hunk with 3 lines of context) | p < 0.5: the code added an error path and this test hunk does not exercise it |
| `assertion_weakened` | the test hunk has both removed and added lines | `file`, `test_hunk` | p ≥ 0.7: the test became easier to pass because an assertion was removed or loosened |
| `mock_hides_behavior` | the hunk holds `vi.mock`, `jest.mock`, `monkeypatch`, `@patch`, `mocker.patch` or a local stub found by `tamper/mock-added` | `file`, `test_hunk`, `changed_source_files` | p ≥ 0.7: a mock or stub bypasses the changed behaviour of the code or of a direct dependency |
| `property_is_tautology` | the hunk holds `fc.assert`, `fc.property`, `@given` or `hypothesis` | `file`, `test_hunk` | p ≥ 0.7: the property-based test restates the implementation or filters away almost every input |

All applicable questions of one hunk go in one request; there are at most `jev_max_states` (12) hunks,
5 s for the whole change. Output:

- `note: jev <question> p=<p> >=|< <threshold>  <file>:+<hunk line>  <meaning>` - a note;
- `jev: <n> of <m> hunk(s) answered, <k> note(s), <model>` - the summary, always printed;
- `jev: not available (<reason>)` - no key, HTTP error, timeout, broken answer. Not a silent skip and
  not a block: only the deterministic checks decide the exit code;
- `jev: nothing to ask (no added test hunks)`.

**The notes are provisional.** The thresholds were chosen on the pilot sample, with Opus as the
reference. They become final after the owner's blind labels (not done yet). Every answer is written to
`<main checkout>/.scratch/quality/jev-log.jsonl` (`question`, `p`, `file`, `hunk`, `sha` = HEAD at
check time, for pre-commit the commit's parent, `scope`, `noted`) so the thresholds can be revisited
after a month of use. `fallback_hides_required` is off: it failed the pilot.

### Jev: known false positives

- `assertion_weakened p=0.88`, `agent/lib/reminder-store.property.test.ts:+246`, a clean Opus branch:
  a migration property test replaced the exact `schemaVersion === 2` with a check of the allowed set
  `2 || REMINDER_SCHEMA_VERSION`. A writer may keep an old valid schema or write the current one
  whole. That widens a correct invariant instead of weakening the proof. The threshold did not change;
  the decision waits for the owner's blind labels.

Rules for working with Jev (docs.typesafe.ai, notes from the pilot): one atomic question per property,
in English, only the fields the question reads in the state, a 32k-token limit per state; Noul returns
one probability with no confidence.
