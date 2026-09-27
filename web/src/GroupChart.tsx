import { useEffect, useMemo, useRef, useState } from "react";
import { Breadcrumb } from "antd";
import * as echarts from "echarts/core";
import { SunburstChart, TreemapChart } from "echarts/charts";
import { TitleComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { TreeRow } from "./tree";

echarts.use([SunburstChart, TreemapChart, TitleComponent, TooltipComponent, CanvasRenderer]);

export type ChartKind = "sunburst" | "treemap";
export type ChartColor = "automation" | "groups";

interface Node {
  /** Key of the group row, unique in the tree. */
  key: string;
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
        key: r.key,
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

/** Nodes from the top down to the one with `key`; empty when there is none. */
function pathTo(nodes: Node[], key: string): Node[] {
  for (const n of nodes) {
    if (n.key === key) return [n];
    const below = pathTo(n.children ?? [], key);
    if (below.length > 0) return [n, ...below];
  }
  return [];
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

  // Zooming is done here rather than by the chart, so the centre and the
  // path always describe the group in focus.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const path = useMemo(() => (focusKey ? pathTo(data, focusKey) : []), [data, focusKey]);
  const focus = path.length > 0 ? path[path.length - 1] : null;
  const shown = focus ? (focus.children ?? []) : data;
  const onZoom = useRef<(key: string | null) => void>(() => {});
  onZoom.current = (key) => setFocusKey(key);
  const onBack = useRef<() => void>(() => {});
  onBack.current = () => setFocusKey(path.length > 1 ? path[path.length - 2].key : null);

  useEffect(() => {
    if (!el.current) return;
    const c = echarts.init(el.current);
    chart.current = c;
    c.on("click", (p) => {
      const node = p.data as Node | null | undefined;
      if (p.componentType === "title") onBack.current();
      else if (node?.children?.length) onZoom.current(node.key);
    });
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
          title: {
            text: String(focus ? focus.count : total),
            subtext: focus ? focus.name : "test cases",
            left: "center",
            top: "middle",
            triggerEvent: focus !== null,
            textStyle: { fontSize: 22 },
            subtextStyle: { width: 120, overflow: "truncate" },
          },
          series: [
            {
              type: "sunburst",
              data: shown,
              sort: undefined,
              radius: ["18%", "96%"],
              nodeClick: false,
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
              data: shown,
              width: "100%",
              height: "100%",
              top: 0,
              roam: false,
              nodeClick: false,
              leafDepth: undefined,
              breadcrumb: { show: false },
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
  }, [shown, focus, kind, total, levels]);

  return (
    <>
      <Breadcrumb
        style={{ marginBottom: 8 }}
        items={[
          { key: "", title: <a onClick={() => setFocusKey(null)}>All test cases ({total})</a> },
          ...path.map((n, i) => ({
            key: n.key,
            title:
              i === path.length - 1 ? (
                `${n.groupTitle}: ${n.name} (${n.count})`
              ) : (
                <a onClick={() => setFocusKey(n.key)}>
                  {n.groupTitle}: {n.name} ({n.count})
                </a>
              ),
          })),
        ]}
      />
      <div ref={el} style={{ width: "100%", height: 640 }} />
    </>
  );
}
