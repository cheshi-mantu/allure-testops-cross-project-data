import { useMemo, useState } from "react";
import { Alert, Badge, Button, Card, Empty, Input, Segmented, Select, Space, Switch, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { api, type Defect, type DefectMatcher, type DefectsData } from "./api";
import { isActive, matcherKey, matcherLabel, selectedMatchers, sharedKeys, type RegexFilter, type RegexScope } from "./matchers";
import { RefreshBar } from "./RefreshBar";
import { TreeCell } from "./TreeCell";
import { buildTree, itemSorter, type Grouper, type TreeRow } from "./tree";
import { useDataset } from "./useDataset";
import { resizableComponents, useColumnWidths } from "./useColumnWidths";
import { useExpanded } from "./useExpanded";

type GroupId = "project" | "status" | "issue" | "author" | RegexScope;
type Status = "all" | "open" | "closed";

const NONE = "";
const NO_ISSUE = "(no issue)";
const NO_AUTHOR = "(creator unknown)";
const NO_REGEX = "(no regex)";

const issueKey = (d: Defect) => d.issues[0]?.name ?? NONE;
const author = (d: Defect) => d.createdBy ?? NONE;
const sortLast = (v: string) => (v === NONE ? "￿" : v.toLowerCase());

const GROUP_TITLES: Record<GroupId, string> = {
  project: "Project",
  status: "Status",
  issue: "Issue tracker task",
  author: "Creator",
  matcher: "Matcher (message + trace regex)",
  message: "Message regex",
  trace: "Trace regex",
};

const REGEX_SCOPES: { value: RegexScope; label: string }[] = [
  { value: "matcher", label: "Message + trace" },
  { value: "message", label: "Message" },
  { value: "trace", label: "Trace" },
];

function MatcherList({ matchers }: { matchers: DefectMatcher[] | null }) {
  if (matchers === null) {
    return (
      <Tooltip title="Matchers could not be loaded">
        <Typography.Text type="secondary">?</Typography.Text>
      </Tooltip>
    );
  }
  const line = (kind: string, regex: string | null) =>
    regex && (
      <div>
        <Typography.Text type="secondary">{kind} </Typography.Text>
        <Typography.Text code>{regex}</Typography.Text>
      </div>
    );
  return (
    <>
      {matchers.map((m, i) => (
        <div key={m.id}>
          {i > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              or
            </Typography.Text>
          )}
          <div style={{ borderLeft: "2px solid rgba(5, 5, 5, 0.15)", paddingLeft: 8 }}>
            {line("message", m.messageRegex)}
            {line("trace", m.traceRegex)}
          </div>
        </div>
      ))}
    </>
  );
}

const REGEX_GROUP: Record<string, true> = { matcher: true, message: true, trace: true };

const sum = (items: Defect[], pick: (d: Defect) => number | null) => {
  let total = 0;
  let known = false;
  for (const d of items) {
    const v = pick(d);
    if (v !== null) {
      total += v;
      known = true;
    }
  }
  return known ? total : null;
};

