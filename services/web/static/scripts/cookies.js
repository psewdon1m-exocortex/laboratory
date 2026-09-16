const CONSENT_COOKIE = "laboratory_consent";
const VISITOR_COOKIE = "laboratory_visitor_id";
const SESSION_COOKIE = "laboratory_session_id";
const CONSENT_VERSION = "2026-09-16.1";
const ACCEPTED_VALUE = `accepted.${CONSENT_VERSION}`;
const TRACKABLE_EVENTS = new Set([
  "article_open",
  "abstract_open",
  "transcript_open",
  "derived_panel_open",
  "pdf_open",
  "theme_change",
]);

function readCookie(name) {
  const prefix = `${encodeURIComponent(name)}=`;
  const entry = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : "";
}

function writeCookie(name, value, { days = 0 } = {}) {
  const attributes = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax"];
  if (location.protocol === "https:") attributes.push("Secure");
  if (days > 0) attributes.push(`Max-Age=${Math.round(days * 86400)}`);
  document.cookie = attributes.join("; ");
}

function identifier(cookie, days = 0) {
  const current = readCookie(cookie);
  if (current) return current;
  const value = crypto.randomUUID();
  writeCookie(cookie, value, { days });
  return value;
}

function viewportClass() {
  if (window.innerWidth < 760) return "mobile";
  if (window.innerWidth < 1100) return "tablet";
  return "desktop";
}

function referrerOrigin() {
  if (!document.referrer) return "";
  try { return new URL(document.referrer).origin; } catch { return ""; }
}

let accepted = readCookie(CONSENT_COOKIE) === ACCEPTED_VALUE;
let pageViewSent = false;

function send(event) {
  if (!accepted) return;
  const payload = {
    event,
    occurredAt: new Date().toISOString(),
    path: location.pathname,
    visitorId: identifier(VISITOR_COOKIE, 365),
    sessionId: identifier(SESSION_COOKIE),
    referrerOrigin: referrerOrigin(),
    language: navigator.language || "en",
    viewportClass: viewportClass(),
  };
  void fetch("/api/telemetry/collect", {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

function sendPageView() {
  if (pageViewSent || !accepted) return;
  pageViewSent = true;
  send("page_view");
  if (/^\/journal\/[^/]+\/?$/.test(location.pathname)) send("article_open");
}

function renderNotice() {
  if (accepted || document.querySelector("[data-cookie-notice]")) return;
  const notice = document.createElement("aside");
  notice.className = "cookie-notice dynamic-text";
  notice.dataset.cookieNotice = "";
  notice.setAttribute("aria-label", "Cookie notice");
  const message = document.createElement("p");
  message.textContent = "This site uses first-party cookies to collect basic usage data. The data is stored without profiling or aggregation.";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Accept";
  button.addEventListener("click", () => {
    writeCookie(CONSENT_COOKIE, ACCEPTED_VALUE, { days: 180 });
    accepted = true;
    identifier(VISITOR_COOKIE, 365);
    identifier(SESSION_COOKIE);
    notice.remove();
    send("consent_accept");
    sendPageView();
  });
  notice.append(message, button);
  document.body.append(notice);
}

window.laboratoryTelemetry = Object.freeze({
  track(event) {
    if (TRACKABLE_EVENTS.has(event)) send(event);
  },
  consent() { return accepted ? "accepted" : "pending"; },
});

window.addEventListener("laboratory-theme-change", (event) => {
  if (event.detail?.persist) window.laboratoryTelemetry.track("theme_change");
});
renderNotice();
sendPageView();
