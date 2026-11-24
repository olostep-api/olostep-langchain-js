/** Small client for the Olostep API (https://docs.olostep.com), shared by the tools. */

export interface OlostepToolOptions {
  /** Olostep API key. Defaults to the `OLOSTEP_API_KEY` environment variable. */
  apiKey?: string;
  /** Maximum characters of page content returned to the model per page. Default: 20,000. */
  maxCharacters?: number;
  /** How long the crawl and batch tools wait for the job to finish, in seconds. Default: 300. */
  timeoutSeconds?: number;
  /** How many pages the crawl, batch and results tools return per call, up to 100. Default: 20. */
  pagesPerCall?: number;
  /** Olostep API base URL. Default: https://api.olostep.com/v1. */
  apiBaseUrl?: string;
}

export const API_URL = 'https://api.olostep.com/v1';
export const DEFAULT_MAX_CHARACTERS = 20_000;
export const DEFAULT_TIMEOUT_SECONDS = 300;
export const DEFAULT_PAGES_PER_CALL = 20;
export const MAX_PAGES_PER_CALL = 100;
export const MAX_BATCH_URLS = 100_000;
// Tells Olostep which integration a request came from.
const USER_AGENT = 'olostep-langchain-js/0.1.0';
const RETRY_STATUS = new Set([429, 502, 503, 504]);
const RETRIES = 2;
const POLL_SECONDS = 5;

export class OlostepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OlostepError';
  }
}

export function apiKeyOf(options: OlostepToolOptions): string {
  const key = options.apiKey ?? process.env.OLOSTEP_API_KEY;
  if (!key) throw new OlostepError('Olostep API key is missing. Set OLOSTEP_API_KEY or pass apiKey.');
  return key;
}

function messageFor(status: number, body: unknown): string {
  if (status === 401) return 'Olostep rejected the API key (HTTP 401). Check OLOSTEP_API_KEY.';
  if (status === 402) return 'The Olostep account is out of credits (HTTP 402).';
  if (status === 429) return 'Olostep rate limit reached (HTTP 429). Retry in a moment.';
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
  const detail = record ? record.detail ?? record.message ?? record.title : body;
  return `Olostep API error (HTTP ${status})${detail ? `: ${String(detail).slice(0, 300)}` : ''}`;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Calls the API, retrying rate limits, gateway errors and network failures twice. */
export async function call<T = Record<string, unknown>>(
  options: OlostepToolOptions,
  method: 'GET' | 'POST',
  path: string,
  init: { body?: unknown; params?: Record<string, string | number | undefined> } = {},
): Promise<T> {
  const url = new URL(`${options.apiBaseUrl ?? API_URL}${path}`);
  for (const [key, value] of Object.entries(init.params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKeyOf(options)}`, 'User-Agent': USER_AGENT };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (error) {
      if (attempt >= RETRIES) {
        throw new OlostepError(`Could not reach Olostep: ${error instanceof Error ? error.message : String(error)}`);
      }
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (RETRY_STATUS.has(response.status) && attempt < RETRIES) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      // keep the raw text for the error message
    }
    if (!response.ok) throw new OlostepError(messageFor(response.status, body));
    if (!body || typeof body !== 'object') throw new OlostepError('Olostep returned an unexpected response.');
    return body as T;
  }
}

export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}\n\n[truncated]` : text;
}

/** Drops keys whose value is undefined, null or empty, so the API uses its defaults. */
export function clean<T extends Record<string, unknown>>(payload: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0)),
  ) as Partial<T>;
}

export type JobKind = 'crawls' | 'batches';

export interface JobPage {
  url: string;
  markdown: string;
  error?: string;
}

export interface JobResult {
  id: string;
  status: string;
  pages?: JobPage[];
  nextCursor?: string;
  message?: string;
}

function stillRunning(id: string, status = 'in_progress'): JobResult {
  return {
    id,
    status,
    message: 'Still running. Use the olostep_results tool with this id in a few minutes.',
  };
}

/** Returns one set of pages of a finished crawl or batch, with each page's markdown. */
export async function readPages(options: OlostepToolOptions, kind: JobKind, id: string, cursor?: string): Promise<JobResult> {
  const info = await call<{ status?: string }>(options, 'GET', `/${kind}/${id}`);
  if (info.status && info.status !== 'completed') {
    if (info.status === 'failed') return { id, status: 'failed', message: `The ${kind === 'crawls' ? 'crawl' : 'batch'} failed.` };
    return stillRunning(id, info.status);
  }
  const limit = Math.max(1, Math.min(options.pagesPerCall ?? DEFAULT_PAGES_PER_CALL, MAX_PAGES_PER_CALL));
  const listing = await call<{
    items?: { url?: string; retrieve_id?: string }[];
    pages?: { url?: string; retrieve_id?: string }[];
    cursor?: string | number | null;
  }>(options, 'GET', `/${kind}/${id}/${kind === 'batches' ? 'items' : 'pages'}`, {
    params: { limit, cursor, status: kind === 'batches' ? 'completed' : undefined },
  });

  const max = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
  const found = listing.items ?? listing.pages ?? [];
  const pages = await Promise.all(
    found.map(async ({ url = '', retrieve_id: retrieveId }): Promise<JobPage> => {
      if (!retrieveId) return { url, markdown: '', error: 'No content is available for this page.' };
      try {
        const content = await call<{ markdown_content?: string }>(options, 'GET', '/retrieve', {
          params: { retrieve_id: retrieveId, formats: 'markdown' },
        });
        return { url, markdown: truncate(content.markdown_content, max) };
      } catch (error) {
        return { url, markdown: '', error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );

  const result: JobResult = { id, status: 'completed', pages };
  // The API returns a cursor until the listing is exhausted.
  if (found.length >= limit && listing.cursor !== undefined && listing.cursor !== null) {
    result.nextCursor = String(listing.cursor);
    result.message = 'More pages are available. Use the olostep_results tool with this id and nextCursor.';
  } else if (found.length === 0 && !cursor) {
    result.message = `The ${kind === 'crawls' ? 'crawl' : 'batch'} finished but returned no pages. The URLs may be unreachable, blocked or returning errors.`;
  }
  return result;
}

/** Waits for a job up to timeoutSeconds, then returns its first pages, or its id if it's still running. */
export async function waitThenRead(options: OlostepToolOptions, kind: JobKind, id: string, status?: string): Promise<JobResult> {
  const deadline = Date.now() + (options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  let current = status;
  while (current !== 'completed') {
    if (current === 'failed') return { id, status: 'failed', message: `The ${kind === 'crawls' ? 'crawl' : 'batch'} failed.` };
    if (Date.now() >= deadline) return stillRunning(id, current);
    await sleep(POLL_SECONDS * 1000);
    current = (await call<{ status?: string }>(options, 'GET', `/${kind}/${id}`)).status;
  }
  return readPages(options, kind, id);
}

/** The API returns the answer as a JSON string, usually {"result": "..."}. */
export function parseAnswer(answer: unknown): unknown {
  if (typeof answer !== 'string') return answer ?? null;
  try {
    const parsed = JSON.parse(answer);
    return parsed && typeof parsed === 'object' && 'result' in parsed && Object.keys(parsed).length === 1 ? parsed.result : parsed;
  } catch {
    return answer;
  }
}
