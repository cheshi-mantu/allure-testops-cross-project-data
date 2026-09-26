import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Card, Input, Segmented, Select, Space, Tag, Tooltip, Typography } from "antd";
import type { TestCase, TestCasesData } from "./api";
import { DimensionFilters, matchesFilters, NONE, toGrouper, valueOptions, type Dimension, type DimensionFilter } from "./dimensions";
import { buildTree, type TreeRow } from "./tree";

export const MAX_GROUP_LEVELS = 6;

type TagMode = "any" | "all";

const byName = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });
const unique = (values: string[]) => [...new Set(values)].map((v) => ({ key: v, label: v }));

/** Project, layer, issue and tag, then one dimension per member role and per custom field found in the data. */
export function buildDimensions(data: TestCasesData | null): Dimension<TestCase>[] {
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
    ...[...roles].sort(byName).map((role): Dimension<TestCase> => ({
      id: `role:${role}`,
      title: role || "(no role)",
      values: (tc) => unique(tc.members.filter((m) => m.role === role).map((m) => m.name)),
    })),
    ...[...fields].sort(byName).map((field): Dimension<TestCase> => ({
      id: `cf:${field}`,
      title: field,
      values: (tc) => unique(tc.customFields.find((f) => f.name === field)?.values ?? []),
    })),
  ];
}

/** Automated and manual test case counters; unknown ones only when present. */
export function AutomationCounts({ items }: { items: TestCase[] }) {
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

export interface TestCaseQuery {
  testCases: TestCase[];
  filtered: TestCase[];
  grouping: string[];
  rows: TreeRow<TestCase>[];
  /** Part of a test case in its group at a depth, see `share` below. */
  share: (tc: TestCase, depth: number) => number;
  /** Grouping and filter controls. */
  controls: ReactNode;
}

/** Grouping and filtering state of test cases, shared by the table and the chart tabs. */
export function useTestCaseQuery(data: TestCasesData | null, defaultGrouping: string[]): TestCaseQuery {
  const [grouping, setGrouping] = useState<string[]>(defaultGrouping);
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

  // Part of a test case in its group at a depth: split evenly between the
  // values it has on each level down to that depth.
  const share = useCallback(
    (tc: TestCase, depth: number) => {
      let part = 1;
      for (let level = 0; level <= depth && level < grouping.length; level++) {
        const d = byId.get(grouping[level]);
        if (d) part /= Math.max(1, d.values(tc).length);
      }
      return part;
    },
    [grouping, byId],
  );

  const controls = (
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
  );

  return { testCases, filtered, grouping, rows, share, controls };
}
