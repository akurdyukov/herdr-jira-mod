// Pure logic for the Jira mod. No "herdr" or gpui imports, so `npm test`
// runs it under plain Node without the app.

export const DEFAULTS = {
  flavor: "server", // "server" (Server / Data Center) or "cloud"
  auth: "bearer", // "bearer" (personal access token) or "basic" (email + API token)
  email: "",
  token_cmd: ["pass", "show", "jira/token"],
  token_on: null, // machine name from `hc machine ls` that runs token_cmd; null: this computer
  filters: [{ name: "Mine", jql: "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC" }],
  max_results: 50,
  refresh_minutes: 5,
  count_filter: 1, // which filter (1 = first) the tab-bar button counts; null: no count
  agent: ["claude"],
  branch: "{key}-{slug}",
  prompt: "Work on Jira issue {key}: {summary}\n{url}\n\nType: {type}. Status: {status}.\n\n{description}",
};

/** What a new jira.json starts as when the panel creates it. */
export function starterConfig() {
  const { flavor, auth, token_cmd, token_on, filters, agent } = DEFAULTS;
  return JSON.stringify({ base_url: "https://jira.example.com", flavor, auth, token_cmd, token_on, filters, agent }, null, 2) + "\n";
}

const isStrings = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.length > 0);

/** Parses jira.json. Returns { config } or { error } with a message for the panel. */
export function parseConfig(text) {
  if (text === null || text === undefined) return { error: "missing" };
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return { error: `jira.json is not valid JSON: ${e.message}` }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "jira.json must be a JSON object." };
  const c = { ...DEFAULTS, ...raw };
  if (typeof c.base_url !== "string" || !/^https?:\/\/[^/]+/.test(c.base_url)) return { error: 'jira.json: "base_url" must be like https://jira.example.com' };
  c.base_url = c.base_url.replace(/\/+$/, "");
  if (c.flavor !== "server" && c.flavor !== "cloud") return { error: 'jira.json: "flavor" must be "server" or "cloud".' };
  if (c.auth !== "bearer" && c.auth !== "basic") return { error: 'jira.json: "auth" must be "bearer" or "basic".' };
  if (c.auth === "basic" && !c.email) return { error: 'jira.json: "auth": "basic" needs "email".' };
  if (!isStrings(c.token_cmd)) return { error: 'jira.json: "token_cmd" must be a command as an array of strings.' };
  if (c.token_on !== null && typeof c.token_on !== "string") return { error: 'jira.json: "token_on" must be a machine name or null.' };
  if (!isStrings(c.agent)) return { error: 'jira.json: "agent" must be a command as an array of strings.' };
  if (!Array.isArray(c.filters) || !c.filters.length || !c.filters.every((f) => f && typeof f.name === "string" && f.name && typeof f.jql === "string" && f.jql))
    return { error: 'jira.json: "filters" must be a non-empty list of { "name", "jql" }.' };
  if (c.count_filter !== null && !(Number.isInteger(c.count_filter) && c.count_filter >= 1 && c.count_filter <= c.filters.length))
    return { error: `jira.json: "count_filter" must be a filter's number, 1 to ${c.filters.length}, or null.` };
  c.max_results = Math.max(1, Math.min(200, Number(c.max_results) || DEFAULTS.max_results));
  c.refresh_minutes = Math.max(1, Number(c.refresh_minutes) || DEFAULTS.refresh_minutes);
  return { config: c };
}

/** The first line a token command printed. */
export function tokenFrom(stdout) {
  return (stdout ?? "").split("\n")[0].trim();
}

// QuickJS has no btoa or TextEncoder to rely on, so both are spelled out.
function utf8(text) {
  const out = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

export function base64(text) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const b = utf8(text);
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += A[n >> 18] + A[(n >> 12) & 63] + (i + 1 < b.length ? A[(n >> 6) & 63] : "=") + (i + 2 < b.length ? A[n & 63] : "=");
  }
  return out;
}

