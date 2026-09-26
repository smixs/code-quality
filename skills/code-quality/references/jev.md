# Jev: test, change and UX notes (never block)

After the deterministic checks, `check`, `pre-commit` and the Stop adapter ask Jev (a TypeSafe
classifier). Switch it on with `[review] jev = true` and a key. Code: `scripts/lib/jev.ts` (test
hunks, providers, output), `scripts/lib/jev-source.ts` (`change_untested`), `scripts/lib/jev-ux.ts`
(the UX pack), `scripts/lib/jev-spec.ts` (`spec_incomplete`), `scripts/lib/jev-hunks.ts` (hunks and
the state budget).

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

## Test hunks

Each question has fixed wording, state shape and threshold. On added test hunks:

| question | when it is asked | state | note |
|---|---|---|---|
| `textual_test` (variant B) | every added hunk of a test file | `file`, `added_test_code` (+ hunk lines) | p ≥ 0.85: the test reads a project file and checks its text. Complements `ast/textual-test`: it also catches text checks of `.md`, `.css`, SQL |
| `error_path_tested` (variant A) | test hunks, only when the change adds `throw`, `catch`, `reject(`, an error return | `file`, `diff_hunk` (the hunk with 3 lines of context) | p < 0.5: the code added an error path and this test hunk does not exercise it |
| `assertion_weakened` | the test hunk has both removed and added lines | `file`, `test_hunk` | p ≥ 0.7: the test became easier to pass because an assertion was removed or loosened |
| `mock_hides_behavior` | the hunk holds `vi.mock`, `jest.mock`, `monkeypatch`, `@patch`, `mocker.patch` or a local stub found by `tamper/mock-added` | `file`, `test_hunk`, `changed_source_files` | p ≥ 0.7: a mock or stub bypasses the changed behaviour of the code or of a direct dependency |
| `property_is_tautology` | the hunk holds `fc.assert`, `fc.property`, `@given` or `hypothesis` | `file`, `test_hunk` | p ≥ 0.7: the property-based test restates the implementation or filters away almost every input |

## Changed source hunks and the spec