export function DefectsPage() {
  const { snapshot, error, requestRefresh } = useDataset(api.defects, api.refreshDefects);
  const data: DefectsData | null = snapshot?.data ?? null;

  const [grouping, setGrouping] = useState<GroupId[]>(["project", "status"]);
  const [status, setStatus] = useState<Status>("all");
  const [authors, setAuthors] = useState<string[]>([]);
  const [issues, setIssues] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [regexText, setRegexText] = useState("");
  const [regexScope, setRegexScope] = useState<RegexScope>("matcher");
  const [sharedOnly, setSharedOnly] = useState(false);

  const regexFilter = useMemo<RegexFilter>(
    () => ({
      scope: regexScope,
      needle: regexText.trim().toLowerCase(),
      shared: sharedOnly ? sharedKeys(data?.defects ?? [], regexScope) : null,
    }),
    [data, regexScope, regexText, sharedOnly],
  );

  const toggleShared = (on: boolean) => {
    setSharedOnly(on);
    // The point of the switch is to line up the same regex across projects.
    if (on) setGrouping([regexScope, "project"]);
  };

  const creators = useMemo(() => {
    const defects = data?.defects ?? [];
    return {
      fromMatcher: defects.filter((d) => d.creatorSource === "matcher").length,
      unknown: defects.filter((d) => d.createdBy === null).length,
    };
  }, [data]);

  const options = useMemo(() => {
    const a = new Set<string>();
    const i = new Set<string>();
    for (const d of data?.defects ?? []) {
      a.add(author(d));
      i.add(issueKey(d));
    }
    const list = (s: Set<string>, empty: string) =>
      [...s].sort((x, y) => sortLast(x).localeCompare(sortLast(y), "en")).map((v) => ({ value: v, label: v || empty }));
    return { authors: list(a, NO_AUTHOR), issues: list(i, NO_ISSUE) };
  }, [data]);

  const filtered = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return (data?.defects ?? []).filter(
      (d) =>
        (status === "all" || d.closed === (status === "closed")) &&
        (authors.length === 0 || authors.includes(author(d))) &&
        (issues.length === 0 || issues.includes(issueKey(d))) &&
        (!needle || d.name.toLowerCase().includes(needle) || String(d.id) === needle) &&
        (!isActive(regexFilter) || selectedMatchers(d, regexFilter).length > 0),
    );
  }, [data, status, authors, issues, text, regexFilter]);

  const rows = useMemo(() => {
    const projects = new Map((data?.projects ?? []).map((p) => [p.id, p.name]));
    const byRegex = (scope: RegexScope): Grouper<Defect> => ({
      id: scope,
      title: GROUP_TITLES[scope],
      // Only the matchers that passed the regex filter form groups.
      of: (d) => {
        const values = selectedMatchers(d, regexFilter).flatMap((m) => {
          const key = matcherKey(m, scope);
          return key === null ? [] : [{ key, label: matcherLabel(m, scope), sort: key }];
        });
        return values.length > 0 ? values : { key: NONE, label: NO_REGEX, sort: "\uffff" };
      },
    });
    const all: Record<GroupId, Grouper<Defect>> = {
      matcher: byRegex("matcher"),
      message: byRegex("message"),
      trace: byRegex("trace"),
      project: {
        id: "project",
        title: GROUP_TITLES.project,
        of: (d) => ({ key: String(d.projectId), label: `#${d.projectId} ${projects.get(d.projectId) ?? ""}`, sort: d.projectId }),
      },
      status: {
        id: "status",
        title: GROUP_TITLES.status,
        of: (d) => ({ key: d.closed ? "closed" : "open", label: d.closed ? "Closed" : "Open", sort: d.closed ? 1 : 0 }),
      },
      issue: {
        id: "issue",
        title: GROUP_TITLES.issue,
        of: (d) => ({ key: issueKey(d), label: issueKey(d) || NO_ISSUE, sort: sortLast(issueKey(d)) }),
      },
      author: {
        id: "author",
        title: GROUP_TITLES.author,
        of: (d) => ({ key: author(d), label: author(d) || NO_AUTHOR, sort: sortLast(author(d)) }),
      },
    };
    return buildTree(
      filtered,
      grouping.map((g) => all[g]),
      (d) => String(d.id),
    );
  }, [data, filtered, grouping, regexFilter]);

  const { expanded, onExpand, expandAll, collapseAll } = useExpanded(rows);
  const expandedSet = useMemo(() => new Set(expanded), [expanded]);
  const endpoint = data?.endpoint ?? "";

  const counter = (pick: (d: Defect) => number | null) => (_: unknown, r: TreeRow<Defect>) => {
    if (r.kind === "item") return pick(r.item) ?? "—";
    const total = sum(r.items, pick);
    return total === null ? null : (
      <Tooltip title="Sum over the defects of the group">
        <Typography.Text type="secondary">Σ {total}</Typography.Text>
      </Tooltip>
    );
  };
  const groupSpan = (r: TreeRow<Defect>) => ({ colSpan: r.kind === "group" ? 0 : 1 });

  const columns: ColumnsType<TreeRow<Defect>> = [
    {
      title: "Defect",
      key: "name",
      width: 320,
      sorter: itemSorter((d) => d.name),
      sortDirections: ["ascend", "descend"],
      onCell: (r) => ({ colSpan: r.kind === "group" ? 6 : 1 }),
      render: (_, r) => (
        <TreeCell row={r} expanded={expandedSet.has(r.key)} onToggle={() => onExpand(!expandedSet.has(r.key), r)}>
          {r.kind === "group" ? (
            <Space wrap size={[8, 0]}>
              <Typography.Text type="secondary">{r.groupTitle}:</Typography.Text>
              {r.groupId === "project" ? (
                <Typography.Link strong href={`${endpoint}/project/${r.items[0].projectId}/defects`} target="_blank">
                  {r.label}
                </Typography.Link>
              ) : (
                <Typography.Text strong code={r.groupId in REGEX_GROUP && r.label !== NO_REGEX}>
                  {r.label}
                </Typography.Text>
              )}
              <Badge count={r.items.length} showZero color="blue" overflowCount={99999} />
              {r.groupId !== "project" && r.groupId !== "status" && (
                <Typography.Text type="secondary">in {new Set(r.items.map((d) => d.projectId)).size} project(s)</Typography.Text>
              )}
            </Space>
          ) : (
            <Typography.Link href={`${endpoint}/project/${r.item.projectId}/defects/${r.item.id}`} target="_blank">
              {r.item.name}
            </Typography.Link>
          )}
        </TreeCell>
      ),
    },
    {
      title: "ID",
      key: "id",
      width: 80,
      sorter: itemSorter((d) => d.id),
      sortDirections: ["ascend", "descend"],
      onCell: groupSpan,
      render: (_, r) => (r.kind === "item" ? r.item.id : null),
    },
    {
      title: "Status",
      key: "status",
      width: 100,
      onCell: groupSpan,
      render: (_, r) => r.kind === "item" && (r.item.closed ? <Tag>Closed</Tag> : <Tag color="red">Open</Tag>),
    },
    {
      title: "Issue",
      key: "issue",
      sorter: itemSorter((d) => d.issues[0]?.name ?? null),
      sortDirections: ["ascend", "descend"],
      width: 160,
      onCell: groupSpan,
      render: (_, r) =>
        r.kind === "item" &&
        r.item.issues.map((i) =>
          i.url ? (
            <Typography.Link key={i.name} href={i.url} target="_blank">
              {i.name}
            </Typography.Link>
          ) : (
            <span key={i.name}>{i.name}</span>
          ),
        ),
    },
    {
      title: "Creator",
      key: "author",
      width: 170,
      onCell: groupSpan,
      render: (_, r) =>
        r.kind === "item" &&
        (r.item.creatorSource === "matcher" ? (
          <Tooltip title="Author of the defect's first matcher; the API does not expose the defect creator">
            <Typography.Text>{r.item.createdBy}</Typography.Text> <Typography.Text type="secondary">(matcher)</Typography.Text>
          </Tooltip>
        ) : (
          r.item.createdBy
        )),
    },
    {
      title: "Matchers",
      key: "matchers",
      width: 380,
      onCell: groupSpan,
      render: (_, r) => r.kind === "item" && <MatcherList matchers={r.item.matchers} />,
    },
    { title: "Test cases", key: "tc", width: 110, align: "right", render: counter((d) => d.testCases) },
    { title: "Test results", key: "tr", width: 110, align: "right", render: counter((d) => d.testResults) },
    { title: "Launches", key: "launches", width: 90, align: "right", render: counter((d) => d.launches) },
  ];

  const sized = useColumnWidths("defects", columns);

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <RefreshBar snapshot={snapshot} error={error} onRefresh={() => requestRefresh()} />
      <Card size="small">
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Space wrap align="center">
            <Typography.Text>Group by:</Typography.Text>
            <Select<GroupId[]>
              mode="multiple"
              style={{ minWidth: 360 }}
              placeholder="No grouping"
              value={grouping}
              onChange={setGrouping}
              options={(Object.keys(GROUP_TITLES) as GroupId[]).map((g) => ({ value: g, label: GROUP_TITLES[g] }))}
            />
            <Typography.Text type="secondary">levels follow the selection order</Typography.Text>
          </Space>
          <Space wrap align="center">
            <Segmented<Status>
              value={status}
              onChange={setStatus}
              options={[
                { value: "all", label: "All" },
                { value: "open", label: "Open" },
                { value: "closed", label: "Closed" },
              ]}
            />
            <Select
              mode="multiple"
              allowClear
              showSearch
              placeholder="Creator"
              style={{ minWidth: 200, maxWidth: 360 }}
              options={options.authors}
              value={authors}
              onChange={setAuthors}
              maxTagCount="responsive"
            />
            <Select
              mode="multiple"
              allowClear
              showSearch
              placeholder="Issue tracker task"
              style={{ minWidth: 220, maxWidth: 400 }}
              options={options.issues}
              value={issues}
              onChange={setIssues}
              maxTagCount="responsive"
            />
            <Input.Search allowClear placeholder="Defect name or ID" style={{ width: 220 }} value={text} onChange={(e) => setText(e.target.value)} />
          </Space>
          <Space wrap align="center">
            <Typography.Text>Matcher regex:</Typography.Text>
            <Segmented<RegexScope> value={regexScope} onChange={setRegexScope} options={REGEX_SCOPES} />
            <Input.Search
              allowClear
              placeholder="Regex text contains"
              style={{ width: 280 }}
              value={regexText}
              onChange={(e) => setRegexText(e.target.value)}
            />
            <Tooltip title="Keep only regexes (in the selected part) that defects of two or more projects use. Comparison ignores case and surrounding spaces.">
              <Space>
                <Switch checked={sharedOnly} onChange={toggleShared} />
                <Typography.Text>Shared by several projects</Typography.Text>
              </Space>
            </Tooltip>
          </Space>
        </Space>
      </Card>
      {data && (creators.fromMatcher > 0 || creators.unknown > 0) && (
        <Alert
          type={creators.unknown > 0 ? "warning" : "info"}
          showIcon
          title={
            "Allure TestOps does not expose the defect creator via API, so the author of the defect's first matcher is taken as its creator" +
            ` (${creators.fromMatcher} defect(s), marked “matcher”).` +
            (creators.unknown > 0 ? ` ${creators.unknown} defect(s) without matchers stay under “creator unknown”.` : "")
          }
        />
      )}
      {data && data.defects.some((d) => d.matchers === null) && (
        <Typography.Text type="warning">
          Matchers could not be loaded for {data.defects.filter((d) => d.matchers === null).length} defect(s).
        </Typography.Text>
      )}
      {data?.failedProjects.length ? (
        <Typography.Text type="warning">
          Failed to load projects: {data.failedProjects.map((f) => `#${f.id} (${f.error})`).join("; ")}
        </Typography.Text>
      ) : null}
      <Space>
        <Typography.Text type="secondary">
          {data ? `Defects: ${filtered.length} of ${data.defects.length}, projects total: ${data.projects.length}` : ""}
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
      <Table<TreeRow<Defect>>
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
        locale={{ emptyText: <Empty description={data ? "No defects found" : "Loading"} /> }}
      />
    </Space>
  );
}
