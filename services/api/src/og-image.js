import sharp from "sharp";

function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]);
}

function wrapTitle(value, maximum = 32, maximumLines = 3) {
  const words = String(value || "Untitled publication").trim().split(/\s+/);
  const lines = [];
  for (const word of words) {
    const current = lines.at(-1) || "";
    if (!current || `${current} ${word}`.length > maximum) lines.push(word);
    else lines[lines.length - 1] = `${current} ${word}`;
    if (lines.length > maximumLines) {
      lines.length = maximumLines;
      lines[maximumLines - 1] = `${lines[maximumLines - 1].slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
      break;
    }
  }
  return lines;
}

function overlaySvg({ title, siteTitle, publishedAt, articleId }) {
  const lines = wrapTitle(title);
  const fontSize = lines.length > 2 ? 62 : 72;
  const lineHeight = Math.round(fontSize * 1.12);
  const startY = 300 - Math.round((lines.length - 1) * lineHeight / 2);
  const tspans = lines.map((line, index) => (
    `<tspan x="72" y="${startY + index * lineHeight}">${escapeXml(line)}</tspan>`
  )).join("");
  const date = new Date(publishedAt);
  const readableDate = Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(date)
    : "";
  return Buffer.from(`
    <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="shade" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#050505" stop-opacity="0.88"/>
          <stop offset="0.66" stop-color="#050505" stop-opacity="0.63"/>
          <stop offset="1" stop-color="#050505" stop-opacity="0.82"/>
        </linearGradient>
      </defs>
      <rect width="1200" height="630" fill="url(#shade)"/>
      <text x="72" y="82" fill="#f4f2ec" fill-opacity="0.82" font-family="Arial, Helvetica, sans-serif" font-size="24" letter-spacing="4">${escapeXml(String(siteTitle || "Publication").toUpperCase())}</text>
      <text fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="600" letter-spacing="-1.8">${tspans}</text>
      <line x1="72" y1="548" x2="1128" y2="548" stroke="#ffffff" stroke-opacity="0.34"/>
      <text x="72" y="590" fill="#f4f2ec" fill-opacity="0.78" font-family="Arial, Helvetica, sans-serif" font-size="22">${escapeXml(readableDate)}</text>
      <text x="1128" y="590" text-anchor="end" fill="#f4f2ec" fill-opacity="0.52" font-family="Arial, Helvetica, sans-serif" font-size="18" letter-spacing="1">${escapeXml(articleId)}</text>
    </svg>
  `);
}

export async function generateArticleOg({ background, title, siteTitle, publishedAt, articleId }) {
  const prepared = await sharp(background)
    .rotate()
    .resize(1200, 630, { fit: "cover", position: "centre" })
    .modulate({ brightness: 0.72, saturation: 0.7 })
    .png()
    .toBuffer();
  return sharp(prepared)
    .composite([{ input: overlaySvg({ title, siteTitle, publishedAt, articleId }), top: 0, left: 0 }])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}
