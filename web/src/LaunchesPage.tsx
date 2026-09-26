import { useMemo, useState } from "react";
import { Badge, Button, Card, Checkbox, Empty, Input, Segmented, Select, Space, Switch, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { api, type Launch, type LaunchesData } from "./api";
import { countOrUnknown, hasFlag, LAUNCH_FLAGS, StatusCounts, StatusLegend, type LaunchFlag } from "./launchResults";
import { RefreshBar } from "./RefreshBar";
import { TreeCell } from "./TreeCell";
import { buildTree, itemSorter, type Grouper, type TreeRow } from "./tree";
import { useDataset } from "./useDataset";
import { resizableComponents, useColumnWidths } from "./useColumnWidths";
import { useExpanded } from "./useExpanded";

const envKey = (e: { name: string; value: string }) => `${e.name}=${e.value}`;
const dateTime = (ms: number | null) => (ms ? new Date(ms).toLocaleString("en-GB") : "");
const NO_AUTHOR = "(no creator)";
const COLUMN_COUNT = 11;

type TagMode = "any" | "all";
type State = "all" | "open" | "closed";

function matchesEnv(launch: Launch, selected: string[]): boolean {
  if (selected.length === 0) return true;
  // Values of one variable are alternatives, different variables must all match.
  const byVar = new Map<string, Set<string>>();
  for (const key of selected) {
    const i = key.indexOf("=");
    const name = key.slice(0, i);
    if (!byVar.has(name)) byVar.set(name, new Set());
    byVar.get(name)!.add(key);
  }
  const own = new Set(launch.env.map(envKey));
  return [...byVar.values()].every((keys) => [...keys].some((k) => own.has(k)));
}

export function LaunchesPage() {
  const { snapshot, error, requestRefresh } = useDataset(api.launches, api.refreshLaunches);
  const data: LaunchesData | null = snapshot?.data ?? null;

  const [name, setName] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagMode, setTagMode] = useState<TagMode>("any");
  const [envs, setEnvs] = useState<string[]>([]);
  const [byAuthor, setByAuthor] = useState(false);
  const [state, setState] = useState<State>("all");
  const [flags, setFlags] = useState<LaunchFlag[]>([]);

  const options = useMemo(() => {
    const tagSet = new Set<string>();
    const envSet = new Set<string>();
    for (const l of data?.launches ?? []) {
      l.tags.forEach((t) => tagSet.add(t));
      l.env.forEach((e) => envSet.add(envKey(e)));
    }
    const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b, "en")).map((v) => ({ value: v, label: v }));
    return { tags: sorted(tagSet), envs: sorted(envSet) };
  }, [data]);

  const filtered = useMemo(() => {
    const needle = name.trim().toLowerCase();
    return (data?.launches ?? []).filter((l) => {
      if (state !== "all" && l.closed !== (state === "closed")) return false;
      if (!flags.every((f) => hasFlag(l, f))) return false;
      if (needle && !l.name.toLowerCase().includes(needle)) return false;
      if (tags.length > 0) {
        const has = (t: string) => l.tags.includes(t);
        if (tagMode === "all" ? !tags.every(has) : !tags.some(has)) return false;
      }
      return matchesEnv(l, envs);
    });
  }, [data, name, tags, tagMode, envs, state, flags]);

  const rows = useMemo(() => {
    const projects = new Map((data?.projects ?? []).map((p) => [p.id, p.name]));
    const groupers: Grouper<Launch>[] = [
      {
        id: "project",
        title: "Project",
        of: (l) => ({ key: String(l.projectId), label: `#${l.projectId} ${projects.get(l.projectId) ?? ""}`, sort: l.projectId }),
      },
    ];
    if (byAuthor) {
      groupers.push({
        id: "author",
        title: "Creator",
        of: (l) => ({ key: l.createdBy ?? "", label: l.createdBy ?? NO_AUTHOR, sort: (l.createdBy ?? "￿").toLowerCase() }),
      });
    }
    return buildTree(filtered, groupers, (l) => String(l.id));
  }, [data, filtered, byAuthor]);

  const { expanded, onExpand, expandAll, collapseAll } = useExpanded(rows);
  const expandedSet = useMemo(() => new Set(expanded), [expanded]);
  const endpoint = data?.endpoint ?? "";

  const groupSpan = (r: TreeRow<Launch>) => ({ colSpan: r.kind === "group" ? 0 : 1 });
  const columns: ColumnsType<TreeRow<Launch>> = [
    {
      title: "Launch",
      key: "name",
      width: 320,
      sorter: itemSorter((l) => l.name),
      sortDirections: ["ascend", "descend"],
      onCell: (r) => ({ colSpan: r.kind === "group" ? COLUMN_COUNT : 1 }),
      render: (_, r) => (
        <TreeCell row={r} expanded={expandedSet.has(r.key)} onToggle={() => onExpand(!expandedSet.has(r.key), r)}>
          {r.kind === "group" ? (
            <Space wrap size={[8, 0]}>
              {r.groupId === "project" ? (
                <Typography.Link strong href={`${endpoint}/project/${r.items[0].projectId}/launches`} target="_blank">
                  {r.label}
                </Typography.Link>
              ) : (
                <Typography.Text strong>{r.label}</Typography.Text>
              )}
              <Badge count={r.items.length} showZero color="blue" overflowCount={9999} />
            </Space>
          ) : (
            <Typography.Link href={`${endpoint}/launch/${r.item.id}`} target="_blank">
              {r.item.name}
            </Typography.Link>
          )}
        </TreeCell>
      ),
    },
    {
      title: "ID",
      key: "id",
      width: 90,
      sorter: itemSorter((l) => l.id),
      sortDirections: ["ascend", "descend"],
      onCell: groupSpan,
      render: (_, r) => (r.kind === "item" ? r.item.id : null),
    },
    {
      title: "State",
      key: "state",
      width: 80,
      onCell: groupSpan,
      render: (_, r) => r.kind === "item" && (r.item.closed ? <Tag>closed</Tag> : <Tag color="cyan">open</Tag>),
    },
    {
      title: (
        <Tooltip title={<StatusLegend />} color="white">
          Results
        </Tooltip>
      ),
      key: "results",
      width: 220,
      onCell: groupSpan,
      render: (_, r) => r.kind === "item" && <StatusCounts statistic={r.item.statistic} />,
    },
    {
      title: "Unresolved",
      key: "unresolved",
      width: 100,
      align: "right",
      onCell: groupSpan,
      render: (_, r) => r.kind === "item" && countOrUnknown(r.item.unresolved),
    },
    {
      title: "Muted",
      key: "muted",
      width: 80,
      align: "right",
      onCell: groupSpan,
      render: (_, r) => r.kind === "item" && countOrUnknown(r.item.muted),
    },
    {
      title: <Tooltip title="New / known defects">Defects</Tooltip>,
      key: "defects",
      width: 90,
      align: "right",
      onCell: groupSpan,
      render: (_, r) => r.kind === "item" && `${countOrUnknown(r.item.newDefects)} / ${countOrUnknown(r.item.knownDefects)}`,
    },
    {
      title: "Tags",
      key: "tags",
      width: 200,
      onCell: groupSpan,
      render: (_, r) => r.kind === "item" && r.item.tags.map((t) => <Tag key={t}>{t}</Tag>),
    },
    {
      title: "Environment",
      key: "env",
      width: 240,
      onCell: groupSpan,
      render: (_, r) =>
        r.kind === "item" &&
        r.item.env.map((e) => (
          <Tag key={envKey(e)} color="geekblue">
            {e.name}: {e.value}
          </Tag>
        )),
    },
    { title: "Creator", key: "author", width: 160, onCell: groupSpan, render: (_, r) => (r.kind === "item" ? r.item.createdBy : null) },
    {
      title: "Created",
      key: "created",
      width: 170,
      sorter: itemSorter((l) => l.createdDate),
      sortDirections: ["ascend", "descend"],
      onCell: groupSpan,
      render: (_, r) => (r.kind === "item" ? dateTime(r.item.createdDate) : null),
    },
  ];

  const sized = useColumnWidths("launches", columns);

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <RefreshBar snapshot={snapshot} error={error} onRefresh={requestRefresh} />
      <Card size="small">
        <Space wrap size="middle" align="center">
          <Input.Search allowClear placeholder="Part of launch name" style={{ width: 240 }} value={name} onChange={(e) => setName(e.target.value)} />
          <Space.Compact>
            <Select
              mode="multiple"
              allowClear
              placeholder="Tags"
              style={{ minWidth: 220, maxWidth: 420 }}
              options={options.tags}
              value={tags}
              onChange={setTags}
              maxTagCount="responsive"
            />
            <Segmented<TagMode>
              value={tagMode}
              onChange={setTagMode}
              options={[
                { value: "any", label: "any" },
                { value: "all", label: "all" },
              ]}
            />
          </Space.Compact>
          <Select
            mode="multiple"
            allowClear
            placeholder="Environment"
            style={{ minWidth: 260, maxWidth: 480 }}
            options={options.envs}
            value={envs}
            onChange={setEnvs}
            maxTagCount="responsive"
          />
          <Space>
            <Switch checked={byAuthor} onChange={setByAuthor} />
            <Typography.Text>Group by creator</Typography.Text>
          </Space>
        </Space>
        <Space wrap size="middle" align="center" style={{ marginTop: 12 }}>
          <Segmented<State>
            value={state}
            onChange={setState}
            options={[
              { value: "all", label: "All" },
              { value: "open", label: "Open" },
              { value: "closed", label: "Closed" },
            ]}
          />
          <Typography.Text>Only with:</Typography.Text>
          <Checkbox.Group<LaunchFlag>
            value={flags}
            onChange={setFlags}
            options={LAUNCH_FLAGS.map((f) => ({ value: f.value, label: <Tooltip title={f.hint}>{f.label}</Tooltip> }))}
          />
        </Space>
      </Card>
      {data?.failedProjects.length ? (
        <Typography.Text type="warning">
          Failed to load projects: {data.failedProjects.map((f) => `#${f.id} (${f.error})`).join("; ")}
        </Typography.Text>
      ) : null}
      <Space>
        <Typography.Text type="secondary">
          {data
            ? `Launches: ${filtered.length} of ${data.launches.length} (open, and closed in the last ${data.closedLaunchesDays} days with unresolved results), projects total: ${data.projects.length}`
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
      <Table<TreeRow<Launch>>
        size="small"
        rowKey="key"
        className="wrap-table"
        columns={sized.columns}
        components={resizableComponents}
        tableLayout="fixed"
        dataSource={rows}
        pagination={false}
        scroll={{ x: sized.totalWidth }}
        loading={!data && (snapshot?.refreshing ?? true)}
        expandable={{ expandedRowKeys: expanded, indentSize: 0, expandIcon: () => null }}
        locale={{ emptyText: <Empty description={data ? "No launches found" : "Loading"} /> }}
      />
    </Space>
  );
}
