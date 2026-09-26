# Jev: test, change, UX, agent and project notes (never block)

After the deterministic checks, `check`, `pre-commit` and the Stop adapter ask Jev (a TypeSafe
classifier). Switch it on with `[review] jev = true` and a key. Code: `scripts/lib/jev.ts` (test
hunks, providers, output), `scripts/lib/jev-source.ts` (`change_untested` and the packs), `scripts/lib/jev-ux.ts`
(the UX pack), `scripts/lib/jev-agent.ts` (the agent pack), `scripts/lib/jev-custom.ts` (project
questions), `scripts/lib/jev-spec.ts` (`spec_incomplete`), `scripts/lib/jev-hunks.ts` (hunks, the
state budget, pack helpers).

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
`["src/components/**/*.tsx"]`) and `[review] i18n_globs` (translation dictionaries, for example
`["src/i18n/*.json"]`); both are empty by default, so the pack is off. Each question has a trigger in
code, so a hunk without the matching text costs no request; the note points to the first added line
that triggered it. One threshold for the pack: `ux_threshold` (0.7, a note at or above it);
`ux_off = ["<id>", ...]` switches questions off, an unknown id is a `jev: not available` line.

| question | files | trigger (added lines) | note |
|---|---|---|---|
| `hardcoded_color` | ux | hex, `rgb(`, `hsl(`, `oklch(`, palette classes such as `bg-blue-500`, `text-white`, named colors in `color=` | a color is a literal, not a design token |
| `untranslated_text` | i18n | a string value | a dictionary value is not in the dictionary's language |
| `jargon_in_ui` | ux, i18n | text between tags, `placeholder`/`title`/`label`/`aria-label`/`alt`, a literal with a non-ASCII letter; any string in a dictionary | user-facing text uses a developer term |
| `text_not_plain` | ux, i18n | a visible string of 10 or more words | user-facing text is long, passive or bureaucratic |
| `feature_not_wired` | ux | an exported PascalCase function, const or class that no other non-test file uses beyond an import; state adds `references` (every `git grep -w` line naming it) | a new component is not wired to a route, menu or render |
| `duplicate_control` | ux | a `Button`, `TabsTrigger`, `SelectItem`, `DropdownMenuItem`, `ToggleGroupItem`, `SidebarMenuButton`, `MenubarItem` or `CommandItem` whose label appears elsewhere in the file; state adds `same_label_lines` | a control repeats one that is already on this screen |
| `metric_without_deeplink` | ux | `<Card`, `CardTitle`, `type-metric`, `<Stat*`/`<Kpi*`/`<Metric*` in a dashboard, analytics, metrics or stats file or hunk | a metric does not open the data behind it |
| `mobile_not_handled` | ux | an unprefixed `grid-cols-2..12`, `<Table`, a fixed `w-[NNNpx]` | the layout has no variant for a narrow screen |
| `raw_error_shown` | ux | `error.message`, `.code`, `.status`, `String(err)`, `JSON.stringify(err)` | an error is shown raw, not as a reason in plain words |
| `empty_state_dead_end` | ux | `.length === 0`, `!x.length`, `Empty`, "nothing found", "no results" | an empty state offers no next step |

## Agent pack

For codebases of AI assistants and agents. Asked only on hunks of files in `[review] agent_globs`
(code, for example `["agent/**/*.ts"]`) and `[review] agent_prompt_globs` (prompts and instructions,
for example `["agent/prompts/**/*.md"]`); both are empty by default, so the pack is off. One
threshold: `agent_threshold` (0.7); `agent_off` switches questions off.

