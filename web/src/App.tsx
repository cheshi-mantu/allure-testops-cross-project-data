import { useEffect, useState } from "react";
import { Alert, Layout, Spin, Tabs, Typography } from "antd";
import { api, type PublicConfig } from "./api";
import { DefectsPage } from "./DefectsPage";
import { LaunchesPage } from "./LaunchesPage";
import { SettingsPage } from "./SettingsPage";

type TabKey = "launches" | "defects" | "settings";

export function App() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("launches");
  // Remounting the data pages after a connection change drops stale state.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    api
      .getConfig()
      .then((c) => {
        setConfig(c);
        if (!c.tokenSet || !c.endpoint) setTab("settings");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const configured = Boolean(config?.endpoint && config.tokenSet);

  const onSaved = (next: PublicConfig) => {
    const reconnect = !configured || next.endpoint !== config?.endpoint || next.tokenHint !== config?.tokenHint;
    setConfig(next);
    if (reconnect) {
      setGeneration((g) => g + 1);
      setTab("launches");
    }
  };

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Layout.Header style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Typography.Title level={4} style={{ color: "#fff", margin: 0 }}>
          Allure TestOps Analytics
        </Typography.Title>
        {config?.endpoint && <Typography.Text style={{ color: "rgba(255,255,255,0.65)" }}>{config.endpoint}</Typography.Text>}
      </Layout.Header>
      <Layout.Content style={{ padding: "8px 24px 24px" }}>
        {error && <Alert type="error" showIcon title={`Application server is unavailable: ${error}`} />}
        {!config && !error && <Spin style={{ marginTop: 48, width: "100%" }} />}
        {config && (
          <Tabs
            activeKey={tab}
            onChange={(k) => setTab(k as TabKey)}
            destroyOnHidden={false}
            items={[
              {
                key: "launches",
                label: "Launches",
                disabled: !configured,
                children: configured && <LaunchesPage key={generation} />,
              },
              {
                key: "defects",
                label: "Defects",
                disabled: !configured,
                children: configured && <DefectsPage key={generation} />,
              },
              {
                key: "settings",
                label: "Settings",
                children: <SettingsPage key={generation} config={config} onSaved={onSaved} />,
              },
            ]}
          />
        )}
      </Layout.Content>
    </Layout>
  );
}
