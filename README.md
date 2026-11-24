# @olostep/langchain

[![npm](https://img.shields.io/npm/v/@olostep/langchain.svg)](https://www.npmjs.com/package/@olostep/langchain)

[LangChain.js](https://js.langchain.com) tools for [Olostep](https://www.olostep.com): give your agents live web search, scraping, crawling, answers with sources, and batch extraction of up to 100k URLs per batch.

## Why Olostep

Olostep is web data infrastructure for AI agents and enterprise AI workflows. Its APIs provide live web search, scraping and crawling to extract, clean and structure data from the web.

From a handful of URLs to hundreds of millions of pages, Olostep gives developers, AI companies and enterprises reliable, cost-effective access to clean, structured web data at scale. It's built for performance and high concurrency: up to 100k URLs in a single batch, and 1M with 10 batches in parallel. Pages are rendered with JavaScript, so single-page apps and dynamic sites come back complete.

New accounts get **500 free credits**, no credit card required.

## Installation

```bash
npm install @olostep/langchain @langchain/core
```

Get an API key at [olostep.com](https://www.olostep.com/dashboard) and set it as `OLOSTEP_API_KEY`, or pass `apiKey` to any tool.

## Tools

| Tool | Name the model sees | What it does |
|---|---|---|
| `OlostepSearch` | `olostep_search` | Searches the live web: up to 25 results with title, URL and description |
| `OlostepScrape` | `olostep_scrape` | Returns a page as markdown, text or HTML, rendered with JavaScript |
| `OlostepAnswer` | `olostep_answer` | Answers a question from the live web with source URLs, optionally as JSON in your shape |
| `OlostepMap` | `olostep_map` | Lists a site's URLs, ranked by relevance to a query |
| `OlostepCrawl` | `olostep_crawl` | Crawls a site from a start URL and returns each page's markdown |
| `OlostepBatch` | `olostep_batch` | Scrapes up to 100,000 URLs in one batch |
| `OlostepResults` | `olostep_results` | Gets the pages of a crawl or batch that's still running, a set at a time |

## Usage with an agent

```typescript
import { createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { createOlostepTools } from "@olostep/langchain";

const agent = createAgent({
  model: new ChatOpenAI({ model: "gpt-5.4-mini" }),
  tools: createOlostepTools(),
});

const result = await agent.invoke({
  messages: [{ role: "user", content: "What changed in the latest Node.js release? Cite your sources." }],
});
console.log(result.messages.at(-1)?.content);
```

Pick only the tools you need:

```typescript
import { OlostepAnswer, OlostepScrape, OlostepSearch } from "@olostep/langchain";

const tools = [new OlostepSearch(), new OlostepScrape(), new OlostepAnswer()];
```

## Calling a tool directly

Every tool is a LangChain `StructuredTool`, so you can also call it yourself. Tools return JSON strings.

```typescript
import { OlostepAnswer, OlostepScrape } from "@olostep/langchain";

const page = JSON.parse(await new OlostepScrape().invoke({ url: "https://example.com" }));
console.log(page.content);

const answer = JSON.parse(
  await new OlostepAnswer().invoke({
    task: "When was the Eiffel Tower completed?",
    jsonFormat: { year: "" },
  }),
);
console.log(answer.answer, answer.sources); // { year: "1889" } [...]
```

## Options

All tools accept the same options:

| Option | Default | Description |
|---|---|---|
| `apiKey` | `OLOSTEP_API_KEY` | Olostep API key |
| `maxCharacters` | 20,000 | Characters of page content returned to the model per page |
| `timeoutSeconds` | 300 | How long crawl and batch wait before returning the job id |
| `pagesPerCall` | 20 | Pages returned per call by crawl, batch and results (up to 100) |

`maxCharacters`, `pagesPerCall` and the map tool's default of 100 URLs only limit how much one call returns to the model. They aren't Olostep limits.

## Errors

Tools throw an `OlostepError` with a readable message (a bad key, no credits, a page with no content). LangChain agents pass that message back to the model. Rate limits, gateway errors and network failures are retried twice.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

The tests mock the Olostep API, so they don't need a key.

## Links

- [Olostep](https://www.olostep.com)
- [Olostep docs](https://docs.olostep.com)
- [LangChain.js](https://js.langchain.com)

## License

MIT
