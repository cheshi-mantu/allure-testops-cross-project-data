import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, App as AntApp, Button, Card, Form, Input, Select, Space, Typography } from "antd";
import { api, type JiraProject, type PublicConfig } from "./api";

interface FormValues {
  jiraUrl: string;
  jiraEmail: string;
  jiraToken: string;
  jiraProjects: string[];
  jiraIssueTypes: string[];
}

export function JiraSettings({ config, onSaved }: { config: PublicConfig; onSaved: (c: PublicConfig) => void }) {
  const [form] = Form.useForm<FormValues>();
  const { message, modal } = AntApp.useApp();
  const [projects, setProjects] = useState<JiraProject[] | null>(null);
  const [user, setUser] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"connect" | "save" | null>(null);
  const selectedProjects = Form.useWatch("jiraProjects", form) ?? [];

  const connect = useCallback(async () => {
    const { jiraUrl, jiraEmail, jiraToken } = form.getFieldsValue();
    if (!jiraUrl || !jiraEmail || (!jiraToken && !config.jiraTokenSet)) {
      setError("Enter the Jira site, email and API token");
      return;
    }
    setBusy("connect");
    setError(null);
    try {
      const r = await api.jiraTest({ jiraUrl, jiraEmail, jiraToken: jiraToken ?? "" });
      setProjects(r.projects);
      setUser(r.user);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [form, config.jiraTokenSet]);

  // With stored credentials the project list is loaded right away.
  useEffect(() => {
    if (config.jiraUrl && config.jiraTokenSet) void connect();
  }, [config.jiraUrl, config.jiraTokenSet, connect]);

  const issueTypeOptions = useMemo(() => {
    const from = (projects ?? []).filter((p) => selectedProjects.length === 0 || selectedProjects.includes(p.key));
    const types = new Set([...from.flatMap((p) => p.issueTypes), ...config.jiraIssueTypes]);
    return [...types].sort().map((t) => ({ value: t, label: t }));
  }, [projects, selectedProjects, config.jiraIssueTypes]);

  const save = async (v: FormValues) => {
    setBusy("save");
    try {
      const saved = await api.saveJiraConfig({
        jiraUrl: v.jiraUrl,
        jiraEmail: v.jiraEmail,
        jiraToken: v.jiraToken ?? "",
        jiraProjects: v.jiraProjects ?? [],
        jiraIssueTypes: v.jiraIssueTypes ?? [],
      });
      form.setFieldValue("jiraToken", "");
      message.success("Jira settings saved");
      onSaved(saved);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = () =>
    modal.confirm({
      title: "Remove the Jira connection?",
      content: "The Jira site, credentials, projects and issue types are removed from the settings.",
      onOk: async () => {
        const saved = await api.saveJiraConfig({ jiraUrl: "", jiraEmail: "", jiraToken: "", jiraProjects: [], jiraIssueTypes: [] });
        form.resetFields();
        setProjects(null);
        setUser(null);
        onSaved(saved);
      },
    });

  return (
    <Card title="Jira Cloud" style={{ maxWidth: 720 }}>
      <Typography.Paragraph type="secondary">
        Used by the Jira coverage tab. Jira Cloud authenticates API tokens together with the email of their owner; create a token at id.atlassian.com
        → Security → API tokens. The token is stored like the Allure TestOps one and never sent back to the browser.
      </Typography.Paragraph>
      <Form<FormValues>
        form={form}
        layout="vertical"
        onFinish={save}
        initialValues={{
          jiraUrl: config.jiraUrl,
          jiraEmail: config.jiraEmail,
          jiraToken: "",
          jiraProjects: config.jiraProjects,
          jiraIssueTypes: config.jiraIssueTypes,
        }}
      >
        <Form.Item
          name="jiraUrl"
          label="Jira site"
          rules={[{ required: true, type: "url", message: "Enter a URL, e.g. https://your-site.atlassian.net" }]}
        >
          <Input placeholder="https://your-site.atlassian.net" />
        </Form.Item>
        <Form.Item name="jiraEmail" label="Email of the token owner" rules={[{ required: true, type: "email", message: "Enter an email" }]}>
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="jiraToken"
          label="API token"
          extra={config.jiraTokenSet ? `Token ${config.jiraTokenHint} is saved. Leave the field empty to keep it.` : undefined}
          rules={[{ required: !config.jiraTokenSet, message: "Enter a Jira API token" }]}
        >
          <Input.Password placeholder={config.jiraTokenSet ? "••••••••" : ""} autoComplete="off" />
        </Form.Item>
        <Space style={{ marginBottom: 16 }} wrap>
          <Button onClick={connect} loading={busy === "connect"}>
            {projects ? "Reload projects" : "Connect and load projects"}
          </Button>
          {user && <Typography.Text type="success">Connected as {user}</Typography.Text>}
        </Space>
        {error && <Alert style={{ marginBottom: 16 }} type="error" showIcon title={error} />}
        <Form.Item name="jiraProjects" label="Projects" rules={[{ required: true, type: "array", min: 1, message: "Choose at least one project" }]}>
          <Select
            mode="multiple"
            allowClear
            showSearch={{ optionFilterProp: "label" }}
            placeholder={projects ? "Choose projects" : "Connect to load projects"}
            options={(projects ?? config.jiraProjects.map((key) => ({ key, name: "", issueTypes: [] }))).map((p) => ({
              value: p.key,
              label: p.name ? `${p.key}: ${p.name}` : p.key,
            }))}
          />
        </Form.Item>
        <Form.Item
          name="jiraIssueTypes"
          label="Issue types taken into account"
          rules={[{ required: true, type: "array", min: 1, message: "Choose at least one issue type" }]}
        >
          <Select mode="multiple" allowClear placeholder="E.g. Epic, Feature, Story, Task, Bug" options={issueTypeOptions} />
        </Form.Item>
        <Space>
          <Button type="primary" htmlType="submit" loading={busy === "save"}>
            Save
          </Button>
          {config.jiraUrl && (
            <Button danger onClick={disconnect}>
              Remove Jira connection
            </Button>
          )}
        </Space>
      </Form>
    </Card>
  );
}
