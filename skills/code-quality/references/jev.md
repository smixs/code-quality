# Jev: test notes (never block)

After the deterministic checks, `check`, `pre-commit` and the Stop adapter ask Jev (a TypeSafe
classifier). Switch it on with `[review] jev = true` and a key. Code: `scripts/lib/jev.ts`.

## Two ways to connect

`[review] jev_provider` decides; the default `auto` takes TypeSafe when `TYPESAFE_API_KEY` is set,
else OpenRouter when `OPENROUTER_API_KEY` is set, else it prints
`jev: not available (no TYPESAFE_API_KEY or OPENROUTER_API_KEY)` and nothing is asked.

| provider | endpoint | key | model |
|---|---|---|---|
| `typesafe` | `https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY`, created at <https://console.typesafe.ai/keys> | `jev-1.13.0` (the aliases `jev-latest` and `jev-preview` shift with every release; the thresholds were tuned on 1.13, so the pin stays) |
| `openrouter` | `https://openrouter.ai/api/alpha/decisions` | `OPENROUTER_API_KEY` | `typesafe/jev-1.13-20260917` (do not take `~typesafe/jev-latest`, the thresholds would drift) |
| `custom` | `[review] jev_url` | `[review] jev_key_env` | `[review] jev_model` - all three required |

```toml
[review]              # TypeSafe directly
jev = true
jev_provider = "typesafe"
```

```toml
[review]              # through OpenRouter
jev = true
jev_provider = "openrouter"
```

Both take the same body, `{state, model, questions}`, and answer
`{model, answers: {<id>: {"type": "noul", "noul": <p>}}, usage: {input_tokens, output_tokens}}`.
`X-Title` is sent to OpenRouter only. The `model` of the answer is what goes into the log.

```bash
curl -s https://api.typesafe.ai/v1/systemone \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"jev-1.13.0","state":{"file":"a.test.ts","added_test_code":"..."},
       "questions":{"textual_test":{"type":"noul","instructions":"...","criteria":{"true":"...","false":"..."}}}}'

curl -s https://openrouter.ai/api/alpha/decisions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" -H "Content-Type: application/json" -H "X-Title: code-quality" \
  -d '{"model":"typesafe/jev-1.13-20260917","state":{"file":"a.test.ts","added_test_code":"..."},
       "questions":{"textual_test":{"type":"noul","instructions":"...","criteria":{"true":"...","false":"..."}}}}'
```

Errors are one line and never a verdict: 401 an invalid key, 422 a malformed request, 429 backoff,
529 overloaded. When every request fails the same way the line names it once, for example
`jev: not available (openrouter 429)`.

## The questions

Each question has fixed wording, state shape and threshold:

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
- `jev: <n> of <m> hunk(s) answered, <k> note(s), <provider> <model>` - the summary, always printed;
- `jev: not available (<reason>)` - no key, HTTP status, timeout, broken answer. Not a silent skip and
  not a block: only the deterministic checks decide the exit code;
- `jev: nothing to ask (no added test hunks)`.

**The notes are advisory.** Every answer is written to `<main checkout>/<out_dir>/jev-log.jsonl`
(`question`, `p`, `file`, `hunk`, `sha` = HEAD at check time, for pre-commit the commit's parent,
`scope`, `model` as the answer reported it, `noted`) so the thresholds can be revisited on your own
history. `fallback_hides_required` is off.

Rules for working with Jev (docs.typesafe.ai): one atomic question per property,
in English, only the fields the question reads in the state, a 32k-token limit per state; Noul returns
one probability with no confidence.
