// The UX pack: questions on hunks of interface files ([review] ux_globs) and text dictionaries
// ([review] i18n_globs). Each question has a deterministic trigger here, so a request is sent only
// for hunks that hold what the question is about. Wording is fixed: it is what ux_threshold means.
import type { Opts } from "./config.ts";
import { addedOf, firstLine, type Hit, type HitContext, type Hunk, lineHit, noul, type PackQ, packQ } from "./jev-hunks.ts";
import { isTestFile } from "./lang.ts";
import { lines, run } from "./util.ts";

type UxContext = HitContext;

// ---- triggers

const PALETTE = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const COLOR = new RegExp(
  `#[0-9a-fA-F]{3,8}\\b|\\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\\(|\\b(?:bg|text|border|ring|fill|stroke|from|via|to|outline|decoration|divide|accent|caret|shadow)-(?:(?:${PALETTE})-\\d{2,3}|black|white)\\b|\\b(?:color|fill|stroke|background)\\s*[=:]\\s*["'](?:${PALETTE}|black|white)["']`,
);
// Visible text in markup: between tags (not after => or a spaced comparison), in a text prop, or a
// literal with a non-ASCII letter (interface text in a language other than English).
const JSX_TEXT = /(?<![\s=])>\s*([^<>{}]*\p{L}{2,}[^<>{}]*)</u;
const TEXT_PROP = /\b(?:placeholder|title|label|description|aria-label|alt)=["'][^"']*\p{L}/u;
const NON_ASCII_TEXT = /["'`][^"'`]*[^\P{L}a-zA-Z][^"'`]*["'`]/u;
const DICT_TEXT = /["'`][^"'`]*\p{L}{2,}[^"'`]*["'`]/u;
const QUOTED = /(["'`])((?:(?!\1).)*)\1/gu;
const PROSE_WORD = /^[\p{L}][\p{L}'ʻʼ’]*[,.!?:;»"]*$/u;
const PLAIN_WORDS = 10;
const METRIC = /<Card\b|<CardTitle\b|type-metric|<(?:Stat|Kpi|Metric)\w*/;
const DASHBOARD = /dashboard|analytics|metrics|stats/i;
const NARROW = /(?<![\w:-])grid-cols-(?:[2-9]|1[0-2])\b|<Table\b|\b(?:min-)?w-\[\d{3,}px\]/;
const RAW_ERROR = /\b(?:err|error|e|ex|reason)\.(?:message|code|status|statusText)\b|String\((?:err|error|e)\)|JSON\.stringify\((?:err|error|e)\b/;
const EMPTY = /\.length\s*===?\s*0\b|!\w+(?:\?\.)?\.length\b|\bEmpty(?:State|Screen)?\b|[Nn]othing found|[Nn]o results|[Nn]othing here|[Nn]othing yet/;
const CONTROL = /<(?:Button|TabsTrigger|SelectItem|DropdownMenuItem|ToggleGroupItem|SidebarMenuButton|MenubarItem|CommandItem)\b[^>]*>\s*([^<]*\S)\s*<\//;
const EXPORTED = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class)\s+([A-Z]\w*)/;
// An import, a re-export, or a bare name inside a multi-line import list: naming is not rendering.
const IMPORT_ONLY = /^\s*(?:import\b|export\s+(?:type\s+)?(?:\*|\{)[^;]*\bfrom\b|\w+,?\s*$)/;

const uiText = (c: UxContext, file: string) => (c.kind(file, "i18n") ? DICT_TEXT : new RegExp(`${JSX_TEXT.source}|${TEXT_PROP.source}|${NON_ASCII_TEXT.source}`, "u"));

function textsOf(line: string) {
  const quoted = [...line.matchAll(QUOTED)].map((m) => m[2]);
  const jsx = JSX_TEXT.exec(line)?.[1];
  return jsx ? [...quoted, jsx] : quoted;
}

const proseWords = (s: string) => s.split(/\s+/).filter((w) => PROSE_WORD.test(w)).length;

function longTextHit(h: Hunk) {
  const line = addedOf(h).find((x) => textsOf(x.text).some((t) => proseWords(t) >= PLAIN_WORDS));
  return line ? { at: line.at } : null;
}

function metricHit(h: Hunk) {
  return DASHBOARD.test(h.file) || DASHBOARD.test(h.text) ? firstLine(h, METRIC) : null;
}

// Other lines of the same file that carry the added control's label.
function duplicateHit(h: Hunk, c: UxContext): Hit | null {
  const fileLines = c.text(h.file).split("\n");
  for (const a of addedOf(h)) {
    const label = CONTROL.exec(a.text)?.[1];
    if (!label || label.length < 2) continue;
    const own = Number(a.at.slice(1));
    const same = fileLines.flatMap((l, i) => (i + 1 !== own && l.includes(label) ? [`${h.file}:${i + 1}: ${l.trim()}`] : []));
    if (same.length) return { at: a.at, state: { same_label_lines: same.slice(0, 10) } };
  }
  return null;
}

// A new exported component that no other non-test file uses beyond importing it.
function wiringHit(h: Hunk, c: UxContext): Hit | null {
  for (const a of addedOf(h)) {
    const name = EXPORTED.exec(a.text)?.[1];
    if (!name) continue;
    const refs = references(c.o, name, h.file);
    if (!refs.some((r) => r.used)) return { at: a.at, state: { references: refs.slice(0, 20).map((r) => r.line) } };
  }
  return null;
}

function references(o: Opts, name: string, file: string) {
  const out = run("git", ["grep", "-n", "-w", "-I", "--untracked", "-e", name], o.repo).out;
  return lines(out).flatMap((l) => {
    const m = /^(.+?):(\d+):(.*)$/.exec(l);
    if (!m || m[1] === file) return [];
    return [{ line: `${m[1]}:${m[2]}: ${m[3].trim()}`, used: !isTestFile(o.langs, m[1]) && !IMPORT_ONLY.test(m[3]) }];
  });
}

// ---- questions

const ux = packQ("ux_threshold");

// on: ux = [review] ux_globs, i18n = i18n_globs, both = either.
export const UX_QUESTIONS: PackQ[] = [
  ux({ id: "hardcoded_color", label: "a color is a literal, not a design token", on: "ux", hit: lineHit(COLOR) }, noul(
    "Does code added in `source_hunk` set a color with a literal value (hex, rgb, hsl, oklch, a named color or a fixed palette class such as bg-blue-500) instead of a design-system token?",
    "An added style, class or prop sets a color with a literal value or a fixed palette class.",
    "Colors come from design tokens or semantic classes such as bg-primary, text-muted-foreground or var(--token), or the matched text is not a color.",
  )),
  ux({ id: "untranslated_text", label: "a dictionary value is not in the dictionary's language", on: "i18n", hit: lineHit(DICT_TEXT) }, noul(
    "Is a text value added in `source_hunk`, a translation dictionary for the language its `file` name gives, written in a different language instead of being translated?",
    "At least one added value is text in another language than the dictionary's, left untranslated or copied from another dictionary.",
    "Every added value is in the dictionary's language, or is a brand name, a number, a placeholder or code that stays the same in every language.",
  )),
  ux({ id: "jargon_in_ui", label: "user-facing text uses a developer term", on: "both", hit: (h, c) => firstLine(h, uiText(c, h.file)) }, noul(
    "Does user-facing text added in `source_hunk` contain a developer term that a user without technical training would not understand?",
    "Visible text names a code identifier, a dictionary key, an internal ID, an environment variable, a command, a file path, JSON, an API, OAuth or a similar technical word.",
    "Visible text uses everyday words of the user's domain, or technical words appear only in code that the user does not see.",
  )),
  ux({ id: "text_not_plain", label: "user-facing text is long, passive or bureaucratic", on: "both", hit: longTextHit }, noul(
    "Is a sentence of user-facing text added in `source_hunk` hard to read for a non-technical user because it is long, passive or bureaucratic?",
    "A visible sentence has more than 20 words, is in the passive voice, or uses bureaucratic phrasing where a short active sentence would do.",
    "Every visible sentence states one fact in 20 words or fewer, in the active voice and plain words.",
  )),
  ux({ id: "feature_not_wired", label: "a new component is not wired to a route, menu or render", on: "ux", hit: wiringHit, extra: ["references"] }, noul(
    "Is the component or screen exported in `source_hunk` unreachable for the user, judging by `references`, every other place in the repository that names it?",
    "`references` shows no render, route or navigation entry for the export outside tests: it is only imported, re-exported or tested, or not named at all.",
    "`references` shows the export rendered, routed or linked from code that the user reaches.",
  )),
  ux({ id: "duplicate_control", label: "a control repeats one that is already on this screen", on: "ux", hit: duplicateHit, extra: ["same_label_lines"] }, noul(
    "Does the control added in `source_hunk` repeat a control of the same screen listed in `same_label_lines`, so the same action or object is reached from two places?",
    "The added control does the same action or edits the same object as a control in `same_label_lines`.",
    "The controls with the same label do different things, belong to different screens or states, or the added control replaces the old one.",
  )),
  ux({ id: "metric_without_deeplink", label: "a metric does not open the data behind it", on: "ux", hit: metricHit }, noul(
    "Does a metric card added in `source_hunk` show a number without a link or click that opens the data behind that number, already filtered to it?",
    "An added card shows a count, sum or rate and has no link or click handler, or its link opens a general list without the metric's filter, sort or period.",
    "Every added metric links to the data behind it with the matching filter, sort or period, or the hunk adds no metric.",
  )),
  ux({ id: "mobile_not_handled", label: "the layout has no variant for a narrow screen", on: "ux", hit: lineHit(NARROW) }, noul(
    "Does the layout added in `source_hunk` lack a variant for a phone screen about 390 px wide?",
    "Added multi-column grids, filter rows or tables keep fixed columns or widths, with no breakpoint classes, stacked layout, filter sheet or horizontal scroll wrapper.",
    "The added layout collapses, stacks, scrolls or moves into a sheet on narrow screens, or it is a single column.",
  )),
  ux({ id: "raw_error_shown", label: "an error is shown raw, not as a reason in plain words", on: "ux", hit: lineHit(RAW_ERROR) }, noul(
    "Does `source_hunk` show the user a raw error (an exception message, a status code or an error key) instead of the reason in plain words?",
    "Added code renders or toasts error.message, a status code, an error key or a stringified error.",
    "Errors shown to the user are mapped to plain-language texts, or the raw error goes only to a log.",
  )),
  ux({ id: "empty_state_dead_end", label: "an empty state offers no next step", on: "ux", hit: lineHit(EMPTY) }, noul(
    "Does an empty state added in `source_hunk` leave the user without a next step, such as a filter reset, a create button or a link?",
    "An added empty list, search or filter result shows only a message, with no action to reset, create or go elsewhere.",
    "The empty state offers an action, or the hunk adds no empty state.",
  )),
];
