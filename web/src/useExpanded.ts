import { useMemo, useState } from "react";
import { groupKeys, type TreeRow } from "./tree";

/**
 * Expanded groups of a tree table. Groups start expanded, or collapsed when
 * `startExpanded` is false; the user's toggles survive data refreshes.
 */
export function useExpanded<T>(rows: TreeRow<T>[], startExpanded = true) {
  // Keys toggled away from the default state.
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [allOpen, setAllOpen] = useState(startExpanded);
  const all = useMemo(() => groupKeys(rows), [rows]);
  const expanded = useMemo(() => all.filter((k) => allOpen !== toggled.has(k)), [all, allOpen, toggled]);

  return {
    expanded,
    onExpand: (open: boolean, row: TreeRow<T>) =>
      setToggled((prev) => {
        const next = new Set(prev);
        if (open === allOpen) next.delete(row.key);
        else next.add(row.key);
        return next;
      }),
    expandAll: () => {
      setAllOpen(true);
      setToggled(new Set());
    },
    collapseAll: () => {
      setAllOpen(false);
      setToggled(new Set());
    },
  };
}
