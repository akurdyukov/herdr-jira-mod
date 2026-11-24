import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig, base64, authHeader, searchUrl, issuesFrom, countFrom, describe, slug, branchName, promptFor, folderName, tokenFrom, DEFAULTS } from "../mods/jira/jira.js";

const ok = (extra = {}) => parseConfig(JSON.stringify({ base_url: "https://jira.example.com/", ...extra })).config;

test("config: defaults, trailing slash, and each rejection", () => {
  const c = ok();
  assert.equal(c.base_url, "https://jira.example.com");
  assert.equal(c.auth, "bearer");
  assert.deepEqual(c.filters, DEFAULTS.filters);
  assert.equal(parseConfig(null).error, "missing");
  assert.match(parseConfig("{").error, /not valid JSON/);
  assert.match(parseConfig("{}").error, /base_url/);
  assert.match(parseConfig(JSON.stringify({ base_url: "https://x.y", auth: "basic" })).error, /email/);
  assert.match(parseConfig(JSON.stringify({ base_url: "https://x.y", token_cmd: "pass show x" })).error, /token_cmd/);
  assert.match(parseConfig(JSON.stringify({ base_url: "https://x.y", filters: [] })).error, /filters/);
  assert.match(parseConfig(JSON.stringify({ base_url: "https://x.y", flavor: "dc" })).error, /flavor/);
  assert.equal(ok({ max_results: 9999 }).max_results, 200);
  assert.equal(ok({ refresh_minutes: 0 }).refresh_minutes, DEFAULTS.refresh_minutes);
});

test("config: count_filter is a filter's number from 1, or null", () => {
  const two = [{ name: "A", jql: "a" }, { name: "B", jql: "b" }];
  assert.equal(ok().count_filter, 1);
  assert.equal(ok({ filters: two, count_filter: 2 }).count_filter, 2);
  assert.equal(ok({ count_filter: null }).count_filter, null);
  for (const bad of [0, 3, 1.5, "1"]) assert.match(parseConfig(JSON.stringify({ base_url: "https://j.example.com", filters: two, count_filter: bad })).error, /"count_filter" must be a filter's number, 1 to 2, or null/, String(bad));
});

test("count: Server's total, Cloud's page with or without more", () => {
  const two = [{ key: "A-1" }, { key: "A-2" }];
  assert.equal(countFrom({ total: 137, issues: two }), "137");
  assert.equal(countFrom({ issues: two, isLast: true }), "2");
  assert.equal(countFrom({ issues: two, isLast: false, nextPageToken: "x" }), "2+");
  assert.equal(countFrom({ issues: [] }), "0");
});

test("base64 matches Node's for ASCII, padding cases and non-ASCII", () => {
  for (const s of ["", "a", "ab", "abc", "me@example.com:tok/en+1", "ünï©ödé:🔑"]) assert.equal(base64(s), Buffer.from(s, "utf8").toString("base64"), s);
});

test("auth header per mode", () => {
  assert.equal(authHeader(ok(), "T"), "Bearer T");
  assert.equal(authHeader(ok({ auth: "basic", email: "a@b.c" }), "T"), `Basic ${Buffer.from("a@b.c:T").toString("base64")}`);
});

test("search URL: server, cloud, and cloud's fallback", () => {
  const jql = "assignee = currentUser() AND status != Done";
  const server = new URL(searchUrl(ok(), jql));
  assert.equal(server.pathname, "/rest/api/2/search");
  assert.equal(server.searchParams.get("jql"), jql);
  assert.equal(server.searchParams.get("maxResults"), "50");
  assert.equal(new URL(searchUrl(ok({ flavor: "cloud" }), jql)).pathname, "/rest/api/2/search/jql");
  assert.equal(new URL(searchUrl(ok({ flavor: "cloud" }), jql, true)).pathname, "/rest/api/2/search");
});

test("issues from a search response, tolerating missing fields", () => {
  const rows = issuesFrom({ issues: [
    { key: "PLAT-1", fields: { summary: "Fix login", status: { name: "In Progress", statusCategory: { key: "indeterminate" } }, issuetype: { name: "Bug" } } },
    { key: "PLAT-2", fields: {} },
    { nokey: true },
  ] });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { key: "PLAT-1", summary: "Fix login", status: "In Progress", category: "indeterminate", type: "Bug", priority: "" });
  assert.equal(rows[1].summary, "");
  assert.deepEqual(issuesFrom(null), []);
});

test("description: string, ADF, empty, truncation", () => {
  assert.equal(describe("  hello\r\nworld "), "hello\nworld");
  const adf = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "One " }, { type: "text", text: "two" }] }, { type: "paragraph", content: [{ type: "text", text: "Three" }] }] };
  assert.equal(describe(adf), "One two\nThree");
  assert.equal(describe(null), "(no description)");
  assert.match(describe("x".repeat(7000)), /truncated\)$/);
});

test("branch and folder names", () => {
  assert.equal(slug("Fix login: timeout on SSO (prod)!"), "fix-login-timeout-on-sso-prod");
  assert.ok(slug("word ".repeat(30)).length <= 40);
  assert.equal(branchName(ok(), { key: "PLAT-7", summary: "Fix login" }), "PLAT-7-fix-login");
  assert.equal(branchName(ok(), { key: "PLAT-7", summary: "!!!" }), "PLAT-7");
  assert.equal(branchName(ok({ branch: "feature/{key}" }), { key: "PLAT-7", summary: "x" }), "feature/PLAT-7");
  assert.equal(folderName("feature/PLAT-7"), "feature-PLAT-7");
});

test("prompt fills every placeholder and leaves unknown ones alone", () => {
  const p = promptFor(ok({ prompt: "{key}|{summary}|{url}|{type}|{status}|{description}|{nope}" }), { key: "A-1", summary: "S", type: "", status: "Open" }, "D");
  assert.equal(p, "A-1|S|https://jira.example.com/browse/A-1|Issue|Open|D|{nope}");
});

test("token is the first line only", () => {
  assert.equal(tokenFrom("abc123\nuser: me\n"), "abc123");
  assert.equal(tokenFrom(""), "");
});
