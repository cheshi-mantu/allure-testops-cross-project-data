import { useEffect, useState } from "react";
import { Alert, Button, Space, Tooltip, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { Snapshot } from "./api";

const time = (ms: number) => new Date(ms).toLocaleTimeString("en-GB");

function useNow(periodMs: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), periodMs);
    return () => window.clearInterval(t);
  }, [periodMs]);
  return now;
}

export function RefreshBar<T>({
  snapshot,
  error,
  onRefresh,
}: {
  snapshot: Snapshot<T> | null;
  error: string | null;
  onRefresh: () => void;
}) {
  const now = useNow(1000);
  const wait = snapshot ? Math.max(0, Math.ceil((snapshot.nextRefreshAllowedAt - now) / 1000)) : 0;
  const refreshing = snapshot?.refreshing ?? true;

  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <Space wrap>
        <Tooltip title={wait > 0 && !refreshing ? "Refresh is allowed once a minute" : undefined}>
          <Button icon={<ReloadOutlined />} onClick={onRefresh} loading={refreshing} disabled={wait > 0 && !refreshing}>
            {refreshing ? "Refreshing" : wait > 0 ? `Refresh in ${wait}s` : "Refresh"}
          </Button>
        </Tooltip>
        <Typography.Text type="secondary">
          {snapshot?.fetchedAt ? `Data as of ${time(snapshot.fetchedAt)}` : "No data yet"}
          {snapshot?.nextAutoRefreshAt
            ? ` · auto refresh after ${time(Math.max(snapshot.nextAutoRefreshAt, snapshot.fetchedAt ?? 0))}`
            : " · auto refresh is off"}
        </Typography.Text>
        {refreshing && snapshot?.progress && <Typography.Text type="secondary">{snapshot.progress}</Typography.Text>}
      </Space>
      {(error || snapshot?.error) && (
        <Alert type="error" showIcon title={error ?? `Last refresh failed: ${snapshot?.error}`} />
      )}
    </Space>
  );
}
