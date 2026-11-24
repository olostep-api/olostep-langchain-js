import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { convertToOpenAITool } from '@langchain/core/utils/function_calling';

import {
  OlostepAnswer,
  OlostepBatch,
  OlostepCrawl,
  OlostepMap,
  OlostepResults,
  OlostepScrape,
  OlostepSearch,
  createOlostepTools,
} from '../src/index.js';

type Route = unknown | ((request: { url: URL; body: any }) => unknown) | Array<[unknown, number]>;
const realFetch = globalThis.fetch;
let routes: Map<string, [Route, number]>;
let calls: { method: string; path: string; url: URL; body: any; headers: Headers }[];

function on(method: string, path: string, body: Route, status = 200) {
  routes.set(`${method} ${path}`, [body, status]);
}

beforeEach(() => {
  routes = new Map();
  calls = [];
  process.env.OLOSTEP_API_KEY = 'test-key';
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1/, '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? 'GET', path, url, body, headers: new Headers(init.headers) });
    const route = routes.get(`${init.method ?? 'GET'} ${path}`);
    if (!route) return new Response(JSON.stringify({ detail: 'no route' }), { status: 404 });
    let [payload, status] = route;
    if (Array.isArray(payload)) [payload, status] = payload.length > 1 ? payload.shift()! : payload[0];
    if (typeof payload === 'function') payload = payload({ url, body });
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const parse = (value: unknown) => JSON.parse(String(value));

describe('tool definitions', () => {
  it('exposes seven tools with valid model schemas', () => {
    const tools = createOlostepTools();
    assert.deepEqual(
      tools.map(tool => tool.name),
      ['olostep_search', 'olostep_scrape', 'olostep_answer', 'olostep_map', 'olostep_crawl', 'olostep_batch', 'olostep_results'],
    );
    for (const tool of tools) assert.ok(convertToOpenAITool(tool).function.parameters);
  });

  it('fails clearly without an API key', async () => {
    delete process.env.OLOSTEP_API_KEY;
    await assert.rejects(new OlostepSearch().invoke({ query: 'q' }), /API key is missing/);
  });
});

describe('search, scrape, answer, map', () => {
  it('searches with domain filters', async () => {
    on('POST', '/searches', { result: { links: [{ url: 'https://a.example', title: 'A', description: 'first' }, { url: '' }] } });
    const out = parse(await new OlostepSearch().invoke({ query: 'agents', limit: 3, includeDomains: ['a.example'] }));
    assert.deepEqual(out.results, [{ title: 'A', url: 'https://a.example', description: 'first' }]);
    assert.deepEqual(calls[0].body, { query: 'agents', limit: 3, include_domains: ['a.example'] });
    assert.equal(calls[0].headers.get('authorization'), 'Bearer test-key');
  });

  it('scrapes and truncates long pages', async () => {
    on('POST', '/scrapes', { result: { markdown_content: '0123456789' } });
    const out = parse(await new OlostepScrape({ maxCharacters: 4 }).invoke({ url: 'https://e.example' }));
    assert.equal(out.content, '0123\n\n[truncated]');
    assert.deepEqual(calls[0].body, { url_to_scrape: 'https://e.example', formats: ['markdown'] });
  });

  it('reports a page with no content', async () => {
    on('POST', '/scrapes', { result: { markdown_content: '', page_metadata: { status_code: 404 } } });
    await assert.rejects(new OlostepScrape().invoke({ url: 'https://e.example/missing' }), /page status 404/);
  });

  it('answers with structured JSON and sources', async () => {
    on('POST', '/answers', { result: { json_content: '{"year":"1889"}', sources: ['https://s.example'] } });
    const out = parse(await new OlostepAnswer().invoke({ task: 'When?', jsonFormat: { year: '' } }));
    assert.deepEqual(out, { answer: { year: '1889' }, sources: ['https://s.example'] });
    assert.deepEqual(calls[0].body, { task: 'When?', json_format: { year: '' } });
  });

  it('unwraps a plain {"result": ...} answer', async () => {
    on('POST', '/answers', { result: { json_content: '{"result":"Tokyo"}', sources: [] } });
    assert.equal(parse(await new OlostepAnswer().invoke({ task: 'Capital of Japan?' })).answer, 'Tokyo');
  });

  it('maps a site with a default URL cap', async () => {
    on('POST', '/maps', { urls: ['https://d.example/a'], urls_count: 1 });
    const out = parse(await new OlostepMap().invoke({ url: 'https://d.example', searchQuery: 'api' }));
    assert.deepEqual(out.urls, ['https://d.example/a']);
    assert.deepEqual(calls[0].body, { url: 'https://d.example', search_query: 'api', top_n: 100 });
  });
});

describe('crawl, batch, results', () => {
  function crawlRoutes(statuses: string[]) {
    on('POST', '/crawls', { id: 'crawl_1', status: 'in_progress' });
    on('GET', '/crawls/crawl_1', statuses.map(status => [{ status }, 200]));
    on('GET', '/crawls/crawl_1/pages', { pages: [{ url: 'https://e.example/', retrieve_id: 'r1' }, { url: 'https://e.example/x' }] });
    on('GET', '/retrieve', { markdown_content: '# Page' });
  }

  it('crawls and returns pages once the crawl completes', async () => {
    crawlRoutes(['completed']);
    on('POST', '/crawls', { id: 'crawl_1', status: 'completed' });
    const out = parse(await new OlostepCrawl().invoke({ url: 'https://e.example', maxPages: 2 }));
    assert.equal(out.status, 'completed');
    assert.deepEqual(out.pages[0], { url: 'https://e.example/', markdown: '# Page' });
    assert.match(out.pages[1].error, /No content/);
    assert.deepEqual(calls[0].body, { start_url: 'https://e.example', max_pages: 2 });
  });

  it('returns the id when a crawl is still running after the timeout', async () => {
    crawlRoutes(['in_progress']);
    const out = parse(await new OlostepCrawl({ timeoutSeconds: 0 }).invoke({ url: 'https://e.example' }));
    assert.equal(out.id, 'crawl_1');
    assert.equal(out.status, 'in_progress');
    assert.match(out.message, /olostep_results/);
  });

  it('starts a batch with one item per URL', async () => {
    on('POST', '/batches', { id: 'batch_1', status: 'in_progress' });
    on('GET', '/batches/batch_1', { status: 'in_progress' });
    const out = parse(await new OlostepBatch({ timeoutSeconds: 0 }).invoke({ urls: ['https://a.example', 'https://b.example'] }));
    assert.equal(out.id, 'batch_1');
    assert.deepEqual(calls[0].body.items, [
      { custom_id: '0', url: 'https://a.example' },
      { custom_id: '1', url: 'https://b.example' },
    ]);
  });

  it('pages through batch results with a cursor', async () => {
    on('GET', '/batches/batch_1', { status: 'completed' });
    on('GET', '/batches/batch_1/items', { items: [{ url: 'https://a.example', retrieve_id: 'r1' }], cursor: 1 });
    on('GET', '/retrieve', { markdown_content: '# A' });
    const out = parse(await new OlostepResults({ pagesPerCall: 1 }).invoke({ id: 'batch_1' }));
    assert.equal(out.nextCursor, '1');
    const items = calls.find(call => call.path.endsWith('/items'))!;
    assert.equal(items.url.searchParams.get('status'), 'completed');
    assert.equal(items.url.searchParams.get('limit'), '1');
  });

  it('rejects an unknown job id', async () => {
    await assert.rejects(new OlostepResults().invoke({ id: 'abc' }), /crawl or batch id/);
  });
});

describe('errors and retries', () => {
  it('explains common HTTP errors', async () => {
    on('POST', '/searches', { detail: 'no credits' }, 402);
    await assert.rejects(new OlostepSearch().invoke({ query: 'q' }), /out of credits/);
  });

  it('retries a rate limit, then succeeds', async () => {
    on('POST', '/searches', [
      [{ detail: 'slow down' }, 429],
      [{ result: { links: [] } }, 200],
    ]);
    const out = parse(await new OlostepSearch().invoke({ query: 'q' }));
    assert.deepEqual(out.results, []);
    assert.equal(calls.length, 2);
  });
});
