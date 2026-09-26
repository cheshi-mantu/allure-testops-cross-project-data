import type { ReactNode } from "react";
import type { TreeRow } from "./tree";

const INDENT = 24;

/** Depth of a row in the tree, from its key: "/a:1/b:2/i:3" is at depth 2. */
const depth = (key: string) => key.split("/").length - 2;

/**
 * First cell of a tree table with its own indent and expand toggle, so that
 * wrapped content stays aligned instead of flowing under the indent. Use with
 * `expandable={{ indentSize: 0, expandIcon: () => null }}`.
 */
export function TreeCell<T>({
  row,
  expanded,
  onToggle,
  children,
}: {
  row: TreeRow<T>;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", paddingLeft: depth(row.key) * INDENT }}>
      <span style={{ flex: "none", width: INDENT, paddingTop: 2 }}>
        {row.kind === "group" && (
          <button
            type="button"
            aria-label={expanded ? "Collapse row" : "Expand row"}
            className={`ant-table-row-expand-icon ant-table-row-expand-icon-${expanded ? "expanded" : "collapsed"}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          />
        )}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>{children}</div>
    </div>
  );
}
