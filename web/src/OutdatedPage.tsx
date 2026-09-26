import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, App as AntApp, Badge, Button, Card, Empty, Input, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { api, type RunsData, type RunTestCase, type WorkflowInfo } from "./api";
import { RefreshBar } from "./RefreshBar";
import { buildTree, itemSorter, type TreeRow } from "./tree";
import { TreeCell } from "./TreeCell";
import { resizableComponents, useColumnWidths } from "./useColumnWidths";
import { useDataset } from "./useDataset";
import { useExpanded } from "./useExpanded";

type List = "outdated" | "never";
type Automation = "all" | "auto" | "manual";

const DAY = 86_400_000;
const THRESHOLDS = [15, 30, 60, 90];
const COLUMN_COUNT = 7;

const date = (ms: number) => new Date(ms).toLocaleDateString("en-GB");

/** Days since the last run; Infinity when it ran only before the lookback window. */
function idleDays(tc: RunTestCase): number | null {
  if (tc.lastRun !== null) return Math.floor((Date.now() - tc.lastRun) / DAY);
  return tc.everRun ? Infinity : null;
}

function LastRun({ tc, lookback }: { tc: RunTestCase; lookback: number }) {
  if (tc.lastRun !== null) {
    return (
      <span>
        {date(tc.lastRun)} <Typography.Text type="secondary">({idleDays(tc)} d ago)</Typography.Text>
      </span>
    );
  }
  if (tc.everRun === true) return <Typography.Text type="secondary">more than {lookback} days ago</Typography.Text>;
  if (tc.everRun === false) return <Tag color="red">never</Tag>;
  return (
    <Tooltip title="Not checked yet; it is checked on the next refresh">
      <Typography.Text type="secondary">?</Typography.Text>
    </Tooltip>
  );
}

