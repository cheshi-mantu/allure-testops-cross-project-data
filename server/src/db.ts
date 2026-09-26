import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The application's SQLite database in the data directory. Its content
 * belongs to one Allure TestOps instance: switching the endpoint clears it.
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

function open(): DatabaseSync {
  if (db) return db;
  const dir = process.env.DATA_DIR ?? join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(join(dir, "history.db"));
  db.exec("pragma journal_mode = wal; create table if not exists meta (key text primary key, value text not null);");
  for (const ddl of schemas) db.exec(ddl);
  return db;
}

function clear(d: DatabaseSync): void {
  for (const t of tables) d.exec(`delete from ${t};`);
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
