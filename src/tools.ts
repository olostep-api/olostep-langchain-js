import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import {
  DEFAULT_MAX_CHARACTERS,
  MAX_BATCH_URLS,
  type JobKind,
  type OlostepToolOptions,
  OlostepError,
  call,
  clean,
  parseAnswer,
  readPages,
  truncate,
  waitThenRead,
} from './client.js';

const DEFAULT_MAP_URLS = 100;

const json = (value: unknown) => JSON.stringify(value);

const searchSchema = z.object({
  query: z.string().min(1).describe('The search query'),
  limit: z.number().int().min(1).max(25).optional().describe('Maximum number of results, 1 to 25 (default 10)'),
  includeDomains: z.array(z.string()).optional().describe('Only return results from these domains'),
  excludeDomains: z.array(z.string()).optional().describe('Never return results from these domains'),
});

/** Searches the live web and returns result titles, URLs and descriptions. */
export class OlostepSearch extends StructuredTool<typeof searchSchema> {
  static lc_name() {
    return 'OlostepSearch';
  }
  name = 'olostep_search';
  description =
    'Search the live web. Returns up to 25 results, each with its title, URL and description. Use to find current information or pages to scrape.';
  schema = searchSchema;
  constructor(private readonly options: OlostepToolOptions = {}) {
    super();
  }
  protected async _call(input: z.infer<typeof searchSchema>): Promise<string> {
    const data = await call<{ result?: { links?: { url?: string; title?: string; description?: string }[] } }>(
      this.options,
      'POST',
      '/searches',
      {
        body: clean({
          query: input.query,
          limit: input.limit ?? 10,
          include_domains: input.includeDomains,
          exclude_domains: input.excludeDomains,
        }),
      },
    );
    const results = (data.result?.links ?? [])
      .filter(link => link.url)
      .map(link => ({ title: link.title ?? '', url: link.url, description: link.description ?? '' }));
    return json({ query: input.query, results });
  }
}

const scrapeSchema = z.object({
  url: z.string().url().describe('The URL of the page to scrape'),
  format: z.enum(['markdown', 'text', 'html']).optional().describe('Output format (default markdown)'),
  waitBeforeScraping: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .optional()
    .describe('Milliseconds to wait for JavaScript-heavy pages to render'),
});

/** Scrapes one page, rendered with JavaScript, and returns its content as markdown, text or HTML. */
export class OlostepScrape extends StructuredTool<typeof scrapeSchema> {
  static lc_name() {
    return 'OlostepScrape';
  }
  name = 'olostep_scrape';
  description =
    'Scrape a web page and return its content as clean markdown (or text or HTML). Handles JavaScript-rendered pages. Use when you need the content of a specific URL.';
  schema = scrapeSchema;
  constructor(private readonly options: OlostepToolOptions = {}) {
    super();
  }
  protected async _call(input: z.infer<typeof scrapeSchema>): Promise<string> {
    const format = input.format ?? 'markdown';
    const data = await call<{ result?: Record<string, unknown> & { page_metadata?: { status_code?: number } } }>(
      this.options,
      'POST',
      '/scrapes',
      { body: clean({ url_to_scrape: input.url, formats: [format], wait_before_scraping: input.waitBeforeScraping }) },
    );
    const content = data.result?.[`${format}_content`];
    if (typeof content !== 'string' || !content) {
      const status = data.result?.page_metadata?.status_code;
      throw new OlostepError(`Olostep returned no content for ${input.url}${status ? ` (page status ${status})` : ''}.`);
    }
    return json({ url: input.url, format, content: truncate(content, this.options.maxCharacters ?? DEFAULT_MAX_CHARACTERS) });
  }
}

const answerSchema = z.object({
  task: z.string().min(1).describe('The question or research task, in plain language'),
  jsonFormat: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Optional shape for a structured answer, e.g. {"company": "", "founded": ""}'),
});

/** Answers a question from the live web, with the source URLs used. */
export class OlostepAnswer extends StructuredTool<typeof answerSchema> {
  static lc_name() {
    return 'OlostepAnswer';
  }
  name = 'olostep_answer';
  description =
    'Answer a question by searching and reading the live web. Returns the answer with its source URLs, optionally as JSON in a given shape. Use for factual or current questions that need citations.';
  schema = answerSchema;
  constructor(private readonly options: OlostepToolOptions = {}) {
    super();
  }
  protected async _call(input: z.infer<typeof answerSchema>): Promise<string> {
    const data = await call<{ result?: { json_content?: unknown; sources?: string[] } }>(this.options, 'POST', '/answers', {
      body: clean({ task: input.task, json_format: input.jsonFormat }),
    });
    return json({ answer: parseAnswer(data.result?.json_content), sources: data.result?.sources ?? [] });
  }
}

const mapSchema = z.object({
  url: z.string().url().describe('The website to map, e.g. https://docs.example.com'),
  searchQuery: z.string().optional().describe('Rank URLs by relevance to this query'),
  topN: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`Maximum number of URLs to return (default ${DEFAULT_MAP_URLS})`),
  includeUrls: z.array(z.string()).optional().describe('Only keep URLs matching these glob patterns, e.g. ["/docs/**"]'),
});

