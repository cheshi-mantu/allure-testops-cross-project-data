import { useMemo, useState } from "react";
import { Alert, Badge, Button, Card, Empty, Input, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { api, type TestCase, type TestCasesData } from "./api";
import { DimensionFilters, matchesFilters, NONE, toGrouper, valueOptions, type Dimension, type DimensionFilter } from "./dimensions";
import { RefreshBar } from "./RefreshBar";
import { buildTree, itemSorter, type TreeRow } from "./tree";
import { TreeCell } from "./TreeCell";
import { resizableComponents, useColumnWidths } from "./useColumnWidths";
import { useDataset } from "./useDataset";
import { useExpanded } from "./useExpanded";

const MAX_GROUP_LEVELS = 6;
const COLUMN_COUNT = 8;

type TagMode = "any" | "all";

const byName = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });
const unique = (values: string[]) => [...new Set(values)].map((v) => ({ key: v, label: v }));

/** Project, layer, issue and tag, then one dimension per member role and per custom field found in the data. */
function buildDimensions(data: TestCasesData | null): Dimension<TestCase>[] {
  if (!data) return [];
  const projects = new Map(data.projects.map((p) => [p.id, p.name]));
  const roles = new Set<string>();
  const fields = new Set<string>();
  for (const tc of data.testCases) {
    tc.members.forEach((m) => roles.add(m.role));
    tc.customFields.forEach((f) => fields.add(f.name));
  }
  return [
    {
      id: "project",
      title: "Project",
      values: (tc) => [{ key: String(tc.projectId), label: `#${tc.projectId} ${projects.get(tc.projectId) ?? ""}` }],
      sort: (v) => Number(v.key),
    },
    {
      id: "automation",
      title: "Automation",
      values: (tc) => (tc.automated === null ? [] : tc.automated ? [{ key: "auto", label: "Automated" }] : [{ key: "manual", label: "Manual" }]),
    },
    { id: "layer", title: "Layer", values: (tc) => (tc.layer ? [{ key: tc.layer, label: tc.layer }] : []) },
    { id: "issue", title: "Issue", values: (tc) => unique(tc.issues.map((i) => i.name)) },
    { id: "tag", title: "Tag", values: (tc) => unique(tc.tags) },
    ...[...roles].sort(byName).map(
      (role): Dimension<TestCase> => ({
        id: `role:${role}`,
        title: role || "(no role)",
        values: (tc) => unique(tc.members.filter((m) => m.role === role).map((m) => m.name)),
      }),
    ),
    ...[...fields].sort(byName).map(
      (field): Dimension<TestCase> => ({
        id: `cf:${field}`,
        title: field,
        values: (tc) => unique(tc.customFields.find((f) => f.name === field)?.values ?? []),
      }),
    ),
  ];
}

/** Automated and manual test case counters; unknown ones only when present. */
function AutomationCounts({ items }: { items: TestCase[] }) {
  let auto = 0;
  let manual = 0;
  for (const tc of items) {
    if (tc.automated === true) auto++;
    else if (tc.automated === false) manual++;
  }
  const unknown = items.length - auto - manual;
  return (
    <Space size={0}>
      <Tooltip title="Automated test cases">
        <Tag color="green">auto {auto}</Tag>
      </Tooltip>
      <Tooltip title="Manual test cases">
        <Tag color="gold">manual {manual}</Tag>
      </Tooltip>
      {unknown > 0 && (
        <Tooltip title="Automation is not known">
          <Tag>? {unknown}</Tag>
        </Tooltip>
      )}
    </Space>
  );
}

const kindOf = (id: string) => (id.startsWith("role:") ? "Member" : id.startsWith("cf:") ? "Custom field" : "General");

