import { useState } from "react";
import { Alert, Button, Card, Form, Input, InputNumber, Space, Typography, message } from "antd";
import { api, type PublicConfig } from "./api";

interface FormValues {
  endpoint: string;
  token: string;
  launchesRefreshMin: number;
  defectsRefreshMin: number;
}

const toMin = (sec: number) => Math.round(sec / 60);

export function SettingsPage({ config, onSaved }: { config: PublicConfig; onSaved: (c: PublicConfig) => void }) {
  const [form] = Form.useForm<FormValues>();
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [msg, holder] = message.useMessage();
  const minMin = toMin(config.minRefreshSec);

  const test = async () => {
    const { endpoint, token } = await form.validateFields(["endpoint", "token"]);
    setBusy("test");
    try {
      const r = await api.testConfig({ endpoint, token: token ?? "" });
      msg.success(`Connection works, projects available: ${r.projects}`);
    } catch (e) {
      msg.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async (v: FormValues) => {
    setBusy("save");
    try {
      const saved = await api.saveConfig({
        endpoint: v.endpoint,
        token: v.token ?? "",
        launchesRefreshSec: (v.launchesRefreshMin ?? 0) * 60,
        defectsRefreshSec: (v.defectsRefreshMin ?? 0) * 60,
      });
      form.setFieldValue("token", "");
      msg.success("Settings saved");
      onSaved(saved);
    } catch (e) {
      msg.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const refreshRule = { type: "number" as const, validator: async (_: unknown, v: number | null) => {
    if (v && v > 0 && v < minMin) throw new Error(`At most once per ${minMin} min, 0 turns it off`);
  } };

  return (
    <Card title="Allure TestOps connection" style={{ maxWidth: 720 }}>
      {holder}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        title="Settings are stored inside the container and live as long as the container does. The token is never sent back to the browser."
      />
      <Form<FormValues>
        form={form}
        layout="vertical"
        onFinish={save}
        initialValues={{
          endpoint: config.endpoint,
          token: "",
          launchesRefreshMin: toMin(config.launchesRefreshSec),
          defectsRefreshMin: toMin(config.defectsRefreshSec),
        }}
      >
        <Form.Item
          name="endpoint"
          label="Allure TestOps endpoint"
          rules={[{ required: true, type: "url", message: "Enter a URL, e.g. https://testops.example.com" }]}
        >
          <Input placeholder="https://testops.example.com" />
        </Form.Item>
        <Form.Item
          name="token"
          label="API token"
          extra={config.tokenSet ? `Token ${config.tokenHint} is saved. Leave the field empty to keep it.` : "Allure TestOps user profile → API tokens"}
          rules={[{ required: !config.tokenSet, message: "Enter an API token" }]}
        >
          <Input.Password placeholder={config.tokenSet ? "••••••••" : ""} autoComplete="off" />
        </Form.Item>
        <Space size="large" wrap>
          <Form.Item name="launchesRefreshMin" label="Launches auto refresh, min" rules={[refreshRule]} extra="0 turns it off">
            <InputNumber min={0} max={1440} />
          </Form.Item>
          <Form.Item name="defectsRefreshMin" label="Defects auto refresh, min" rules={[refreshRule]} extra="0 turns it off">
            <InputNumber min={0} max={1440} />
          </Form.Item>
        </Space>
        <Typography.Paragraph type="secondary">
          Any refresh, automatic or manual, runs at most once per {minMin} min.
        </Typography.Paragraph>
        <Space>
          <Button onClick={test} loading={busy === "test"}>
            Test connection
          </Button>
          <Button type="primary" htmlType="submit" loading={busy === "save"}>
            Save
          </Button>
        </Space>
      </Form>
    </Card>
  );
}