export function OutdatedPage() {
  const { snapshot, error, requestRefresh } = useDataset(api.runs, api.refreshRuns);
  const data: RunsData | null = snapshot?.data ?? null;
  const { message, modal } = AntApp.useApp();

  const [list, setList] = useState<List>("outdated");
  const [threshold, setThreshold] = useState(30);
  const [name, setName] = useState("");
  const [projectIds, setProjectIds] = useState<number[]>([]);
  const [automation, setAutomation] = useState<Automation>("all");
  const [statuses, setStatuses] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [workflowList, setWorkflowList] = useState<WorkflowInfo[] | null>(null);
  const [workflowsLoading, setWorkflowsLoading] = useState(false);
  const [workflowsError, setWorkflowsError] = useState<string | null>(null);
  const [workflowId, setWorkflowId] = useState<number | null>(null);
  const [statusId, setStatusId] = useState<number | null>(null);
  const [applying, setApplying] = useState(false);

  const lookback = data?.lookbackDays ?? 90;
  const projects = useMemo(() => new Map((data?.projects ?? []).map((p) => [p.id, p.name])), [data]);

  const inList = useMemo(() => {
    return (data?.testCases ?? []).filter((tc) => {
      if (list === "never") return tc.everRun === false;
      const idle = idleDays(tc);
      return idle !== null && idle >= threshold;
    });
  }, [data, list, threshold]);

  const statusOptions = useMemo(
    () => [...new Set(inList.map((tc) => tc.status?.name ?? "(no status)"))].sort().map((s) => ({ value: s, label: s })),
    [inList],
  );

  const filtered = useMemo(() => {
    const needle = name.trim().toLowerCase();
    return inList.filter(
      (tc) =>
        (!needle || tc.name.toLowerCase().includes(needle) || String(tc.id) === needle) &&
        (projectIds.length === 0 || projectIds.includes(tc.projectId)) &&
        (automation === "all" || tc.automated === (automation === "auto")) &&
        (statuses.length === 0 || statuses.includes(tc.status?.name ?? "(no status)")),
    );
  }, [inList, name, projectIds, automation, statuses]);

  const rows = useMemo(
    () =>
      buildTree(
        filtered,
        [
          {
            id: "project",
            title: "Project",
            of: (tc) => ({ key: String(tc.projectId), label: `#${tc.projectId} ${projects.get(tc.projectId) ?? ""}`, sort: tc.projectId }),
          },
        ],
        (tc) => String(tc.id),
      ),
    [filtered, projects],
  );

  const { expanded, onExpand, expandAll, collapseAll } = useExpanded(rows, false);
  const expandedSet = useMemo(() => new Set(expanded), [expanded]);
  const visibleIds = useMemo(() => new Set(filtered.map((tc) => tc.id)), [filtered]);
  // Selection survives filtering, but only visible test cases are applied to.
  const chosen = useMemo(() => filtered.filter((tc) => selected.has(tc.id)), [filtered, selected]);
  const endpoint = data?.endpoint ?? "";

  const toggle = (ids: number[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const groupSpan = (r: TreeRow<RunTestCase>) => ({ colSpan: r.kind === "group" ? 0 : 1 });
  const columns: ColumnsType<TreeRow<RunTestCase>> = [
    {
      title: "Test case",
      key: "name",
      width: 380,
      sorter: itemSorter((tc) => tc.name),
      sortDirections: ["ascend", "descend"],
      onCell: (r) => ({ colSpan: r.kind === "group" ? COLUMN_COUNT : 1 }),
      render: (_, r) => (
        <TreeCell row={r} expanded={expandedSet.has(r.key)} onToggle={() => onExpand(!expandedSet.has(r.key), r)}>
          {r.kind === "group" ? (
            <Space wrap size={[8, 0]}>
              <Typography.Link strong href={`${endpoint}/project/${r.items[0].projectId}/test-cases`} target="_blank">
                {r.label}
              </Typography.Link>
              <Badge count={r.items.length} showZero color="blue" overflowCount={999999} />
              <Typography.Text type="secondary">{r.items.filter((tc) => selected.has(tc.id)).length} selected</Typography.Text>
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
        r.kind === "item" && (r.item.automated ? <Tag color="green">auto</Tag> : r.item.automated === false ? <Tag color="gold">manual</Tag> : "?"),
    },
    { title: "Workflow", key: "workflow", width: 170, onCell: groupSpan, render: (_, r) => r.kind === "item" && r.item.workflow?.name },
    {
      title: "Status",
      key: "status",
      width: 130,
      onCell: groupSpan,
      render: (_, r) => r.kind === "item" && r.item.status && <Tag color={r.item.status.color ?? undefined}>{r.item.status.name}</Tag>,
    },
    {
      title: "Last run",
      key: "lastRun",
      width: 220,
      sorter: itemSorter((tc) => tc.lastRun),
      sortDirections: ["ascend", "descend"],
      onCell: groupSpan,
      render: (_, r) => r.kind === "item" && <LastRun tc={r.item} lookback={lookback} />,
    },
    { title: "Created", key: "created", width: 120, onCell: groupSpan, render: (_, r) => r.kind === "item" && r.item.created && date(r.item.created) },
  ];
  const sized = useColumnWidths("outdated", columns);

  const loadWorkflows = useCallback(() => {
    setWorkflowsLoading(true);
    setWorkflowsError(null);
    api
      .workflows()
      .then(setWorkflowList)
      .catch((e: unknown) => setWorkflowsError(e instanceof Error ? e.message : String(e)))
      .finally(() => setWorkflowsLoading(false));
  }, []);
  // Loaded up front, so the choice is ready by the time test cases are selected.
  useEffect(loadWorkflows, [loadWorkflows]);
  const workflow = workflowList?.find((w) => w.id === workflowId) ?? null;
  const status = workflow?.statuses.find((s) => s.id === statusId) ?? null;

  const apply = () => {
    if (!workflow || !status || chosen.length === 0) return;
    const perProject = new Map<number, number>();
    for (const tc of chosen) perProject.set(tc.projectId, (perProject.get(tc.projectId) ?? 0) + 1);
    modal.confirm({
      title: `Set status "${status.name}" of workflow "${workflow.name}" on ${chosen.length} test case(s)?`,
      width: 560,
      content: (
        <Space orientation="vertical">
          <Typography.Text>This changes the test cases in Allure TestOps on behalf of the API token owner.</Typography.Text>
          <ul style={{ margin: 0, paddingInlineStart: 20 }}>
            {[...perProject].map(([id, n]) => (
              <li key={id}>
                #{id} {projects.get(id)}: {n}
              </li>
            ))}
          </ul>
        </Space>
      ),
      okText: "Apply",
      onOk: async () => {
        setApplying(true);
        try {
          const r = await api.applyStatus(
            chosen.map((tc) => tc.id),
            workflow.id,
            status.id,
          );
          const failed = r.results.filter((x) => x.error !== null);
          const done = r.results.reduce((n, x) => n + x.count, 0);
          if (failed.length === 0) message.success(`Status set on ${done} test case(s)`);
          else {
            modal.error({
              title: `Status set on ${done} test case(s); ${failed.length} project(s) failed`,
              content: failed.map((f) => `#${f.projectId} ${projects.get(f.projectId) ?? ""}: ${f.error}`).join("\n"),
            });
          }
          setSelected(new Set());
          await requestRefresh(api.runs);
        } catch (e) {
          message.error(e instanceof Error ? e.message : String(e));
        } finally {
          setApplying(false);
        }
      },
    });
  };

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <RefreshBar snapshot={snapshot} error={error} onRefresh={() => requestRefresh()} />
      {data && (
        <Typography.Text type="secondary">
          Last runs come from launches of the last {lookback} days. Last update: {data.sync.launchesRead} launch(es) read,{" "}
          {data.sync.neverRunChecked} test case(s) checked for any run.
        </Typography.Text>
      )}
      <Card size="small">
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Space wrap align="center">
            <Segmented<List>
              value={list}
              onChange={setList}
              options={[
                { value: "outdated", label: "Not run for" },
                { value: "never", label: "Never run" },
              ]}
            />
            {list === "outdated" && (
              <Segmented<number> value={threshold} onChange={setThreshold} options={THRESHOLDS.map((d) => ({ value: d, label: `${d} days` }))} />
            )}
          </Space>
          <Space wrap align="center">
            <Input.Search allowClear placeholder="Part of name or ID" style={{ width: 240 }} value={name} onChange={(e) => setName(e.target.value)} />
            <Select
              mode="multiple"
              allowClear
              showSearch={{ optionFilterProp: "label" }}
              placeholder="Project"
              style={{ minWidth: 220, maxWidth: 420 }}
              options={(data?.projects ?? []).map((p) => ({ value: p.id, label: `#${p.id} ${p.name}` }))}
              value={projectIds}
              onChange={setProjectIds}
              maxTagCount="responsive"
            />
            <Segmented<Automation>
              value={automation}
              onChange={setAutomation}
              options={[
                { value: "all", label: "All" },
                { value: "auto", label: "Automated" },
                { value: "manual", label: "Manual" },
              ]}
            />
            <Select
              mode="multiple"
              allowClear
              placeholder="Current status"
              style={{ minWidth: 200, maxWidth: 360 }}
              options={statusOptions}
              value={statuses}
              onChange={setStatuses}
              maxTagCount="responsive"
            />
          </Space>
        </Space>
      </Card>
      <Card size="small" title={`Set status: ${chosen.length} selected`}>
        <Space wrap align="center">
          <Button size="small" onClick={() => toggle([...visibleIds], true)}>
            Select all shown ({filtered.length})
          </Button>
          <Button size="small" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
            Clear selection
          </Button>
          <Select
            placeholder="Workflow"
            style={{ width: 220 }}
            loading={workflowsLoading}
            notFoundContent={workflowsLoading ? "Loading workflows…" : "No workflows"}
            options={(workflowList ?? []).map((w) => ({ value: w.id, label: w.name }))}
            value={workflowId ?? undefined}
            onChange={(id) => {
              setWorkflowId(id);
              setStatusId(null);
            }}
          />
          <Select
            placeholder="Status"
            style={{ width: 200 }}
            disabled={!workflow}
            options={(workflow?.statuses ?? []).map((s) => ({ value: s.id, label: s.name }))}
            value={statusId ?? undefined}
            onChange={setStatusId}
          />
          <Button type="primary" danger disabled={!workflow || !status || chosen.length === 0} loading={applying} onClick={apply}>
            Apply to {chosen.length}
          </Button>
        </Space>
        {workflowsError && (
          <Alert
            style={{ marginTop: 12 }}
            type="error"
            showIcon
            title={`Cannot load workflows: ${workflowsError}`}
            action={
              <Button size="small" onClick={loadWorkflows}>
                Retry
              </Button>
            }
          />
        )}
      </Card>
      {data?.failedProjects.length ? (
        <Alert type="warning" showIcon title={`Failed to load projects: ${data.failedProjects.map((f) => `#${f.id} (${f.error})`).join("; ")}`} />
      ) : null}
      <Space wrap>
        <Typography.Text type="secondary">{data ? `Test cases: ${filtered.length}` : ""}</Typography.Text>
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
      <Table<TreeRow<RunTestCase>>
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
        rowSelection={{
          checkStrictly: true,
          selectedRowKeys: rows.flatMap((g) =>
            g.kind === "group" ? g.children.filter((c) => c.kind === "item" && selected.has(c.item.id)).map((c) => c.key) : [],
          ),
          getCheckboxProps: (r) => ({ disabled: r.kind === "group" && r.items.length === 0 }),
          renderCell: (_, r, __, node) =>
            r.kind === "group" ? (
              <input
                type="checkbox"
                aria-label="Select the project's test cases"
                checked={r.items.every((tc) => selected.has(tc.id))}
                ref={(el) => {
                  if (el) el.indeterminate = r.items.some((tc) => selected.has(tc.id)) && !r.items.every((tc) => selected.has(tc.id));
                }}
                onChange={(e) =>
                  toggle(
                    r.items.map((tc) => tc.id),
                    e.target.checked,
                  )
                }
              />
            ) : (
              node
            ),
          onSelect: (r, on) => r.kind === "item" && toggle([r.item.id], on),
          hideSelectAll: true,
        }}
        locale={{ emptyText: <Empty description={data ? "No test cases in this list" : "Loading"} /> }}
      />
    </Space>
  );
}
