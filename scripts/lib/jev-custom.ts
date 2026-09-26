// Project questions: [[review.jev_questions]] tables in .quality.toml. Each one is asked on changed
// hunks of files matching its `files` globs (tests excluded) whose added lines match its `trigger`
// regex, and shares the hunk's request with the built-in questions. A malformed entry is one
// "jev: not available" line naming it, never a crash and never a change of the exit code.
import { globMatch } from "./util.ts";
import { lineHit, type PackQ, type Review } from "./jev-hunks.ts";

type Raw = Record<string, unknown>;
export type Custom = { qs: PackQ[]; files: Record<string, string[]> };

const ID = /^[a-z][a-z0-9_]*$/;
const DEFAULT_THRESHOLD = 0.7;

const text = (raw: Raw, key: string, where: string) => {
  const value = raw[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where}: ${key} must be a non-empty string`);
  return value.trim();
};

function globsOf(raw: Raw, where: string) {
  const files = raw.files;
  if (!Array.isArray(files) || !files.length || files.some((g) => typeof g !== "string")) throw new Error(`${where}: files must be a non-empty list of globs`);
  return files as string[];
}

function triggerOf(raw: Raw, where: string) {
  if (raw.trigger === undefined) return /\S/;
  try {
    return new RegExp(text(raw, "trigger", where), "u");
  } catch (e) {
    throw new Error(`${where}: trigger is not a regular expression (${(e as Error).message})`);
  }
}

function limitOf(raw: Raw, where: string) {
  const t = raw.threshold ?? DEFAULT_THRESHOLD;
  if (typeof t !== "number" || t < 0 || t > 1) throw new Error(`${where}: threshold must be a number from 0 to 1`);
  return t;
}

function criteriaOf(raw: Raw, where: string) {
  const c = (raw.criteria ?? {}) as Raw;
  return { true: text(c, "true", `${where}.criteria`), false: text(c, "false", `${where}.criteria`) };
}

function questionOf(raw: Raw, where: string, taken: Set<string>): PackQ {
  const id = text(raw, "id", where);
  if (!ID.test(id) || taken.has(id)) throw new Error(`${where}: id ${id} must be snake_case and unique among all Jev questions`);
  taken.add(id);
  return {
    id,
    label: text(raw, "note", where),
    below: raw.below === true,
    fields: ["source_hunk"],
    threshold: `jev_questions.${id}`,
    limit: limitOf(raw, where),
    on: id,
    hit: lineHit(triggerOf(raw, where)),
    q: { type: "noul", instructions: text(raw, "instructions", where), criteria: criteriaOf(raw, where) },
  };
}

// taken: the ids of built-in questions, which a project question may not reuse.
export function customQuestions(r: Review, taken: string[]): Custom {
  const raws = Array.isArray(r.jev_questions) ? (r.jev_questions as Raw[]) : [];
  const ids = new Set(taken);
  const files: Record<string, string[]> = {};
  const qs = raws.map((raw, i) => {
    const where = `review.jev_questions[${i}]`;
    const q = questionOf(raw, where, ids);
    files[q.id] = globsOf(raw, where);
    return q;
  });
  return { qs, files };
}

export const customKind = (c: Custom, file: string, id: string) => globMatch(c.files[id] ?? [], file);
