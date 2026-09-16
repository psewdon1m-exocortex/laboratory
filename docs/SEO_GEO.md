# SEO and GEO contract

This document specializes [Part 08 — SEO and GEO](https://github.com/psewdon1m-exocortex/general/blob/main/PART_08_SEO_AND_GEO.md); that central contract remains authoritative.

The latest About and reader changes do not require a URL or schema migration. About remains a server-rendered `AboutPage` with its configured H1, uploaded Markdown biography, canonical `/about`, `Person.url=/about`, Open Graph and X/Twitter cards. Article scroll restoration is session-only progressive enhancement and does not change source HTML. The established UX/UI is a release invariant: SEO/GEO work may enrich server HTML, metadata and machine interfaces but may not change the author workflow or remove the existing reader interactions.

`PAGE_TYPE_REGISTRY` defines rendering, index policy, canonical behavior, sitemap membership and schema for every page type. `PUBLIC_PAGE_REGISTRY` is its static-sitemap subset. `BOT_POLICY_REGISTRY` and the versioned `BOT_POLICY_VERSION` generate crawler directives, including the explicit public allowance for `Google-Extended`; private/admin/internal routes remain disallowed. Published articles alone enter Journal, RSS, sitemaps, `llms.txt`, Evidence API and MCP. The automatic sitemap index and deterministic shards remain the permanent model as the corpus grows; authors never maintain XML files.

Public mutations write `public_content_events` in the same SQLite transaction as the content change. This monotonic lifecycle journal is the freshness source for HTML, sitemap shards, RSS and Markdown representations. Dynamic discovery resources use ETag plus `Last-Modified` where applicable and require cache revalidation, so publication, title/slug changes, unpublishing and deletion cannot be hidden behind a stale intermediary response. Evidence FTS synchronizes lazily from the current published revision before search.

Release verification must check:

- meaningful first-response HTML with one page H1, canonical, description and JSON-LD;
- About `AboutPage`/`Person`, article `Article` author URL and public-only status;
- Open Graph fields used by Facebook, LinkedIn, Telegram and other OG consumers, plus X/Twitter fields and the immutable per-revision 1200×630 article card;
- sitemap index/pages/article shards, deterministic `lastmod`, ETag/Last-Modified conditional responses;
- `robots.txt`, `llms.txt`, Markdown alternates, RSS, OpenAPI, Evidence API and MCP, including addressable evidence resources;
- no telemetry event before cookie acceptance, and raw first-party collection without IP/User-Agent storage or aggregation;
- `noindex, nofollow, noarchive` and `no-store` on `/private`, and no accidental global `noindex`.

Uploaded Markdown headings are shifted below the server-rendered page H1. Generated descriptions and abstracts enhance discovery but are not required for rendering. When derived content exists, a borderless `+` control in the article footer reveals ordinary readable Abstract and Text version blocks without changing the main reading flow. Machine representations do not replace the visible source article.

IndexNow remains disabled until the production operator configures a generated ownership key and the canonical HTTPS URL. The application serves the proof file, queues published revisions and URL tombstones, uses bounded retries, reports preflight/accepted/failed state, and provides an authenticated manual queue run. Provider acceptance is never reported as indexing.
