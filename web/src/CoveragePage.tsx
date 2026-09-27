import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, Checkbox, Empty, Input, Popover, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import * as echarts from "echarts/core";
import { BarChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { api, type CoverageData, type JiraIssue, type LinkedEntity } from "./api";
import { RefreshBar } from "./RefreshBar";
import { buildTree, itemSorter, type TreeRow } from "./tree";
import { TreeCell } from "./TreeCell";
import { resizableComponents, useColumnWidths } from "./useColumnWidths";
import { useDataset } from "./useDataset";
import { useExpanded } from "./useExpanded";

echarts.use([BarChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

type Kind = "testCases" | "launches" | "defects";
type Match = "any" | "all";

/** Which links make an issue covered: any or all of the chosen kinds; no kind chosen means any link. */
interface By {
  kinds: Kind[];
  match: Match;
}
type Coverage = "all" | "covered" | "uncovered";

const KINDS: { value: Kind; label: string }[] = [
  { value: "testCases", label: "Test cases" },
  { value: "launches", label: "Launches" },
  { value: "defects", label: "Defects" },
];

const STATUS_CATEGORIES = [
  { value: "new", label: "To do" },
  { value: "indeterminate", label: "In progress" },
  { value: "done", label: "Done" },
];
const categoryColor: Record<string, string> = { new: "default", indeterminate: "blue", done: "green" };

const byLabel = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

interface Row {
  issue: JiraIssue;
  testCases: LinkedEntity[];
  launches: LinkedEntity[];
  defects: LinkedEntity[];
}

function ruleText(by: By): string {
  const names = (by.kinds.length > 0 ? by.kinds : KINDS.map((k) => k.value)).map((k) => KINDS.find((x) => x.value === k)!.label.toLowerCase());
  if (names.length === 1) return names[0];
  return `${by.match === "all" && by.kinds.length > 0 ? "all" : "any"} of ${names.join(", ")}`;
}

function covered(r: Row, by: By): boolean {
  const kinds = by.kinds.length > 0 ? by.kinds : KINDS.map((k) => k.value);
  const has = (k: Kind) => r[k].length > 0;
  return by.match === "all" && by.kinds.length > 0 ? kinds.every(has) : kinds.some(has);
}

function entityUrl(endpoint: string, kind: Kind, e: LinkedEntity): string {
  if (kind === "testCases") return `${endpoint}/project/${e.projectId}/test-cases/${e.id}`;
  if (kind === "launches") return `${endpoint}/launch/${e.id}`;
  return `${endpoint}/project/${e.projectId}/defects/${e.id}`;
}

function Linked({ items, kind, endpoint, projects }: { items: LinkedEntity[]; kind: Kind; endpoint: string; projects: Map<number, string> }) {
  if (items.length === 0) return <Typography.Text type="secondary">0</Typography.Text>;
  const list = (
    <div style={{ maxHeight: 320, maxWidth: 480, overflow: "auto" }}>
      {items.map((e) => (
        <div key={`${e.projectId}:${e.id}`}>
          <Typography.Text type="secondary">
            #{e.projectId} {projects.get(e.projectId)} ·{" "}
          </Typography.Text>
          <Typography.Link href={entityUrl(endpoint, kind, e)} target="_blank">
            {e.name}
          </Typography.Link>
          {e.closed && <Typography.Text type="secondary"> (closed)</Typography.Text>}
        </div>
      ))}
    </div>
  );
  return (
    <Popover content={list} title={`${items.length} linked`} trigger="click">
      <Button type="link" size="small" style={{ padding: 0 }}>
        {items.length}
      </Button>
    </Popover>
  );
}

function CoverageChart({ rows, by }: { rows: Row[]; by: By }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
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
    type Stats = { yes: number; no: number } & Record<Kind, number>;
    const byType = new Map<string, Stats>();
    for (const r of rows) {
      const t = byType.get(r.issue.type) ?? { yes: 0, no: 0, testCases: 0, launches: 0, defects: 0 };
      if (covered(r, by)) t.yes++;
      else t.no++;
      for (const k of KINDS) if (r[k.value].length > 0) t[k.value]++;
      byType.set(r.issue.type, t);
    }
    const types = [...byType.keys()].sort(byLabel);
    const pct = (t: Stats) => (t.yes + t.no > 0 ? Math.round((t.yes / (t.yes + t.no)) * 100) : 0);
    // The tooltip names every kind of link, so a type covered in another way than the chosen rule is visible.
    const tooltip = (params: { dataIndex: number }[]) => {
      const type = types[params[0]?.dataIndex ?? 0];
      const t = byType.get(type)!;
      const total = t.yes + t.no;
      return [
        `<b>${type}</b>: ${total} issue(s)`,
        `covered by the chosen rule: ${t.yes} (${pct(t)}%)`,
        ...KINDS.map((k) => `with ${k.label.toLowerCase()}: ${t[k.value]}`),
      ].join("<br/>");
    };
    const label = { show: true, formatter: (p: { value: number }) => (p.value > 0 ? String(p.value) : "") };
    chart.current?.setOption(
      {
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, formatter: tooltip },
        legend: { top: 0 },
        grid: { left: 110, right: 60, top: 36, bottom: 24 },
        xAxis: { type: "value", minInterval: 1 },
        yAxis: { type: "category", data: types.map((t) => `${t} (${pct(byType.get(t)!)}%)`), inverse: true },
        series: [
          { name: "Covered", type: "bar", stack: "c", color: "#52c41a", data: types.map((t) => byType.get(t)!.yes), label },
          { name: "Not covered", type: "bar", stack: "c", color: "#ff7875", data: types.map((t) => byType.get(t)!.no), label },
        ],
      },
      true,
    );
  }, [rows, by]);
  const typeCount = new Set(rows.map((r) => r.issue.type)).size;
  return <div ref={el} style={{ width: "100%", height: Math.max(160, 70 + typeCount * 42) }} />;
}