| question | files | trigger (added lines) | note |
|---|---|---|---|
| `silent_failure` | code | `catch`, `.catch(`, `try {`, `?? null` | an error on a user-facing path is swallowed; neither the user nor the log learns the cause |
| `unbounded_turn` | code | `while (`, `for await`, `setInterval(`, `setTimeout(`, `retry`, `attempts`, `maxSteps`, `spawn` | a turn, job, retry loop or timer has no limit or no cancel path |
| `secrets_in_logs` | code | `console.*(`, `log(`, `logger.*(`, `diagnos`, `telemetry`, `JSON.stringify(` of env, headers, auth, message, text, body, prompt | a log, trace or diagnostic bundle carries a secret or the user's own content |
| `update_without_rollback` | code | any added line in a file whose path names update, upgrade, version, install, systemd or `bin/`; elsewhere `systemctl`, `launchctl`, `symlink(`, `".env"`, `node_modules`, `versions/`, `rollback`, `daemon-reload` | the update or install flow changed without a way back |
| `event_without_dedup` | code | `webhook`, `replay`, `redeliver`, `retry`, `update_id`, `message_id`, `event_id`, `delivery_id`, `onMessage`/`onUpdate`/`onEvent` | a redelivered or retried event acts twice; no idempotency key |
| `state_overwrite_instead_of_append` | code | `writeFile(`, `truncate`, `overwrite`, `fs.write(`, an open in `"w"` mode | persistent state is overwritten instead of appended or merged |
| `prompt_depends_on_environment` | prompt, code | in prompt files: a path, a file extension, `bun`/`node`/`npx`/`bash`/`python`/`uv`, `skill`, a model or vendor name; in code: `build*Prompt(`, or a `prompt`, `instructions` or `system` assigned a template literal | a prompt points the model at a path, script, skill or model the install may not have |
| `per_vendor_branch` | code, except files named `provider*`, `vendor*`, `model*` | `provider ===`, `vendor ===`, `case "<vendor>"`, `=== "<vendor>"` for common vendor names | a branch for one provider patches behaviour that every provider needs |
| `user_text_quality` | code | `send*(`, `reply*(`, `respond*(`, `notify*(`, `post*(`, `sendMessage`, `reply_markup`, `inline_keyboard` | text sent to the user shows a trace, identifier, path or command, or skips localisation |

Test files and test support (`*.render-harness.*`, `*-harness.*`, `*.stories.*`, `fixtures/`,
`__mocks__/`) never get pack questions, project questions or `change_untested`.

## Project questions

Rules of one project go into its own `.quality.toml` as `[[review.jev_questions]]` tables. Each one
is asked on changed hunks of files matching `files` (tests excluded) that add a line matching
`trigger`, in the same request as the built-in questions of that hunk; the state is `file` and
`source_hunk`.

| key | required | meaning |
|---|---|---|
| `id` | yes | snake_case, unique, not a built-in id; the note and the log use it |
| `files` | yes | globs of the files to ask about |
| `trigger` | no | a regular expression one added line must match (default: any non-blank line) |
| `instructions` | yes | the question, in English, one atomic property; read the hunk as `source_hunk` |
| `criteria` | yes | `{ true = "...", false = "..." }` |
| `note` | yes | the meaning printed after the location |
| `threshold` | no | 0.7 by default |
| `below` | no | `true` = a note when p is under the threshold (the good answer is yes) |

```toml
[[review.jev_questions]]
id = "hint_as_visible_text"
files = ["src/components/**/*.tsx"]
trigger = "<(?:HelpText|FormDescription|FieldDescription)\\b"
instructions = "Does `source_hunk` add an explanation of a field as permanent visible text next to it, instead of behind an information icon with a tooltip?"
criteria = { true = "An added description explains a control and is always visible.", false = "The explanation sits behind an information icon, or the text warns about an irreversible action or a format limit." }
note = "a field explanation is visible text, not behind an info icon"
```

A malformed entry (a missing key, a bad regex, a reused id) is one line,
`jev: not available (review.jev_questions[<n>]: <what is wrong>)`, and nothing is asked.

## Requests and output

All applicable questions of one hunk go in one request: a changed `.tsx` hunk asks `change_untested`
and its pack and project questions together. Test hunks come first, then source hunks with pack or
project questions, then the other source hunks; together there are at most `jev_max_states` (12) requests, and
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
note: jev hardcoded_color p=0.91 >= 0.7  src/components/Card.tsx:+14  a color is a literal, not a design token
note: jev silent_failure p=0.78 >= 0.7  agent/reply.ts:+31  an error on a user-facing path is swallowed; neither the user nor the log learns the cause
```

**The notes are advisory.** Every answer is written to `<main checkout>/<out_dir>/jev-log.jsonl`
(`question`, `p`, `file`, `hunk`, `sha` = HEAD at check time, for pre-commit the commit's parent,
`scope`, `model` as the answer reported it, `noted`) so the thresholds can be revisited on your own
history. `fallback_hides_required` is off.

Rules for working with Jev (docs.typesafe.ai): one atomic question per property,
in English, only the fields the question reads in the state, a 32k-token limit per state; Noul returns
one probability with no confidence.
