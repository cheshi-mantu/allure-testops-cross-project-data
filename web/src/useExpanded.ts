import { useMemo, useState } from "react";
import { groupKeys, type TreeRow } from "./tree";

/** Groups start expanded; the user's collapses survive data refreshes. */
export function useExpanded<T>(rows: TreeRow<T>[]) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const all = useMemo(() => groupKeys(rows), [rows]);
  const expanded = useMemo(() => all.filter((k) => !collapsed.has(k)), [all, collapsed]);

  return {
    expanded,
    onExpand: (open: boolean, row: TreeRow<T>) =>
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (open) next.delete(row.key);
        else next.add(row.key);
        return next;
      }),
    expandAll: () => setCollapsed(new Set()),
    collapseAll: () => setCollapsed(new Set(all)),
  };
}
