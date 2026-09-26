import type { TestCaseHistory } from "./api";

const DAY = 86_400_000;

export interface TrendSeries {
  /** Local dates, YYYY-MM-DD. */
  days: string[];
  automated: number[];
  manual: number[];
  /** Automated share of test cases with a known state, 0..100; null when none. */
  percent: (number | null)[];
}

const startOfDay = (ts: number) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const isoDay = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

type State = "auto" | "manual" | "none";

/**
 * Daily counts of automated and manual test cases, as of the end of each day
 * from `from` to today. One pass over the events: every change of a test
 * case's state adds -1 to its old bucket and +1 to its new one from that day
 * on, and a running sum turns the changes into counts.
 */
export function buildTrend(testCases: TestCaseHistory[], from: number): TrendSeries {
  const first = startOfDay(from);
  const last = startOfDay(Date.now());
  const length = Math.round((last - first) / DAY) + 1;
  const dAuto = new Array<number>(length + 1).fill(0);
  const dManual = new Array<number>(length + 1).fill(0);
  const index = (ts: number) => Math.max(0, Math.floor((ts - first) / DAY));

  const apply = (from: State, to: State, ts: number) => {
    if (from === to) return;
    const i = index(ts);
    if (i >= length) return;
    if (from === "auto") dAuto[i]--;
    if (from === "manual") dManual[i]--;
    if (to === "auto") dAuto[i]++;
    if (to === "manual") dManual[i]++;
  };

  for (const tc of testCases) {
    let automated = tc.initial;
    let deleted = false;
    let state: State = "none";
    const stateNow = (): State => (deleted || automated === null ? "none" : automated ? "auto" : "manual");
    const begin = tc.created ?? -Infinity;
    // A test case counts from its creation, with its first known state.
    if (begin !== -Infinity) {
      state = "none";
      const next = stateNow();
      apply(state, next, begin);
      state = next;
    } else {
      state = stateNow();
      apply("none", state, first);
    }
    for (const [ts, kind, value] of tc.events) {
      if (kind === "a") automated = value;
      else deleted = value === 1;
      const next = ts < begin ? state : stateNow();
      apply(state, next, ts);
      state = next;
    }
  }

  const series: TrendSeries = { days: [], automated: [], manual: [], percent: [] };
  let auto = 0;
  let manual = 0;
  for (let i = 0; i < length; i++) {
    auto += dAuto[i];
    manual += dManual[i];
    series.days.push(isoDay(first + i * DAY + DAY / 2));
    series.automated.push(auto);
    series.manual.push(manual);
    series.percent.push(auto + manual > 0 ? Math.round((auto / (auto + manual)) * 1000) / 10 : null);
  }
  return series;
}

/** Earliest creation date among the test cases, for the "all time" range. */
export function earliest(testCases: TestCaseHistory[]): number {
  let min = Date.now();
  for (const tc of testCases) if (tc.created !== null && tc.created < min) min = tc.created;
  return min;
}
