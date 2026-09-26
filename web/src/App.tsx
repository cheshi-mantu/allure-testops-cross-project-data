import { lazy, Suspense, useEffect, useState } from "react";
import { Alert, Layout, Spin, Tabs, Typography } from "antd";
import { api, type PublicConfig } from "./api";
import { DefectsPage } from "./DefectsPage";
import { OutdatedPage } from "./OutdatedPage";
import { LaunchesPage } from "./LaunchesPage";
import { SettingsPage } from "./SettingsPage";
import { TestCasesPage } from "./TestCasesPage";

// The chart library is loaded only when the map tab is opened.
const TestCaseMapPage = lazy(() => import("./TestCaseMapPage").then((m) => ({ default: m.TestCaseMapPage })));
const TrendPage = lazy(() => import("./TrendPage").then((m) => ({ default: m.TrendPage })));

type TabKey = "launches" | "defects" | "testcases" | "testcasemap" | "trend" | "outdated" | "settings";

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
                key: "testcases",
                label: "Test cases",
                disabled: !configured,
                children: configured && <TestCasesPage key={generation} />,
              },
              {
                key: "testcasemap",
                label: "Test case map",
                disabled: !configured,
                children: configured && (
                  <Suspense fallback={<Spin style={{ marginTop: 48, width: "100%" }} />}>
                    <TestCaseMapPage key={generation} />
                  </Suspense>
                ),
              },
              {
                key: "trend",
                label: "Automation trend",
                disabled: !configured,
                children: configured && (
                  <Suspense fallback={<Spin style={{ marginTop: 48, width: "100%" }} />}>
                    <TrendPage key={generation} />
                  </Suspense>
                ),
              },
              {
                key: "outdated",
                label: "Outdated",
                disabled: !configured,
                children: configured && <OutdatedPage key={generation} />,
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
