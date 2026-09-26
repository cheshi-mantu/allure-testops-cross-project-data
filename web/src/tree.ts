export interface GroupValue {
  key: string;
  label: string;
  sort?: string | number;
}

export interface Grouper<T> {
  id: string;
  title: string;
  /** Group identity and caption of an item; several values put the item into several groups. */
  of: (item: T) => GroupValue | GroupValue[];
}

export interface GroupRow<T> {
  kind: "group";
  key: string;
  label: string;
  groupId: string;
  groupTitle: string;
  items: T[];
  children: TreeRow<T>[];
}

export interface ItemRow<T> {
  kind: "item";
  key: string;
  item: T;
}

export type TreeRow<T> = GroupRow<T> | ItemRow<T>;

const compare = (a: string | number, b: string | number) =>
  typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), "en");

/** Groups items level by level; leaves keep the incoming order of items. */
export function buildTree<T>(
  items: T[],
  groupers: Grouper<T>[],
  itemKey: (item: T) => string,
  parentKey = "",
): TreeRow<T>[] {
  if (groupers.length === 0) {
    return items.map((item) => ({ kind: "item", key: `${parentKey}/i:${itemKey(item)}`, item }));
  }
  const [head, ...rest] = groupers;
  const groups = new Map<string, { label: string; sort: string | number; items: T[] }>();
  for (const item of items) {
    const values = head.of(item);
    for (const g of Array.isArray(values) ? values : [values]) {
      let bucket = groups.get(g.key);
      if (!bucket) {
        bucket = { label: g.label, sort: g.sort ?? g.label, items: [] };
        groups.set(g.key, bucket);
      }
      if (bucket.items[bucket.items.length - 1] !== item) bucket.items.push(item);
    }
  }
  return [...groups.entries()]
    .sort(([, a], [, b]) => compare(a.sort, b.sort))
    .map(([key, g]) => {
      const rowKey = `${parentKey}/${head.id}:${key}`;
      return {
        kind: "group" as const,
        key: rowKey,
        label: g.label,
        groupId: head.id,
        groupTitle: head.title,
        items: g.items,
        children: buildTree(g.items, rest, itemKey, rowKey),
      };
    });
}

export function groupKeys<T>(rows: TreeRow<T>[]): string[] {
  return rows.flatMap((r) => (r.kind === "group" ? [r.key, ...groupKeys(r.children)] : []));
}

type SortValue = string | number | null;

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * Column sorter for tree rows: items are compared by `value`, groups keep
 * their own order, and empty values stay last in both directions.
 */
export function itemSorter<T>(value: (item: T) => SortValue) {
  return (a: TreeRow<T>, b: TreeRow<T>, order?: "ascend" | "descend" | null) => {
    if (a.kind !== "item" || b.kind !== "item") return 0;
    const x = value(a.item);
    const y = value(b.item);
    if (x === null || y === null) {
      if (x === y) return 0;
      const last = x === null ? 1 : -1;
      return order === "descend" ? -last : last;
    }
    if (typeof x === "number" && typeof y === "number") return x - y;
    return collator.compare(String(x), String(y));
  };
}