/** Lists the URLs of a website, optionally ranked by relevance to a query. */
export class OlostepMap extends StructuredTool<typeof mapSchema> {
  static lc_name() {
    return 'OlostepMap';
  }
  name = 'olostep_map';
  description =
    'Discover the URLs on a website, optionally ranked by relevance to a search query. Use to find the right pages on a site before scraping them.';
  schema = mapSchema;
  constructor(private readonly options: OlostepToolOptions = {}) {
    super();
  }
  protected async _call(input: z.infer<typeof mapSchema>): Promise<string> {
    // Large sites have thousands of URLs, so the default keeps the result small enough for the model.
    const data = await call<{ urls?: string[]; urls_count?: number }>(this.options, 'POST', '/maps', {
      body: clean({
        url: input.url,
        search_query: input.searchQuery,
        top_n: input.topN ?? DEFAULT_MAP_URLS,
        include_urls: input.includeUrls,
      }),
    });
    const urls = data.urls ?? [];
    return json({ url: input.url, urlsCount: data.urls_count ?? urls.length, urls });
  }
}

const crawlSchema = z.object({
  url: z.string().url().describe('The URL to start crawling from'),
  maxPages: z.number().int().min(1).optional().describe('Maximum pages to crawl (default 5)'),
  includeUrls: z.array(z.string()).optional().describe('Only crawl URLs matching these glob patterns, e.g. ["/docs/**"]'),
});

/** Crawls a website from a start URL and returns each page's markdown. */
export class OlostepCrawl extends StructuredTool<typeof crawlSchema> {
  static lc_name() {
    return 'OlostepCrawl';
  }
  name = 'olostep_crawl';
  description =
    'Crawl a website from a starting URL and return the markdown of each page found. Use to read several pages of a site, such as documentation. Large crawls return an id or nextCursor: use the olostep_results tool for the rest.';
  schema = crawlSchema;
  constructor(private readonly options: OlostepToolOptions = {}) {
    super();
  }
  protected async _call(input: z.infer<typeof crawlSchema>): Promise<string> {
    const started = await call<{ id?: string; status?: string }>(this.options, 'POST', '/crawls', {
      body: clean({ start_url: input.url, max_pages: input.maxPages ?? 5, include_urls: input.includeUrls }),
    });
    if (!started.id) throw new OlostepError('Olostep did not return a crawl id.');
    return json(await waitThenRead(this.options, 'crawls', started.id, started.status));
  }
}

const batchSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(MAX_BATCH_URLS).describe('The URLs to scrape, up to 100,000 per batch'),
});

/** Scrapes a list of URLs in one batch job (up to 100,000 URLs per batch). */
export class OlostepBatch extends StructuredTool<typeof batchSchema> {
  static lc_name() {
    return 'OlostepBatch';
  }
  name = 'olostep_batch';
  description =
    'Scrape a list of URLs in one batch (up to 100,000 per batch) and return the markdown of each page. For one or two URLs use olostep_scrape instead. Can take a few minutes; large batches return an id or nextCursor: use the olostep_results tool for the rest.';
  schema = batchSchema;
  constructor(private readonly options: OlostepToolOptions = {}) {
    super();
  }
  protected async _call(input: z.infer<typeof batchSchema>): Promise<string> {
    const items = input.urls.map((url, index) => ({ custom_id: String(index), url }));
    const started = await call<{ id?: string; status?: string }>(this.options, 'POST', '/batches', { body: { items } });
    if (!started.id) throw new OlostepError('Olostep did not return a batch id.');
    return json(await waitThenRead(this.options, 'batches', started.id, started.status));
  }
}

const resultsSchema = z.object({
  id: z.string().describe('The crawl or batch id, starting with crawl_ or batch_'),
  cursor: z.string().optional().describe('The nextCursor from a previous result; leave empty for the first pages'),
});

/** Gets the pages of a crawl or batch by its id, a set at a time. */
export class OlostepResults extends StructuredTool<typeof resultsSchema> {
  static lc_name() {
    return 'OlostepResults';
  }
  name = 'olostep_results';
  description =
    'Get the markdown pages of a crawl or batch by its id (crawl_... or batch_...). Use when olostep_crawl or olostep_batch returned status in_progress or a nextCursor.';
  schema = resultsSchema;
  constructor(private readonly options: OlostepToolOptions = {}) {
    super();
  }
  protected async _call(input: z.infer<typeof resultsSchema>): Promise<string> {
    const kind: JobKind | null = input.id.startsWith('batch_') ? 'batches' : input.id.startsWith('crawl_') ? 'crawls' : null;
    if (!kind) throw new OlostepError(`Enter a crawl or batch id, for example crawl_abc123 or batch_abc123 (got ${input.id}).`);
    return json(await readPages(this.options, kind, input.id, input.cursor));
  }
}

/** All Olostep tools, ready to pass to `createAgent` or `model.bindTools`. */
export function createOlostepTools(options: OlostepToolOptions = {}) {
  return [
    new OlostepSearch(options),
    new OlostepScrape(options),
    new OlostepAnswer(options),
    new OlostepMap(options),
    new OlostepCrawl(options),
    new OlostepBatch(options),
    new OlostepResults(options),
  ];
}
