import type { Defect, DefectMatcher } from "./api";

/**
 * Which part of a matcher a regex filter looks at. "matcher" compares the
 * message and trace regex pair, the others compare a single regex.
 */
export type RegexScope = "matcher" | "message" | "trace";

// Regexes that differ only in case or surrounding spaces count as the same.
const norm = (v: string | null) => (v ?? "").trim().toLowerCase();

/** Identity of a matcher within the scope; null when the scope's regex is absent. */
export function matcherKey(m: DefectMatcher, scope: RegexScope): string | null {
  switch (scope) {
    case "message":
      return m.messageRegex ? norm(m.messageRegex) : null;
    case "trace":
      return m.traceRegex ? norm(m.traceRegex) : null;
    case "matcher":
      return m.messageRegex || m.traceRegex ? `${norm(m.messageRegex)}\u0000${norm(m.traceRegex)}` : null;
  }
}

export function matcherLabel(m: DefectMatcher, scope: RegexScope): string {
  const message = m.messageRegex ? `message ~ ${m.messageRegex}` : "";
  const trace = m.traceRegex ? `trace ~ ${m.traceRegex}` : "";
  if (scope === "message") return message;
  if (scope === "trace") return trace;
  return [message, trace].filter(Boolean).join("  AND  ");
}

function textMatches(m: DefectMatcher, scope: RegexScope, needle: string): boolean {
  const inMessage = scope !== "trace" && norm(m.messageRegex).includes(needle);
  const inTrace = scope !== "message" && norm(m.traceRegex).includes(needle);
  return inMessage || inTrace;
}

/** Keys used by open or closed defects of at least two different projects. */
export function sharedKeys(defects: Defect[], scope: RegexScope): Set<string> {
  const projects = new Map<string, Set<number>>();
  for (const d of defects) {
    for (const m of d.matchers ?? []) {
      const key = matcherKey(m, scope);
      if (key === null) continue;
      if (!projects.has(key)) projects.set(key, new Set());
      projects.get(key)!.add(d.projectId);
    }
  }
  return new Set([...projects].filter(([, p]) => p.size > 1).map(([k]) => k));
}

export interface RegexFilter {
  scope: RegexScope;
  /** Lower-cased substring of the regex text; empty means any. */
  needle: string;
  /** Keep only matchers whose key is in the set; null means no such restriction. */
  shared: Set<string> | null;
}

export const isActive = (f: RegexFilter) => f.needle !== "" || f.shared !== null;

/** Matchers of the defect that pass the filter; all of them when the filter is off. */
export function selectedMatchers(d: Defect, f: RegexFilter): DefectMatcher[] {
  const all = d.matchers ?? [];
  if (!isActive(f)) return all;
  return all.filter((m) => {
    if (f.needle && !textMatches(m, f.scope, f.needle)) return false;
    if (f.shared) {
      const key = matcherKey(m, f.scope);
      if (key === null || !f.shared.has(key)) return false;
    }
    return true;
  });
}