| question | when it is asked | state | note |
|---|---|---|---|
| `change_untested` | every changed hunk of a source file (an adapter's language, not a test, not in `i18n_globs`) that changes behaviour: hunks with only imports, types, interfaces, comments or deletions are skipped | `file`, `source_hunk` (the hunk with 3 lines of context), `test_hunks` (the added or changed test hunks of the diff, tests of the same module first, cut to the shared budget; `[]` when the diff has none) | p < 0.5: the changed behaviour has no test in this diff |
| `spec_incomplete` | once per change, when `[review] spec` (a path in the repo) or else `$QG_SPEC` names the task spec | `spec` (the file's text, cut to 8k tokens), `diff_summary` (`<file> +<added> -<removed>` per changed file), `diff` (the diff with 3 lines of context, source files first, tests last, cut to what is left of the budget) | p ≥ 0.7: the spec is not fully implemented |

Neither `[review] spec` nor `$QG_SPEC`: `jev: spec not set ([review] spec or QG_SPEC)` and no spec
request. A path that cannot be read: `jev: spec not readable (<path>)`. A spec over 8k tokens is cut at
the tail; the note ends with `(spec cut to its first 8k tokens)`, and a verdict under the threshold
prints `jev: spec_incomplete p=<p>, spec cut to its first 8k tokens`. The documented Noul answer is a
probability only; if a provider adds a `reason` or `explanation` text, it follows the note's meaning
after a colon. `--all` asks neither question: there is no change to hold a test or a spec against.

## UX pack

Asked only on hunks of files in `[review] ux_globs` (interface code, for example
`["apps/admin/**/*.tsx", "apps/webapp/**/*.tsx"]`) and `[review] i18n_globs` (text dictionaries, for
example `["apps/*/src/i18n/dictionaries/*.ts"]`); both are empty by default, so the pack is off. Test
files and test support (`*.render-harness.*`, `*-harness.*`, `*.stories.*`, `fixtures/`, `__mocks__/`)
never get these questions or `change_untested`. Each question has a trigger in code, so a hunk
without the matching text costs no request; the note points to the first added line that triggered
it. The meaning is printed in Russian, for the product owner. One threshold for all: `ux_threshold`
(0.7, a note at or above it); `ux_off = ["<id>", ...]` switches questions off, an unknown id is a
`jev: not available` line.

| question | files | trigger (added lines) | note |
|---|---|---|---|
| `hint_as_visible_text` | ux | `<HelpText`, `<FormDescription`, `<FieldDescription`, or a muted `<p>`/`<span>` in a hunk with a `Label` | an explanation shown as permanent text instead of behind an information icon (a warning about an irreversible action or a format limit is fine) |
| `hardcoded_color` | ux | hex, `rgb(`, `hsl(`, `oklch(`, palette classes such as `bg-blue-500`, `text-white`, named colors in `color=` | a literal color instead of a design-system token |
| `uz_literal_ru` | i18n, file name `uz*` | a string value | an Uzbek dictionary value left in Russian or English |
| `jargon_in_owner_ui` | ux, i18n | text between tags, `placeholder`/`title`/`label`/`aria-label`/`alt`, a Cyrillic literal; any string in a dictionary | a developer term (code identifier, key, ID, env variable, command, JSON, API, OAuth) in text for the shop owner |
| `text_not_plain` | ux, i18n | a visible string of 10 or more words | a sentence over 20 words, passive or bureaucratic |
| `feature_not_wired` | ux | an exported PascalCase function, const or class that no other non-test file uses beyond an import; state adds `references` (every `git grep -w` line naming it) | a new component with no route, menu entry or render |
| `duplicate_control` | ux | a `Button`, `TabsTrigger`, `SelectItem`, `DropdownMenuItem`, `ToggleGroupItem`, `SidebarMenuButton`, `MenubarItem` or `CommandItem` whose label appears elsewhere in the file; state adds `same_label_lines` | the same action or object reached from two places |
| `metric_without_deeplink` | ux | `<Card`, `CardTitle`, `type-metric`, `<Stat*`/`<Kpi*`/`<Metric*` in a Dashboard or Analytics file or hunk | a metric that does not open the filtered data behind it |
| `open_button_instead_of_row_click` | ux | `Открыть`, an `Open` label or `<Dialog`, in a file with a `Table` | a record opened by an Open button or a Dialog instead of a row click and a Sheet |
| `mobile_not_handled` | ux | an unprefixed `grid-cols-2..12`, `<Table`, a fixed `w-[NNNpx]` | no layout for a 390 px screen |
| `raw_error_shown` | ux | `error.message`, `.code`, `.status`, `String(err)`, `JSON.stringify(err)` | a raw error instead of a reason in plain words |
| `empty_state_dead_end` | ux | `.length === 0`, `!x.length`, `Empty`, "nothing found", "ничего не найдено", "пока нет" | an empty state without a next step |

## Requests and output

All applicable questions of one hunk go in one request: a changed `.tsx` hunk asks `change_untested`
and its UX questions together. Test hunks come first, then source hunks with UX questions, then the
other source hunks; together there are at most `jev_max_states` (12) requests, and
`spec_incomplete` is always one request more. 5 s for the whole change. Output:

- `note: jev <question> p=<p> >=|< <threshold>  <file>:+<line>  <meaning>` - a note (for the spec,
  `<file>` is the spec path);
- `jev: <n> of <m> request(s) answered, <k> note(s), <provider> <model>` - the summary, always printed;
- `jev: asked <n> of <m> hunks (jev_max_states)` - hunks beyond the limit;
- `jev: not available (<reason>)` - no key, HTTP status, timeout, broken answer. Not a silent skip and
  not a block: only the deterministic checks decide the exit code;
- `jev: nothing to ask (no test or source hunks)`.

Examples:

```text
note: jev change_untested p=0.10 < 0.5  src/sum.ts:+1  the changed behavior has no test in this diff
note: jev spec_incomplete p=0.86 >= 0.7  docs/spec.md  the spec is not fully implemented
note: jev hardcoded_color p=0.91 >= 0.7  apps/admin/src/Screen.tsx:+14  цвет задан литералом, а не токеном кита
```

**The notes are advisory.** Every answer is written to `<main checkout>/<out_dir>/jev-log.jsonl`
(`question`, `p`, `file`, `hunk`, `sha` = HEAD at check time, for pre-commit the commit's parent,
`scope`, `model` as the answer reported it, `noted`) so the thresholds can be revisited on your own
history. `fallback_hides_required` is off.

Rules for working with Jev (docs.typesafe.ai): one atomic question per property,
in English, only the fields the question reads in the state, a 32k-token limit per state; Noul returns
one probability with no confidence.
