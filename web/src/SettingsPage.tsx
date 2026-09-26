import { useState } from "react";
import { Alert, Button, Card, Form, Input, InputNumber, Space, Typography, message } from "antd";
import { api, REFRESH_SETTINGS, type PublicConfig, type RefreshKey } from "./api";

/** Refresh periods are edited in minutes. */
type FormValues = Record<RefreshKey, number> & {
  endpoint: string;
  token: string;
};

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
      const periods = Object.fromEntries(REFRESH_SETTINGS.map(({ key }) => [key, (v[key] ?? 0) * 60])) as Record<RefreshKey, number>;
      const saved = await api.saveConfig({ endpoint: v.endpoint, token: v.token ?? "", ...periods });
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
          ...Object.fromEntries(REFRESH_SETTINGS.map(({ key }) => [key, toMin(config[key])])),
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
        <Typography.Title level={5}>Auto refresh, minutes</Typography.Title>
        <Typography.Paragraph type="secondary">
          Per tab; 0 turns auto refresh off, leaving the Refresh button. Any refresh, automatic or manual, runs at most once per {minMin} min,
          and only while someone has the application open.
        </Typography.Paragraph>
        <Space size="large" wrap>
          {REFRESH_SETTINGS.map(({ key, label }) => (
            <Form.Item key={key} name={key} label={label} rules={[refreshRule]}>
              <InputNumber min={0} max={1440} addonAfter="min" style={{ width: 130 }} />
            </Form.Item>
          ))}
        </Space>
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
