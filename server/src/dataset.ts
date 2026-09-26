import { MIN_REFRESH_SEC } from "./config.js";

export interface Snapshot<T> {
  data: T | null;
  fetchedAt: number | null;
  refreshing: boolean;
  error: string | null;
  /** Earliest moment a manual refresh is accepted, epoch ms. */
  nextRefreshAllowedAt: number;
  /** When the next automatic refresh is due, epoch ms; null when auto refresh is off. */
  nextAutoRefreshAt: number | null;
  progress: string | null;
}

export class ThrottledError extends Error {
  constructor(readonly retryAfterSec: number) {
    super(`Refresh is allowed once per ${MIN_REFRESH_SEC}s, retry in ${retryAfterSec}s`);
  }
}

export type Loader<T> = (report: (progress: string) => void) => Promise<T>;

/** Keeps the last result, so it can be shown right after a restart. */
export interface SnapshotStore<T> {
  load(): { data: T; fetchedAt: number } | null;
  save(data: T, fetchedAt: number): void;
}

/**
 * Cached result of an expensive Allure TestOps crawl.
 *
 * Every crawl, automatic or manual, counts towards the same limit: at most one
 * start per MIN_REFRESH_SEC. Automatic refresh is lazy: it is triggered by a
 * read once the configured period has passed, so nobody watching means no
 * load on Allure TestOps.
 */
export class Dataset<T> {
  private data: T | null = null;
  private fetchedAt: number | null = null;
  private startedAt: number | null = null;
  private error: string | null = null;
  private progress: string | null = null;
  private inFlight: Promise<void> | null = null;
  private generation = 0;

  constructor(
    private readonly loader: Loader<T>,
    private readonly periodSec: () => number,
    private readonly store?: SnapshotStore<T>,
  ) {
    // A stored result is shown until the first refresh, which starts on the first read.
    const stored = store?.load();
    if (stored) {
      this.data = stored.data;
      this.fetchedAt = stored.fetchedAt;
    }
  }

  /** Drops cached data, e.g. after the connection settings changed. */
  reset(): void {
    this.generation++;
    this.data = null;
    this.fetchedAt = null;
    this.startedAt = null;
    this.error = null;
    this.progress = null;
    this.inFlight = null;
  }

  /** Changes the cached data in place, e.g. after a write to Allure TestOps. */
  update(fn: (data: T) => void): void {
    if (!this.data) return;
    fn(this.data);
    this.store?.save(this.data, this.fetchedAt ?? Date.now());
  }

  /** Never waits for a crawl: the UI polls while `refreshing` is true. */
  read(): Snapshot<T> {
    if (this.startedAt === null || (!this.inFlight && this.autoRefreshDue())) {
      void this.start();
    }
    return this.snapshot();
  }

  refresh(): Snapshot<T> {
    if (!this.inFlight) {
      const wait = this.nextAllowedAt() - Date.now();
      if (wait > 0) throw new ThrottledError(Math.ceil(wait / 1000));
      void this.start();
    }
    return this.snapshot();
  }

  snapshot(): Snapshot<T> {
    const period = this.periodSec();
    return {
      data: this.data,
      fetchedAt: this.fetchedAt,
      refreshing: this.inFlight !== null,
      error: this.error,
      progress: this.inFlight ? this.progress : null,
      nextRefreshAllowedAt: this.nextAllowedAt(),
      nextAutoRefreshAt:
        period > 0 && this.startedAt !== null
          ? this.startedAt + Math.max(period, MIN_REFRESH_SEC) * 1000
          : null,
    };
  }

  private nextAllowedAt(): number {
    return this.startedAt === null ? 0 : this.startedAt + MIN_REFRESH_SEC * 1000;
  }

  private autoRefreshDue(): boolean {
    const period = this.periodSec();
    if (period <= 0 || this.startedAt === null) return false;
    return Date.now() - this.startedAt >= Math.max(period, MIN_REFRESH_SEC) * 1000;
  }

  private start(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    this.startedAt = Date.now();
    this.progress = null;
    const run = this.loader((p) => {
      if (generation === this.generation) this.progress = p;
    })
      .then((data) => {
        if (generation !== this.generation) return;
        this.data = data;
        this.fetchedAt = Date.now();
        this.error = null;
        this.store?.save(data, this.fetchedAt);
      })
      .catch((e: unknown) => {
        if (generation !== this.generation) return;
        this.error = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        if (generation === this.generation) this.inFlight = null;
      });
    this.inFlight = run;
    return run;
  }
}
