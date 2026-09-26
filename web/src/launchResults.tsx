import { Tag, Tooltip, Typography } from "antd";
import type { Launch, LaunchStatistic } from "./api";

export type LaunchFlag = "notPassed" | "inProgress" | "unresolved" | "defects" | "muted";

export const LAUNCH_FLAGS: { value: LaunchFlag; label: string; hint: string }[] = [
  { value: "notPassed", label: "Not passed", hint: "Failed, broken, skipped or unknown results" },
  { value: "inProgress", label: "In progress", hint: "Results that are not finished yet" },
  { value: "unresolved", label: "Unresolved", hint: "Unresolved results" },
  { value: "defects", label: "Defects", hint: "New or known defects" },
  { value: "muted", label: "Muted", hint: "Muted results" },
];

const notPassed = (s: LaunchStatistic) => s.failed + s.broken + s.skipped + s.unknown;

/** Unknown counts never satisfy a flag. */
export function hasFlag(l: Launch, flag: LaunchFlag): boolean {
  switch (flag) {
    case "notPassed":
      return l.statistic !== null && notPassed(l.statistic) > 0;
    case "inProgress":
      return l.statistic !== null && l.statistic.inProgress > 0;
    case "unresolved":
      return (l.unresolved ?? 0) > 0;
    case "defects":
      return (l.newDefects ?? 0) + (l.knownDefects ?? 0) > 0;
    case "muted":
      return (l.muted ?? 0) > 0;
  }
}

const STATUSES: { key: keyof LaunchStatistic; label: string; color: string }[] = [
  { key: "passed", label: "passed", color: "green" },
  { key: "failed", label: "failed", color: "red" },
  { key: "broken", label: "broken", color: "orange" },
  { key: "skipped", label: "skipped", color: "default" },
  { key: "unknown", label: "unknown", color: "purple" },
  { key: "inProgress", label: "in progress", color: "blue" },
];

export function StatusCounts({ statistic }: { statistic: LaunchStatistic | null }) {
  if (statistic === null) {
    return (
      <Tooltip title="Result counts could not be loaded">
        <Typography.Text type="secondary">?</Typography.Text>
      </Tooltip>
    );
  }
  const shown = STATUSES.filter((s) => statistic[s.key] > 0);
  if (shown.length === 0) return <Typography.Text type="secondary">no results</Typography.Text>;
  return (
    <>
      {shown.map((s) => (
        <Tooltip key={s.key} title={s.label}>
          <Tag color={s.color} style={{ marginInlineEnd: 4 }}>
            {statistic[s.key]}
          </Tag>
        </Tooltip>
      ))}
    </>
  );
}

export function StatusLegend() {
  return (
    <>
      {STATUSES.map((s) => (
        <Tag key={s.key} color={s.color} style={{ marginInlineEnd: 4 }}>
          {s.label}
        </Tag>
      ))}
    </>
  );
}

export const countOrUnknown = (n: number | null) => (n === null ? "?" : n);
