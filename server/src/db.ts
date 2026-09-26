import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The application's SQLite database, `data.db` in the data directory. Its
 * content belongs to one Allure TestOps instance: switching the endpoint
 * clears it.
 */

let db: DatabaseSync | null = null;
const schemas: string[] = [];
const tables: string[] = [];

/** Registers tables created on first use; `names` are cleared when the instance changes. */
export function defineTables(ddl: string, names: string[]): void {
  schemas.push(ddl);
  tables.push(...names);
  if (db) db.exec(ddl);
}

defineTables(
  `
    -- the last result of every dataset, shown right after a restart
    create table if not exists snapshot (
      name text primary key,
      fetched_at integer not null,
      data text not null
    );
  `,
  ["snapshot"],
);

/** Earlier versions kept the history in history.db and test cases in a JSON file. */
function migrate(dir: string): void {
  const file = join(dir, "data.db");
  if (!existsSync(file) && existsSync(join(dir, "history.db"))) {
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(join(dir, `history.db${suffix}`))) renameSync(join(dir, `history.db${suffix}`), `${file}${suffix}`);
    }
  }
  rmSync(join(dir, "cache"), { recursive: true, force: true });
}

function open(): DatabaseSync {
  if (db) return db;
  const dir = process.env.DATA_DIR ?? join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  migrate(dir);
  db = new DatabaseSync(join(dir, "data.db"));
  db.exec("pragma journal_mode = wal; create table if not exists meta (key text primary key, value text not null);");
  for (const ddl of schemas) db.exec(ddl);
  return db;
}

function clear(d: DatabaseSync): void {
  for (const t of tables) d.exec(`delete from ${t};`);
  d.exec("delete from meta where key != 'endpoint';");
}

/** The database, emptied first when it holds data of another instance. */
export function database(endpoint: string): DatabaseSync {
  const d = open();
  const row = d.prepare("select value from meta where key = 'endpoint'").get() as { value: string } | undefined;
  if (row?.value !== endpoint) {
    clear(d);
    d.prepare("insert or replace into meta (key, value) values ('endpoint', ?)").run(endpoint);
  }
  return d;
}

export function clearDatabase(): void {
  const d = open();
  clear(d);
  d.exec("delete from meta;");
}

export function getMeta(d: DatabaseSync, key: string): string | null {
  return (d.prepare("select value from meta where key = ?").get(key) as { value: string } | undefined)?.value ?? null;
}

export function setMeta(d: DatabaseSync, key: string, value: string): void {
  d.prepare("insert or replace into meta (key, value) values (?, ?)").run(key, value);
}

/** Runs `fn` in a transaction; the work in it is synchronous, so callers never interleave. */
export function tx(d: DatabaseSync, fn: () => void): void {
  d.exec("begin");
  try {
    fn();
    d.exec("commit");
  } catch (e) {
    d.exec("rollback");
    throw e;
  }
}

export interface StoredSnapshot<T> {
  data: T;
  fetchedAt: number;
}

export function loadSnapshot<T>(endpoint: string, name: string): StoredSnapshot<T> | null {
  if (!endpoint) return null;
  try {
    const row = database(endpoint).prepare("select fetched_at, data from snapshot where name = ?").get(name) as
      | { fetched_at: number; data: string }
      | undefined;
    return row ? { data: JSON.parse(row.data) as T, fetchedAt: row.fetched_at } : null;
  } catch (e) {
    console.error(`Cannot read the stored ${name}:`, e);
    return null;
  }
}

export function saveSnapshot(endpoint: string, name: string, data: unknown, fetchedAt: number): void {
  try {
    database(endpoint)
      .prepare("insert or replace into snapshot (name, fetched_at, data) values (?, ?, ?)")
      .run(name, fetchedAt, JSON.stringify(data));
  } catch (e) {
    console.error(`Cannot store ${name}:`, e);
  }
}
