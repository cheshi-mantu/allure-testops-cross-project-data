/** Minimal Allure TestOps REST client. */

const PAGE_SIZE = 1000;
const MAX_PARALLEL_REQUESTS = 8;
const REQUEST_TIMEOUT_MS = 60_000;

export interface Page<T> {
  content: T[];
  totalElements: number;
  totalPages: number;
  last?: boolean;
}

export interface ApiProject {
  id: number;
  name: string;
}

export interface ApiLaunch {
  id: number;
  name: string;
  projectId: number;
  closed: boolean;
  tags?: { id: number; name: string }[];
  environment?: { id: number; name: string; variable?: { id: number; name: string } }[];
  createdBy?: string;
  createdDate?: number;
}

export interface ApiIssue {
  id: number;
  name: string;
  url?: string;
  summary?: string;
  closed?: boolean;
}

export interface ApiDefect {
  id: number;
  name: string;
  closed: boolean;
  issue?: ApiIssue | null;
  /** Affected test cases. */
  count?: number;
  /** Not returned by the API at the moment; used if present. */
  createdBy?: string;
  createdDate?: number;
}

export interface ApiDefectMatcher {
  id: number;
  name: string;
  messageRegex?: string | null;
  traceRegex?: string | null;
  createdBy?: string | null;
  createdDate?: number | null;
}

export class TestOpsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

type Auth = { header: string; expiresAt: number };

export class TestOpsClient {
  private auth: Auth | null = null;
  private authPending: Promise<Auth> | null = null;
  private readonly slots = new Semaphore(MAX_PARALLEL_REQUESTS);

  constructor(
    readonly endpoint: string,
    private readonly token: string,
  ) {}

  async projects(): Promise<ApiProject[]> {
    return this.all<ApiProject>("/api/rs/project", { sort: "id,asc" });
  }

  async openLaunches(projectId: number): Promise<ApiLaunch[]> {
    // The preview flavour returns tags and environment with each launch, so
    // one request per page is enough. `closed` is checked again as a safeguard.
    const search = Buffer.from(JSON.stringify([{ id: "close", type: "boolean", value: false }])).toString("base64");
    const launches = await this.all<ApiLaunch>("/api/rs/launch", {
      projectId: String(projectId),
      preview: "true",
      search,
      sort: "created_date,desc",
    });
    return launches.filter((l) => !l.closed);
  }

  async defects(projectId: number): Promise<ApiDefect[]> {
    return this.all<ApiDefect>("/api/rs/defect", { projectId: String(projectId), sort: "id,desc" });
  }

  /** Total of a paginated sub-collection, e.g. `/api/rs/defect/1/launch`. */
  async count(path: string): Promise<number> {
    const page = await this.get<Page<unknown>>(path, { page: "0", size: "1" });
    return page.totalElements;
  }

  async all<T>(path: string, params: Record<string, string>): Promise<T[]> {
    const result: T[] = [];
    for (let page = 0; ; page++) {
      const p = await this.get<Page<T>>(path, { ...params, page: String(page), size: String(PAGE_SIZE) });
      result.push(...p.content);
      if (p.last ?? page + 1 >= p.totalPages) return result;
      if (p.content.length === 0) return result;
    }
  }

  async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(this.endpoint + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return this.slots.run(async () => {
      let res = await this.fetchWithAuth(url);
      if (res.status === 401) {
        this.auth = null;
        res = await this.fetchWithAuth(url);
      }
      if (!res.ok) {
        throw new TestOpsError(`${res.status} ${res.statusText} for GET ${url.pathname}${await errorDetails(res)}`, res.status);
      }
      return (await res.json()) as T;
    });
  }

  private async fetchWithAuth(url: URL): Promise<Response> {
    const auth = await this.authorize();
    return timedFetch(url, { headers: { Authorization: auth.header, Accept: "application/json" } });
  }

  private async authorize(): Promise<Auth> {
    if (this.auth && this.auth.expiresAt > Date.now()) return this.auth;
    this.authPending ??= this.login().finally(() => (this.authPending = null));
    this.auth = await this.authPending;
    return this.auth;
  }

  /**
   * Exchanges the API token for a JWT. If the exchange fails with anything
   * but an authentication error, the token is sent as is.
   */
  private async login(): Promise<Auth> {
    const res = await timedFetch(new URL(this.endpoint + "/api/uaa/oauth/token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "apitoken", scope: "openid", token: this.token }),
    });
    if (res.ok) {
      const body = (await res.json()) as { access_token?: string; expires_in?: number };
      if (body.access_token) {
        const ttl = Math.max(60, (body.expires_in ?? 3600) - 60);
        return { header: `Bearer ${body.access_token}`, expiresAt: Date.now() + ttl * 1000 };
      }
    }
    if (res.status === 400 || res.status === 401) {
      throw new TestOpsError(`Allure TestOps rejected the API token (${res.status})${await errorDetails(res)}`, res.status);
    }
    return { header: `Api-Token ${this.token}`, expiresAt: Number.MAX_SAFE_INTEGER };
  }
}

async function timedFetch(url: URL, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
    throw new TestOpsError(`Cannot reach ${url.origin}${cause || (e instanceof Error ? `: ${e.message}` : "")}`);
  }
}

async function errorDetails(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return "";
  try {
    const body = JSON.parse(text) as { message?: string; error_description?: string; error?: string };
    const msg = body.message ?? body.error_description ?? body.error;
    return msg ? `: ${msg}` : "";
  } catch {
    return `: ${text.slice(0, 200)}`;
  }
}
