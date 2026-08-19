# SEO and GEO contract

The latest About and reader changes do not require a URL or schema migration. About remains a server-rendered `AboutPage` with its configured H1, uploaded Markdown biography, canonical `/about`, `Person.url=/about`, Open Graph and X/Twitter cards. Article scroll restoration is session-only progressive enhancement and does not change source HTML.

`PAGE_TYPE_REGISTRY` defines rendering, index policy, canonical behavior, sitemap membership and schema for every page type. `PUBLIC_PAGE_REGISTRY` is its static-sitemap subset. `BOT_POLICY_REGISTRY` and the versioned `BOT_POLICY_VERSION` generate crawler directives, including the explicit public allowance for `Google-Extended`; private/admin/internal routes remain disallowed. Published articles alone enter Journal, RSS, sitemaps, `llms.txt`, Evidence API and MCP.

Public mutations write `public_content_events` in the same SQLite transaction as the content change. This monotonic lifecycle journal is the freshness source for HTML, sitemap shards, RSS and Markdown representations. Dynamic discovery resources use ETag plus `Last-Modified` where applicable and require cache revalidation, so publication, title/slug changes, unpublishing and deletion cannot be hidden behind a stale intermediary response. Evidence FTS synchronizes lazily from the current published revision before search.

Release verification must check:

- meaningful first-response HTML with one page H1, canonical, description and JSON-LD;
- About `AboutPage`/`Person`, article `Article` author URL and public-only status;
- Open Graph fields used by Facebook, LinkedIn, Telegram and other OG consumers, plus X/Twitter fields;
- sitemap index/pages/article shards, deterministic `lastmod`, ETag/Last-Modified conditional responses;
- `robots.txt`, `llms.txt`, Markdown alternates, RSS, OpenAPI, Evidence API and MCP;
- `noindex, nofollow, noarchive` and `no-store` on `/private`, and no accidental global `noindex`.

Uploaded Markdown headings are shifted below the server-rendered page H1. Generated descriptions and abstracts enhance discovery but are not required for rendering. The collapsed on-page abstract remains ordinary readable HTML when present. A generated PDF transcript is also exposed as a collapsed `Text version` block in ordinary server HTML; machine representations do not replace the visible source article.
