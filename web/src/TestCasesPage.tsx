import { useMemo } from "react";
import { Alert, Badge, Button, Empty, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { api, type TestCase, type TestCasesData } from "./api";
import { RefreshBar } from "./RefreshBar";
import { AutomationCounts, useTestCaseQuery } from "./testCaseQuery";
import { itemSorter, type TreeRow } from "./tree";
import { TreeCell } from "./TreeCell";
import { resizableComponents, useColumnWidths } from "./useColumnWidths";
import { useDataset } from "./useDataset";
import { useExpanded } from "./useExpanded";

const COLUMN_COUNT = 8;

export function TestCasesPage() {
  const { snapshot, error, requestRefresh } = useDataset(api.testCases, api.refreshTestCases);
  const data: TestCasesData | null = snapshot?.data ?? null;
  const { testCases, filtered, rows, controls } = useTestCaseQuery(data, ["project"]);

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
            Last update: {data.sync.full ? "full reload" : "incremental"}, details loaded for {data.sync.loaded} test case(s), {data.sync.reused} from
            cache, {data.sync.removed} removed. Last full reload: {new Date(data.sync.fullReloadAt).toLocaleString("en-GB")}.
          </Typography.Text>
          <Tooltip title="Reload the details of every test case, not only new and changed ones. Counts towards the once-a-minute refresh limit.">
            <Button size="small" disabled={snapshot?.refreshing} onClick={() => requestRefresh(api.reloadAllTestCases)}>
              Reload all details
            </Button>
          </Tooltip>
        </Space>
      )}
      {controls}
      {undetailed > 0 && (
        <Alert type="warning" showIcon title={`Details could not be loaded for ${undetailed} test case(s); only their name and ID are shown.`} />
      )}
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
