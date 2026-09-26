import { useState } from "react";
import { Card, Empty, Segmented, Space, Typography } from "antd";
import { api, type TestCasesData } from "./api";
import { GroupChart, type ChartColor, type ChartKind } from "./GroupChart";
import { RefreshBar } from "./RefreshBar";
import { AutomationCounts, useTestCaseQuery } from "./testCaseQuery";
import { useDataset } from "./useDataset";

/** Test cases as a sunburst or treemap over the chosen grouping. */
export function TestCaseMapPage() {
  const { snapshot, error, requestRefresh } = useDataset(api.testCases, api.refreshTestCases);
  const data: TestCasesData | null = snapshot?.data ?? null;
  const { testCases, filtered, grouping, rows, share, controls } = useTestCaseQuery(data, ["project", "automation"]);
  const [kind, setKind] = useState<ChartKind>("sunburst");
  const [color, setColor] = useState<ChartColor>("automation");

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <RefreshBar snapshot={snapshot} error={error} onRefresh={() => requestRefresh()} />
      {controls}
      <Space wrap>
        <Typography.Text type="secondary">{data ? `Test cases: ${filtered.length} of ${testCases.length}` : ""}</Typography.Text>
        {data && <AutomationCounts items={filtered} />}
        <Segmented<ChartKind>
          size="small"
          value={kind}
          onChange={setKind}
          options={[
            { value: "sunburst", label: "Sunburst" },
            { value: "treemap", label: "Treemap" },
          ]}
        />
        <Typography.Text type="secondary">Colour:</Typography.Text>
        <Segmented<ChartColor>
          size="small"
          value={color}
          onChange={setColor}
          options={[
            { value: "automation", label: "Automation share" },
            { value: "groups", label: "Groups" },
          ]}
        />
      </Space>
      {!data ? (
        <Card size="small" loading />
      ) : grouping.length === 0 ? (
        <Empty description="Choose at least one grouping level to see the chart" />
      ) : (
        <Card size="small">
          <GroupChart rows={rows} share={share} total={filtered.length} kind={kind} color={color} levels={grouping.length} />
          <Typography.Text type="secondary">
            Click a segment to zoom into it{kind === "sunburst" ? ", the centre to go back" : ", the path below to go back"}.
            {color === "automation" ? " Colour shows the automated share: red is manual, green is automated, grey is unknown." : ""} A test case with
            several values on a level is split between their groups, so segment sizes add up.
          </Typography.Text>
        </Card>
      )}
    </Space>
  );
}