export function CoveragePage({ jiraConfigured }: { jiraConfigured: boolean }) {
  const { snapshot, error, requestRefresh } = useDataset(api.coverage, api.refreshCoverage);
  const data: CoverageData | null = snapshot?.data ?? null;

  const [text, setText] = useState("");
  const [projects, setProjects] = useState<string[]>([]);
  // Types are shown unless unticked, so newly appearing types show up too.
  const [hiddenTypes, setHiddenTypes] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [coverage, setCoverage] = useState<Coverage>("all");
  const [kinds, setKinds] = useState<Kind[]>(KINDS.map((k) => k.value));
  const [match, setMatch] = useState<Match>("any");
  const by = useMemo<By>(() => ({ kinds, match }), [kinds, match]);

  const allRows = useMemo<Row[]>(
    () =>
      (data?.issues ?? []).map((issue) => ({
        issue,
        testCases: data?.testCases[issue.key] ?? [],
        launches: data?.launches[issue.key] ?? [],
        defects: data?.defects[issue.key] ?? [],
      })),
    [data],
  );
  const options = useMemo(() => {
    const list = (values: string[]) => [...new Set(values)].sort(byLabel).map((v) => ({ value: v, label: v }));
    return { projects: list(allRows.map((r) => r.issue.project)), types: list(allRows.map((r) => r.issue.type)) };
  }, [allRows]);

  // The chart follows every filter except the coverage one.
  const scoped = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return allRows.filter(
      (r) =>
        (!needle || r.issue.key.toLowerCase().includes(needle) || r.issue.summary.toLowerCase().includes(needle)) &&
        (projects.length === 0 || projects.includes(r.issue.project)) &&
        !hiddenTypes.includes(r.issue.type) &&
        (categories.length === 0 || categories.includes(r.issue.statusCategory)),
    );
  }, [allRows, text, projects, hiddenTypes, categories]);
  const shown = useMemo(
    () => (coverage === "all" ? scoped : scoped.filter((r) => covered(r, by) === (coverage === "covered"))),
    [scoped, coverage, by],
  );

  const endpoint = data?.endpoint ?? "";
  const jiraUrl = data?.jiraUrl ?? "";
  const testOpsProjects = useMemo(() => new Map((data?.projects ?? []).map((p) => [p.id, p.name])), [data]);
  const jiraProjectNames = useMemo(() => new Map((data?.jiraProjects ?? []).map((p) => [p.key, p.name])), [data]);
  const rows = useMemo(
    () =>
      buildTree(
        shown,
        [
          {
            id: "project",
            title: "Project",
            of: (r: Row) => {
              const name = jiraProjectNames.get(r.issue.project);
              return { key: r.issue.project, label: name ? `${r.issue.project}: ${name}` : r.issue.project };
            },
          },
        ],
        (r) => r.issue.key,
      ),
    [shown, jiraProjectNames],
  );
  const { expanded, onExpand, expandAll, collapseAll } = useExpanded(rows);
  const expandedSet = useMemo(() => new Set(expanded), [expanded]);

  const groupSpan = (r: TreeRow<Row>) => ({ colSpan: r.kind === "group" ? 0 : 1 });
  const countColumn = (kind: Kind, title: string): ColumnsType<TreeRow<Row>>[number] => ({
    title,
    key: kind,
    width: 110,
    align: "right",
    sorter: itemSorter((r: Row) => r[kind].length),
    sortDirections: ["descend", "ascend"],
    render: (_, r) =>
      r.kind === "group" ? (
        <Tooltip title={`Issues of the project with ${title.toLowerCase()}`}>
          <Typography.Text type="secondary">
            {r.items.filter((i) => i[kind].length > 0).length} / {r.items.length}
          </Typography.Text>
        </Tooltip>
      ) : (
        <Linked items={r.item[kind]} kind={kind} endpoint={endpoint} projects={testOpsProjects} />
      ),
  });
  const columns: ColumnsType<TreeRow<Row>> = [
    {
      title: "Issue",
      key: "key",
      width: 170,
      sorter: itemSorter((r: Row) => r.issue.key),
      onCell: (r) => ({ colSpan: r.kind === "group" ? 4 : 1 }),
      render: (_, r) => (
        <TreeCell row={r} expanded={expandedSet.has(r.key)} onToggle={() => onExpand(!expandedSet.has(r.key), r)}>
          {r.kind === "group" ? (
            <Space wrap size={[8, 0]}>
              <Typography.Text strong>{r.label}</Typography.Text>
              <Typography.Text type="secondary">{r.items.length} issue(s)</Typography.Text>
            </Space>
          ) : (
            <Tooltip title={r.item.issue.summary}>
              <Typography.Link href={`${jiraUrl}/browse/${r.item.issue.key}`} target="_blank">
                {r.item.issue.key}
              </Typography.Link>
            </Tooltip>
          )}
        </TreeCell>
      ),
    },
    { title: "Summary", key: "summary", width: 360, onCell: groupSpan, render: (_, r) => r.kind === "item" && r.item.issue.summary },
    {
      title: "Type",
      key: "type",
      width: 110,
      sorter: itemSorter((r: Row) => r.issue.type),
      onCell: groupSpan,
      render: (_, r) => r.kind === "item" && r.item.issue.type,
    },
    {
      title: "Status",
      key: "status",
      width: 140,
      onCell: groupSpan,
      render: (_, r) => r.kind === "item" && <Tag color={categoryColor[r.item.issue.statusCategory] ?? "default"}>{r.item.issue.status}</Tag>,
    },
    countColumn("testCases", "Test cases"),
    countColumn("launches", "Launches"),
    countColumn("defects", "Defects"),
  ];
  const sized = useColumnWidths("coverage", columns);

  if (!jiraConfigured) {
    return <Empty description="Connect Jira and choose projects and issue types on the Settings tab to see the coverage" />;
  }

  const count = (kind: Kind) => scoped.filter((r) => r[kind].length > 0).length;
  const share = (n: number) => (scoped.length > 0 ? `${Math.round((n / scoped.length) * 100)}%` : "–");

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <RefreshBar snapshot={snapshot} error={error} onRefresh={() => requestRefresh()} />
      {data && (
        <Typography.Text type="secondary">
          Last update: {data.sync.full ? "all" : "updated"} Jira issues loaded ({data.sync.loaded}), {data.sync.total} issue(s) tracked; issue links
          of {data.sync.testCaseLinksLoaded} test case(s) reloaded.
        </Typography.Text>
      )}
      <Card size="small">
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Space wrap align="center">
            <Input.Search
              allowClear
              placeholder="Issue key or summary"
              style={{ width: 240 }}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <Select
              mode="multiple"
              allowClear
              placeholder="Jira project"
              style={{ minWidth: 180 }}
              options={options.projects}
              value={projects}
              onChange={setProjects}
            />
            <Select
              mode="multiple"
              allowClear
              placeholder="Status"
              style={{ minWidth: 200 }}
              options={STATUS_CATEGORIES}
              value={categories}
              onChange={setCategories}
            />
          </Space>
          <Space wrap align="center">
            <Typography.Text>Issue types:</Typography.Text>
            <Checkbox.Group
              options={options.types}
              value={options.types.map((o) => o.value).filter((t) => !hiddenTypes.includes(t))}
              onChange={(shownTypes) => setHiddenTypes(options.types.map((o) => o.value).filter((t) => !shownTypes.includes(t)))}
            />
          </Space>
          <Space wrap align="center">
            <Typography.Text>Covered by:</Typography.Text>
            <Checkbox.Group<Kind> options={KINDS} value={kinds} onChange={setKinds} />
            <Tooltip title="Whether an issue needs any or all of the ticked kinds of links to count as covered">
              <Segmented<Match>
                value={match}
                onChange={setMatch}
                disabled={kinds.length < 2}
                options={[
                  { value: "any", label: "any" },
                  { value: "all", label: "all" },
                ]}
              />
            </Tooltip>
            <Segmented<Coverage>
              value={coverage}
              onChange={setCoverage}
              options={[
                { value: "all", label: "All issues" },
                { value: "covered", label: "Covered" },
                { value: "uncovered", label: "Not covered" },
              ]}
            />
          </Space>
        </Space>
      </Card>
      {data?.failedProjects.length ? (
        <Alert
          type="warning"
          showIcon
          title={`Failed to load Allure TestOps projects: ${data.failedProjects.map((f) => `#${f.id} (${f.error})`).join("; ")}`}
        />
      ) : null}
      {data && (
        <Card size="small" title={`Coverage by issue type, covered by ${ruleText(by)}`}>
          {scoped.length > 0 ? <CoverageChart rows={scoped} by={by} /> : <Empty description="No issues" />}
        </Card>
      )}
      <Space wrap>
        <Typography.Text type="secondary">
          {data
            ? `Issues: ${shown.length} of ${allRows.length}. Covered by the chosen rule ${scoped.filter((r) => covered(r, by)).length} (${share(scoped.filter((r) => covered(r, by)).length)}). With test cases ${count("testCases")} (${share(count("testCases"))}), with launches ${count("launches")} (${share(count("launches"))}), with defects ${count("defects")} (${share(count("defects"))}).`
            : ""}
        </Typography.Text>
        <Button size="small" onClick={expandAll}>
          Expand all
        </Button>
        <Button size="small" onClick={collapseAll}>
          Collapse all
        </Button>
        <Button size="small" onClick={sized.reset}>
          Reset column widths
        </Button>
      </Space>
      <Table<TreeRow<Row>>
        size="small"
        rowKey="key"
        className="wrap-table"
        columns={sized.columns}
        components={resizableComponents}
        tableLayout="fixed"
        dataSource={rows}
        expandable={{ expandedRowKeys: expanded, indentSize: 0, expandIcon: () => null }}
        pagination={{ defaultPageSize: 100, showSizeChanger: true, pageSizeOptions: [50, 100, 200, 500], hideOnSinglePage: true }}
        scroll={{ x: sized.totalWidth }}
        loading={!data && (snapshot?.refreshing ?? true)}
        locale={{ emptyText: <Empty description={data ? "No issues" : "Loading"} /> }}
      />
    </Space>
  );
}
