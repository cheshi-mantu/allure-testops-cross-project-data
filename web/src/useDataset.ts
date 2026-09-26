import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type Snapshot } from "./api";

const POLL_BUSY_MS = 2_000;
const POLL_IDLE_MS = 15_000;

/**
 * Polls the local server for a cached dataset. Polling is cheap: the server
 * only goes to Allure TestOps when its own refresh schedule says so.
 * `read` and `refresh` must be stable references.
 */
export function useDataset<T>(read: () => Promise<Snapshot<T>>, refresh: () => Promise<Snapshot<T>>) {
  const [snapshot, setSnapshot] = useState<Snapshot<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const poll = useRef<() => void>(() => {});

  const schedule = useCallback((ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => poll.current(), ms);
  }, []);

  const apply = useCallback(
    (s: Snapshot<T>) => {
      setSnapshot(s);
      setError(null);
      schedule(s.refreshing ? POLL_BUSY_MS : POLL_IDLE_MS);
    },
    [schedule],
  );

  poll.current = () => {
    read()
      .then(apply)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        schedule(POLL_IDLE_MS);
      });
  };

  useEffect(() => {
    poll.current();
    return () => window.clearTimeout(timer.current);
  }, []);

  /** `how` replaces the default refresh call, e.g. with a full reload. */
  const requestRefresh = useCallback(async (how: () => Promise<Snapshot<T>> = refresh) => {
    try {
      apply(await how());
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        setError(`Refresh is allowed once a minute, retry in ${e.retryAfterSec ?? 60}s`);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, [refresh, apply]);

  return { snapshot, error, requestRefresh };
}