export function authHeader(config, token) {
  return config.auth === "basic" ? `Basic ${base64(`${config.email}:${token}`)}` : `Bearer ${token}`;
}

const FIELDS = "summary,status,issuetype,priority,updated";

/** Cloud's current search endpoint is /search/jql; Server and Data Center use /search.
 *  `legacy` forces /search (the fallback when a Cloud site answers 404). */
export function searchUrl(config, jql, legacy = false) {
  const path = config.flavor === "cloud" && !legacy ? "/rest/api/2/search/jql" : "/rest/api/2/search";
  return `${config.base_url}${path}?jql=${encodeURIComponent(jql)}&fields=${FIELDS}&maxResults=${config.max_results}`;
}

export function issueUrl(config, key) {
  return `${config.base_url}/rest/api/2/issue/${encodeURIComponent(key)}?fields=description`;
}

export function browseUrl(config, key) {
  return `${config.base_url}/browse/${encodeURIComponent(key)}`;
}

/** The rows the panel draws, from a search response. */
export function issuesFrom(json) {
  return (json?.issues ?? []).filter((i) => i && typeof i.key === "string").map((i) => ({
    key: i.key,
    summary: String(i.fields?.summary ?? ""),
    status: String(i.fields?.status?.name ?? ""),
    category: String(i.fields?.status?.statusCategory?.key ?? ""), // "new" | "indeterminate" | "done"
    type: String(i.fields?.issuetype?.name ?? ""),
    priority: String(i.fields?.priority?.name ?? ""),
  }));
}

/** How many issues a search matched, as the badge shows it. Server (and the older
 *  endpoint) report `total`; Cloud's /search/jql only says whether more pages follow,
 *  so beyond one page it is "<shown>+". */
export function countFrom(json) {
  if (typeof json?.total === "number") return String(json.total);
  const shown = issuesFrom(json).length;
  return json?.isLast === false || json?.nextPageToken ? `${shown}+` : String(shown);
}

/** A description as plain text: Server sends a string, Cloud may send an ADF tree. */
export function describe(description, limit = 6000) {
  let text = "";
  if (typeof description === "string") text = description;
  else if (description && typeof description === "object") {
    const walk = (n) => {
      if (!n || typeof n !== "object") return "";
      if (typeof n.text === "string") return n.text;
      const inner = (n.content ?? []).map(walk).join("");
      return ["paragraph", "heading", "listItem", "codeBlock", "blockquote"].includes(n.type) ? inner + "\n" : inner;
    };
    text = walk(description);
  }
  text = text.replace(/\r\n/g, "\n").trim();
  if (!text) return "(no description)";
  return text.length > limit ? `${text.slice(0, limit)}\n… (description truncated)` : text;
}

export function slug(text, max = 40) {
  const s = text.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, max).replace(/-+$/, "");
}

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));

export function branchName(config, issue) {
  const name = fill(config.branch, { key: issue.key, slug: slug(issue.summary) }).replace(/-+$/, "");
  return name || issue.key;
}

export function promptFor(config, issue, description) {
  return fill(config.prompt, {
    key: issue.key,
    summary: issue.summary,
    url: browseUrl(config, issue.key),
    type: issue.type || "Issue",
    status: issue.status || "unknown",
    description: describe(description),
  });
}

/** A folder name for a branch, as Herdr's own worktree mod makes it. */
export function folderName(branch) {
  return branch.replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "branch";
}

export function httpMessage(status) {
  if (status === 401) return "Jira rejected the token (401). Check the token and \"auth\" in jira.json.";
  if (status === 403) return "Jira refused the request (403). The token may lack permission, or a captcha login is pending.";
  if (status === 400) return "Jira could not run this filter's JQL (400).";
  if (status === 404) return "Jira answered 404. Check \"base_url\" and \"flavor\" in jira.json.";
  return `Jira answered ${status}.`;
}
