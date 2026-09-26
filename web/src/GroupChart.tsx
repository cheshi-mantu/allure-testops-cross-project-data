import { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts/core";
import { SunburstChart, TreemapChart } from "echarts/charts";
import { TitleComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { TreeRow } from "./tree";

echarts.use([SunburstChart, TreemapChart, TitleComponent, TooltipComponent, CanvasRenderer]);

export type ChartKind = "sunburst" | "treemap";
export type ChartColor = "automation" | "groups";

interface Node {
  name: string;
  value: number;
  /** Test cases in the group, each counted once. */
  count: number;
  auto: number;
  manual: number;
  groupTitle: string;
  children?: Node[];
  itemStyle?: { color: string };
}

interface Item {
  automated: boolean | null;
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Red for manual, green for automated, grey when unknown. */
function shareColor(auto: number, manual: number): string {
  const known = auto + manual;
  if (known === 0) return "#bfbfbf";
  const hue = Math.round((auto / known) * 120);
  return `hsl(${hue}, 62%, 52%)`;
}

/**
 * Turns the grouped rows into chart nodes. An item with several values on a
 * level is split between their groups, so children always add up to their
 * parent; `share(item, depth)` is the item's part in its group at that depth.
 */
function toNodes<T extends Item>(rows: TreeRow<T>[], share: (item: T, depth: number) => number, color: ChartColor, depth = 0): Node[] {
  return rows.flatMap((r) => {
    if (r.kind !== "group") return [];
    let auto = 0;
    let manual = 0;
    let value = 0;
    for (const item of r.items) {
      if (item.automated === true) auto++;
      else if (item.automated === false) manual++;
      value += share(item, depth);
    }
    const children = toNodes(r.children, share, color, depth + 1);
    return [
      {
        name: r.label,
        value,
        count: r.items.length,
        auto,
        manual,
        groupTitle: r.groupTitle,
        ...(children.length > 0 ? { children } : {}),
        ...(color === "automation" ? { itemStyle: { color: shareColor(auto, manual) } } : {}),
      },
    ];
  });
}

function tooltip(n: Node): string {
  const known = n.auto + n.manual;
  const pct = known > 0 ? `${Math.round((n.auto / known) * 100)}% automated` : "automation unknown";
  const split = Math.abs(n.value - n.count) > 0.01 ? `<br/>weight on the chart: ${n.value.toFixed(1)} (shared with other groups)` : "";
  return `${escape(n.groupTitle)}: <b>${escape(n.name)}</b><br/>${n.count} test case(s): auto ${n.auto}, manual ${n.manual}<br/>${pct}${split}`;
}

export function GroupChart<T extends Item>({
  rows,
  share,
  total,
  kind,
  color,
  levels,
}: {
  rows: TreeRow<T>[];
  share: (item: T, depth: number) => number;
  total: number;
  kind: ChartKind;
  color: ChartColor;
  levels: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const data = useMemo(() => toNodes(rows, share, color), [rows, share, color]);

  useEffect(() => {
    if (!el.current) return;
    const c = echarts.init(el.current);
    chart.current = c;
    const observer = new ResizeObserver(() => c.resize());
    observer.observe(el.current);
    return () => {
      observer.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const common = {
      tooltip: { formatter: (p: { data?: Node }) => (p.data ? tooltip(p.data) : "") },
    };
    if (kind === "sunburst") {
      c.setOption(
        {
          ...common,
          title: { text: String(total), subtext: "test cases", left: "center", top: "middle", textStyle: { fontSize: 22 } },
          series: [
            {
              type: "sunburst",
              data,
              sort: undefined,
              radius: ["14%", "96%"],
              nodeClick: "rootToNode",
              emphasis: { focus: "ancestor" },
              itemStyle: { borderColor: "#fff", borderWidth: 1 },
              label: { rotate: "radial", minAngle: 8, overflow: "truncate", width: 90, fontSize: 11 },
            },
          ],
        },
        true,
      );
    } else {
      c.setOption(
        {
          ...common,
          series: [
            {
              type: "treemap",
              data,
              width: "100%",
              height: "92%",
              top: 0,
              roam: false,
              nodeClick: "zoomToNode",
              leafDepth: undefined,
              breadcrumb: { show: true, bottom: 0 },
              label: { show: true, formatter: "{b}" },
              upperLabel: { show: true, height: 22 },
              levels: Array.from({ length: Math.max(levels, 1) + 1 }, (_, i) => ({
                itemStyle: { borderColor: "#fff", borderWidth: i === 0 ? 0 : 1, gapWidth: i === 0 ? 3 : 1 },
                upperLabel: { show: i > 0 },
              })),
            },
          ],
        },
        true,
      );
    }
  }, [data, kind, total, levels]);

  return <div ref={el} style={{ width: "100%", height: 640 }} />;
}