export function TestCasesPage() {
  const { snapshot, error, requestRefresh } = useDataset(api.testCases, api.refreshTestCases);
  const data: TestCasesData | null = snapshot?.data ?? null;

  const [grouping, setGrouping] = useState<string[]>(["project"]);
  const [name, setName] = useState("");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [tagMode, setTagMode] = useState<TagMode>("any");
  const [filters, setFilters] = useState<DimensionFilter[]>([]);

  const dimensions = useMemo(() => buildDimensions(data), [data]);
  const byId = useMemo(() => new Map(dimensions.map((d) => [d.id, d])), [dimensions]);
  const testCases = useMemo(() => data?.testCases ?? [], [data]);

  const groupOptions = useMemo(() => {
    const kinds = ["General", "Member", "Custom field"];
    return kinds
      .map((kind) => ({
        label: kind === "General" ? "General" : kind === "Member" ? "Member roles" : "Custom fields",
        options: dimensions.filter((d) => kindOf(d.id) === kind).map((d) => ({ value: d.id, label: d.title })),
      }))
      .filter((g) => g.options.length > 0);
  }, [dimensions]);

  const projectOptions = useMemo(() => {
    const d = byId.get("project");
    return d ? valueOptions(testCases, d) : [];
  }, [byId, testCases]);
  const tagOptions = useMemo(() => {
    const d = byId.get("tag");
    return d ? valueOptions(testCases, d).filter((o) => o.value !== NONE) : [];
  }, [byId, testCases]);

  // Project and tag have their own controls; the generic filters cover the rest.
  const filterDimensions = useMemo(() => dimensions.filter((d) => d.id !== "project" && d.id !== "tag"), [dimensions]);

  const filtered = useMemo(() => {
    const needle = name.trim().toLowerCase();
    return testCases.filter((tc) => {
      if (needle && !tc.name.toLowerCase().includes(needle) && String(tc.id) !== needle) return false;
      if (projectIds.length > 0 && !projectIds.includes(String(tc.projectId))) return false;
      if (tags.length > 0) {
        const has = (t: string) => tc.tags.includes(t);
        if (tagMode === "all" ? !tags.every(has) : !tags.some(has)) return false;
      }
      return matchesFilters(tc, filters, byId);
    });
  }, [testCases, name, projectIds, tags, tagMode, filters, byId]);

  const rows = useMemo(
    () =>
      buildTree(
        filtered,
        grouping.flatMap((g) => {
          const d = byId.get(g);
          return d ? [toGrouper(d)] : [];
        }),
        (tc) => String(tc.id),
      ),
    [filtered, grouping, byId],
  );

  const { expanded, onExpand, expandAll, collapseAll } = useExpanded(rows, false);
  const expandedSet = useMemo(() => new Set(expanded), [expanded]);
  const endpoint = data?.endpoint ?? "";

  const groupSpan = (r: TreeRow<TestCase>) => ({ colSpan: r.kind === "group" ? 0 : 1 });
  const columns: ColumnsType<TreeRow<TestCase>> = [
    {
      title: "Test case",
      key: "name",
      width: 360,
      sorter: itemSorter((tc) => tc.name),
      sortDirections: ["ascend", "descend"],
      onCell: (r) => ({ colSpan: r.kind === "group" ? COLUMN_COUNT : 1 }),
      render: (_, r) => (
        <TreeCell row={r} expanded={expandedSet.has(r.key)} onToggle={() => onExpand(!expandedSet.has(r.key), r)}>
          {r.kind === "group" ? (
            <Space wrap size={[8, 0]}>
              <Typography.Text type="secondary">{r.groupTitle}:</Typography.Text>
              {r.groupId === "project" ? (
                <Typography.Link strong href={`${endpoint}/project/${r.items[0].projectId}/test-cases`} target="_blank">
                  {r.label}
                </Typography.Link>
              ) : (
                <Typography.Text strong>{r.label}</Typography.Text>
              )}
              <Badge count={r.items.length} showZero color="blue" overflowCount={999999} />
              <AutomationCounts items={r.items} />
              {r.groupId !== "project" && (
                <Typography.Text type="secondary">in {new Set(r.items.map((tc) => tc.projectId)).size} project(s)</Typography.Text>
              )}
            </Space>
          ) : (
            <Typography.Link href={`${endpoint}/project/${r.item.projectId}/test-cases/${r.item.id}`} target="_blank">
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
      sorter: itemSorter((tc) => tc.id),
      sortDirections: ["ascend", "descend"],
      onCell: groupSpan,
      render: (_, r) => (r.kind === "item" ? r.item.id : null),
    },
    {
      title: "Automation",
      key: "automation",
      width: 110,
      onCell: groupSpan,
      render: (_, r) =>
        r.kind === "item" &&
        (r.item.automated === null ? (
          <Typography.Text type="secondary">?</Typography.Text>
        ) : r.item.automated ? (
          <Tag color="green">auto</Tag>
        ) : (
          <Tag color="gold">manual</Tag>
        )),
    },
    {
      title: "Layer",
      key: "layer",
      width: 120,
      onCell: groupSpan,
      render: (_, r) =>
        r.kind === "item" &&
        (r.item.detailed ? (
          r.item.layer
        ) : (
          <Tooltip title="Details could not be loaded">
            <Typography.Text type="secondary">?</Typography.Text>
          </Tooltip>
        )),
    },
    {
      title: "Tags",
      key: "tags",
      width: 180,
      onCell: groupSpan,
      render: (_, r) => r.kind === "item" && r.item.tags.map((t) => <Tag key={t}>{t}</Tag>),
    },
    {
      title: "Members",
      key: "members",
      width: 200,
      onCell: groupSpan,
      render: (_, r) =>
        r.kind === "item" &&
        r.item.members.map((m) => (
          <div key={`${m.role}:${m.name}`}>
            <Typography.Text type="secondary">{m.role}: </Typography.Text>
            {m.name}
          </div>
        )),
    },
    {
      title: "Issues",
      key: "issues",
      width: 140,
      onCell: groupSpan,
      render: (_, r) =>
        r.kind === "item" &&
        r.item.issues.map((i) => (
          <div key={i.name}>
            {i.url ? (
              <Typography.Link href={i.url} target="_blank">
                {i.name}
              </Typography.Link>
            ) : (
              i.name
            )}
          </div>
        )),
    },
    {
      title: "Custom fields",
      key: "cf",
      width: 280,
      onCell: groupSpan,
      render: (_, r) =>
        r.kind === "item" &&
        r.item.customFields.map((f) => (
          <div key={f.name}>
            <Typography.Text type="secondary">{f.name}: </Typography.Text>
            {f.values.join(", ")}
          </div>
        )),
    },
  ];

  const sized = useColumnWidths("testcases", columns);
  const undetailed = testCases.filter((tc) => !tc.detailed).length;

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <RefreshBar snapshot={snapshot} error={error} onRefresh={() => requestRefresh()} />
      {data && (
        <Space wrap>
          <Typography.Text type="secondary">
            Last update: {data.sync.full ? "full reload" : "incremental"}, details loaded for {data.sync.loaded} test case(s), {data.sync.reused}{" "}
            from cache, {data.sync.removed} removed. Last full reload: {new Date(data.sync.fullReloadAt).toLocaleString("en-GB")}.
          </Typography.Text>
          <Tooltip title="Reload the details of every test case, not only new and changed ones. Counts towards the once-a-minute refresh limit.">
            <Button size="small" disabled={snapshot?.refreshing} onClick={() => requestRefresh(api.reloadAllTestCases)}>
              Reload all details
            </Button>
          </Tooltip>
        </Space>
      )}
      <Card size="small">
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Space wrap align="center">
            <Typography.Text>Group by:</Typography.Text>
            <Select<string[]>
              mode="multiple"
              style={{ minWidth: 420 }}
              placeholder="No grouping"
              value={grouping}
              onChange={setGrouping}
              maxCount={MAX_GROUP_LEVELS}
              showSearch={{ optionFilterProp: "label" }}
              options={groupOptions}
            />
            <Typography.Text type="secondary">up to {MAX_GROUP_LEVELS} levels, in the selection order</Typography.Text>
          </Space>
          <Space wrap align="center">
            <Input.Search allowClear placeholder="Part of name or ID" style={{ width: 240 }} value={name} onChange={(e) => setName(e.target.value)} />
            <Select
              mode="multiple"
              allowClear
              showSearch={{ optionFilterProp: "label" }}
              placeholder="Project"
              style={{ minWidth: 220, maxWidth: 420 }}
              options={projectOptions}
              value={projectIds}
              onChange={setProjectIds}
              maxTagCount="responsive"
            />
            <Space.Compact>
              <Select
                mode="multiple"
                allowClear
                showSearch={{ optionFilterProp: "label" }}
                placeholder="Tags"
                style={{ minWidth: 220, maxWidth: 420 }}
                options={tagOptions}
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
          </Space>
          <DimensionFilters items={testCases} dimensions={filterDimensions} filters={filters} onChange={setFilters} />
        </Space>
      </Card>
      {undetailed > 0 && <Alert type="warning" showIcon title={`Details could not be loaded for ${undetailed} test case(s); only their name and ID are shown.`} />}
      {data?.failedProjects.length ? (
        <Typography.Text type="warning">
          Failed to load projects: {data.failedProjects.map((f) => `#${f.id} (${f.error})`).join("; ")}
        </Typography.Text>
      ) : null}
      <Space wrap>
        <Typography.Text type="secondary">
          {data ? `Test cases: ${filtered.length} of ${testCases.length}, projects total: ${data.projects.length}` : ""}
        </Typography.Text>
        {data && <AutomationCounts items={filtered} />}
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
      <Table<TreeRow<TestCase>>
        size="small"
        rowKey="key"
        className="wrap-table"
        columns={sized.columns}
        components={resizableComponents}
        tableLayout="fixed"
        dataSource={rows}
        pagination={{ defaultPageSize: 100, showSizeChanger: true, pageSizeOptions: [50, 100, 200, 500], hideOnSinglePage: true }}
        scroll={{ x: sized.totalWidth }}
        loading={!data && (snapshot?.refreshing ?? true)}
        expandable={{ expandedRowKeys: expanded, indentSize: 0, expandIcon: () => null }}
        locale={{ emptyText: <Empty description={data ? "No test cases found" : "Loading"} /> }}
      />
    </Space>
  );
}
