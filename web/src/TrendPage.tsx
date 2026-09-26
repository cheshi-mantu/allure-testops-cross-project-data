import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Card, Empty, Segmented, Select, Space, Typography } from "antd";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { api, type HistoryData } from "./api";
import { RefreshBar } from "./RefreshBar";
import { buildTrend, earliest } from "./trend";
import { useDataset } from "./useDataset";

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, DataZoomComponent, CanvasRenderer]);

type Range = "30" | "90" | "180" | "365" | "all";
type Mode = "total" | "projects";

const DAY = 86_400_000;

function useChart(option: echarts.EChartsCoreOption | null) {
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
    if (chart.current && option) chart.current.setOption(option, true);
  }, [option]);
  return el;
}

export function TrendPage() {
  const { snapshot, error, requestRefresh } = useDataset(api.history, api.refreshHistory);
  const data: HistoryData | null = snapshot?.data ?? null;
  const [projectIds, setProjectIds] = useState<number[]>([]);
  const [range, setRange] = useState<Range>("180");
  const [mode, setMode] = useState<Mode>("total");

  const projectOptions = useMemo(() => {
    const counts = new Map<number, number>();
    for (const tc of data?.testCases ?? []) counts.set(tc.projectId, (counts.get(tc.projectId) ?? 0) + 1);
    return (data?.projects ?? []).filter((p) => counts.has(p.id)).map((p) => ({ value: p.id, label: `#${p.id} ${p.name}` }));
  }, [data]);

  const option = useMemo((): echarts.EChartsCoreOption | null => {
    if (!data) return null;
    const selected = projectIds.length > 0 ? data.testCases.filter((tc) => projectIds.includes(tc.projectId)) : data.testCases;
    const from = range === "all" ? earliest(selected) : Date.now() - (Number(range) - 1) * DAY;
    const common = {
      tooltip: { trigger: "axis" },
      legend: { top: 0 },
      grid: { left: 56, right: 56, top: 40, bottom: 70 },
      dataZoom: [{ type: "inside" }, { type: "slider", bottom: 16 }],
    };

    if (mode === "total") {
      const t = buildTrend(selected, from);
      return {
        ...common,
        xAxis: { type: "category", data: t.days, boundaryGap: false },
        yAxis: [
          { type: "value", name: "Test cases", minInterval: 1 },
          { type: "value", name: "Automated, %", min: 0, max: 100, splitLine: { show: false } },
        ],
        series: [
          { name: "Automated", type: "line", stack: "count", areaStyle: {}, symbol: "none", color: "#52c41a", data: t.automated },
          { name: "Manual", type: "line", stack: "count", areaStyle: {}, symbol: "none", color: "#faad14", data: t.manual },
          { name: "Automated, %", type: "line", yAxisIndex: 1, symbol: "none", color: "#1677ff", lineStyle: { width: 2 }, data: t.percent },
        ],
      };
    }

    const projects = new Map(data.projects.map((p) => [p.id, p.name]));
    const ids = [...new Set(selected.map((tc) => tc.projectId))].sort((a, b) => a - b);
    let days: string[] = [];
    const series = ids.map((id) => {
      const t = buildTrend(
        selected.filter((tc) => tc.projectId === id),
        from,
      );
      days = t.days;
      return { name: `#${id} ${projects.get(id) ?? ""}`, type: "line", symbol: "none", connectNulls: true, data: t.percent };
    });
    return {
      ...common,
      tooltip: { trigger: "axis", valueFormatter: (v: unknown) => (v === null || v === undefined ? "–" : `${v}%`) },
      legend: { top: 0, type: "scroll" },
      xAxis: { type: "category", data: days, boundaryGap: false },
      yAxis: { type: "value", name: "Automated, %", min: 0, max: 100 },
      series,
    };
  }, [data, projectIds, range, mode]);

  const el = useChart(option);

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <RefreshBar snapshot={snapshot} error={error} onRefresh={() => requestRefresh()} />
      {data && (
        <Typography.Text type="secondary">
          Last update: change logs loaded for {data.sync.changeLogsLoaded} test case(s)
          {data.sync.changeLogsPending > 0 ? `, ${data.sync.changeLogsPending} still to load` : ""}
          {data.sync.changeLogsFailed > 0 ? `, ${data.sync.changeLogsFailed} failed and will be retried` : ""}, {data.sync.disappeared} deleted for good
          noticed. Test cases tracked: {data.testCases.length}.
        </Typography.Text>
      )}
      <Card size="small">
        <Space wrap align="center">
          <Select
            mode="multiple"
            allowClear
            showSearch={{ optionFilterProp: "label" }}
            placeholder="All projects"
            style={{ minWidth: 260, maxWidth: 520 }}
            options={projectOptions}
            value={projectIds}
            onChange={setProjectIds}
            maxTagCount="responsive"
          />
          <Segmented<Range>
            value={range}
            onChange={setRange}
            options={[
              { value: "30", label: "30 days" },
              { value: "90", label: "90 days" },
              { value: "180", label: "180 days" },
              { value: "365", label: "1 year" },
              { value: "all", label: "All" },
            ]}
          />
          <Segmented<Mode>
            value={mode}
            onChange={setMode}
            options={[
              { value: "total", label: "Automated and manual" },
              { value: "projects", label: "Compare projects, %" },
            ]}
          />
        </Space>
      </Card>
      {data?.failedProjects.length ? (
        <Alert type="warning" showIcon title={`Failed to load projects: ${data.failedProjects.map((f) => `#${f.id} (${f.error})`).join("; ")}`} />
      ) : null}
      <Card size="small">
        {!data && <Empty description="Loading" />}
        <div ref={el} style={{ width: "100%", height: data ? 520 : 0 }} />
        <Typography.Text type="secondary">
          Counts are taken at the end of each day and include test cases that existed then, deleted ones up to their deletion. Before the first
          entry of its change log a test case is taken to be in its first recorded state.
        </Typography.Text>
      </Card>
    </Space>
  );
}
