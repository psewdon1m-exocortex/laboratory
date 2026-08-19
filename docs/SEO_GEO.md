# SEO and GEO contract

The latest About and reader changes do not require a URL or schema migration. About remains a server-rendered `AboutPage` with its configured H1, uploaded Markdown biography, canonical `/about`, `Person.url=/about`, Open Graph and X/Twitter cards. Article scroll restoration is session-only progressive enhancement and does not change source HTML.

`PUBLIC_PAGE_REGISTRY` is the source for the static sitemap pages. `BOT_POLICY_REGISTRY` generates crawler directives, including the explicit public allowance for `Google-Extended`; private/admin/internal routes remain disallowed. Published articles alone enter Journal, RSS, sitemaps, `llms.txt`, Evidence API and MCP.

Release verification must check:

- meaningful first-response HTML with one page H1, canonical, description and JSON-LD;
- About `AboutPage`/`Person`, article `Article` author URL and public-only status;
- Open Graph fields used by Facebook, LinkedIn, Telegram and other OG consumers, plus X/Twitter fields;
- sitemap index/pages/article shards, deterministic `lastmod`, ETag/Last-Modified conditional responses;
- `robots.txt`, `llms.txt`, Markdown alternates, RSS, OpenAPI, Evidence API and MCP;
- `noindex, nofollow, noarchive` and `no-store` on `/private`, and no accidental global `noindex`.

Generated descriptions and abstracts enhance discovery but are not required for rendering. The collapsed on-page abstract remains ordinary readable HTML when present; hidden machine representations do not replace the visible source article.
