import { Button, Select, Space } from "antd";
import { CloseOutlined, PlusOutlined } from "@ant-design/icons";
import type { Grouper } from "./tree";

/** Key used for items without any value in a dimension. */
export const NONE = "";

export interface DimensionValue {
  key: string;
  label: string;
}

/** Something items can be grouped and filtered by; an item may have several values. */
export interface Dimension<T> {
  id: string;
  title: string;
  values: (item: T) => DimensionValue[];
  /** Sort key of a group; defaults to the lower-cased label. */
  sort?: (value: DimensionValue) => string | number;
}

const noneLabel = (d: { title: string }) => `(no ${d.title.toLowerCase()})`;

export function toGrouper<T>(d: Dimension<T>): Grouper<T> {
  return {
    id: d.id,
    title: d.title,
    of: (item) => {
      const values = d.values(item);
      if (values.length === 0) return { key: NONE, label: noneLabel(d), sort: "￿" };
      return values.map((v) => ({ key: v.key, label: v.label, sort: d.sort?.(v) ?? v.label.toLowerCase() }));
    },
  };
}

export interface DimensionFilter {
  dimension: string;
  /** Selected value keys; NONE selects items without a value. Empty means no restriction. */
  values: string[];
}

/** Every filter must match; inside a filter any selected value is enough. */
export function matchesFilters<T>(item: T, filters: DimensionFilter[], dimensions: Map<string, Dimension<T>>): boolean {
  return filters.every((f) => {
    const d = dimensions.get(f.dimension);
    if (!d || f.values.length === 0) return true;
    const own = d.values(item);
    if (own.length === 0) return f.values.includes(NONE);
    return own.some((v) => f.values.includes(v.key));
  });
}

/** Value options of a dimension with item counts, "none" first. */
export function valueOptions<T>(items: T[], d: Dimension<T>) {
  const counts = new Map<string, { label: string; count: number }>();
  let none = 0;
  for (const item of items) {
    const values = d.values(item);
    if (values.length === 0) none++;
    for (const v of values) {
      const c = counts.get(v.key);
      if (c) c.count++;
      else counts.set(v.key, { label: v.label, count: 1 });
    }
  }
  const options = [...counts]
    .sort(([, a], [, b]) => a.label.localeCompare(b.label, "en", { numeric: true, sensitivity: "base" }))
    .map(([key, c]) => ({ value: key, label: `${c.label} (${c.count})` }));
  return none > 0 ? [{ value: NONE, label: `${noneLabel(d)} (${none})` }, ...options] : options;
}

/** Editable list of "dimension → values" filters. */
export function DimensionFilters<T>({
  items,
  dimensions,
  filters,
  onChange,
}: {
  items: T[];
  dimensions: Dimension<T>[];
  filters: DimensionFilter[];
  onChange: (filters: DimensionFilter[]) => void;
}) {
  const byId = new Map(dimensions.map((d) => [d.id, d]));
  const used = new Set(filters.map((f) => f.dimension));
  const free = dimensions.filter((d) => !used.has(d.id));
  const update = (i: number, next: DimensionFilter) => onChange(filters.map((f, k) => (k === i ? next : f)));

  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      {filters.map((f, i) => {
        const d = byId.get(f.dimension);
        return (
          <Space.Compact key={f.dimension} style={{ width: "100%", maxWidth: 760 }}>
            <Select
              style={{ width: 220 }}
              value={f.dimension}
              showSearch={{ optionFilterProp: "label" }}
              options={[d, ...free].filter(Boolean).map((x) => ({ value: x!.id, label: x!.title }))}
              onChange={(dimension) => update(i, { dimension, values: [] })}
            />
            <Select
              mode="multiple"
              allowClear
              showSearch={{ optionFilterProp: "label" }}
              style={{ flex: 1, minWidth: 240 }}
              placeholder="Any value"
              maxTagCount="responsive"
              value={f.values}
              options={d ? valueOptions(items, d) : []}
              onChange={(values) => update(i, { ...f, values })}
            />
            <Button icon={<CloseOutlined />} aria-label="Remove filter" onClick={() => onChange(filters.filter((_, k) => k !== i))} />
          </Space.Compact>
        );
      })}
      {free.length > 0 && (
        <Button size="small" icon={<PlusOutlined />} onClick={() => onChange([...filters, { dimension: free[0].id, values: [] }])}>
          Add filter
        </Button>
      )}
    </Space>
  );
}
