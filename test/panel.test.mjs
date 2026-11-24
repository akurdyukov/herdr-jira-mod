// Runs the real main.js against a stand-in app: config, token, Jira answers,
// keys and the commands it would send to Herdr.
import test from "node:test";
import assert from "node:assert/strict";
import { world, calls, reset } from "./stubs/herdr.mjs";
import { text, find } from "./stubs/element.mjs";

const CONFIG = "/home/me/.config/herdr-app/jira.json";
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };

const Jira = (await import("../mods/jira/main.js")).default;

const SEARCH = { issues: [
  { key: "PLAT-1", fields: { summary: "Fix login timeout", status: { name: "In Progress", statusCategory: { key: "indeterminate" } }, issuetype: { name: "Bug" } } },
  { key: "PLAT-2", fields: { summary: "Rotate certificates", status: { name: "To Do", statusCategory: { key: "new" } }, issuetype: { name: "Task" } } },
] };

function setup({ config = {}, token = "s3cret", answer } = {}) {
  reset();
  store.clear();
  world.files[CONFIG] = JSON.stringify({ base_url: "https://jira.example.com", token_on: "box", ...config });
  world.exec = (command) => (command === "pass" ? { code: token ? 0 : 2, stdout: token ? `${token}\n` : "", stderr: token ? "" : "gpg: decryption failed: No secret key" } : { code: 0, stdout: "", stderr: "" });
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    const a = (answer ?? ((u) => (u.includes("/issue/") ? { status: 200, json: { fields: { description: "Users are logged out after 5 minutes." } } } : { status: 200, json: SEARCH })))(url);
    return { status: a.status, ok: a.status >= 200 && a.status < 300, url, json: async () => a.json, text: async () => JSON.stringify(a.json) };
  };
  const tasks = [];
  const cx = { spawn: (fn) => { tasks.push(fn(cx)); }, notify() {}, stop_propagation() {}, timer: { every() {}, after() {} }, focus_handle: () => ({ focus() {} }) };
  const view = new Jira();
  view.init({}, cx);
  // The first spawned task is the nextCommand loop, which never settles.
  const settle = async () => { for (let i = 1; i < tasks.length; i++) await tasks[i]; };
  const press = (key) => view.key({ key, keystroke: key, modifiers: {} }, cx);
  const save = () => view.key({ key: "s", keystroke: "cmd-s", modifiers: { platform: true } }, cx);
  return { view, cx, requests, settle, press, save };
}

test("s opens jira.json in the panel; cmd-s saves it and reloads with the new settings", async () => {
  const { view, requests, settle, press, save } = setup();
  await settle();
  const before = world.files[CONFIG];
  press("s");
  await settle();
  const { state } = view.editing;
  assert.equal(state.value(), before);
  assert.ok(state.focused, "the editor gets the keyboard");
  const drawn = text(view.render());
  assert.ok(drawn.includes("Jira settings") && drawn.includes("Save"), drawn);
  assert.ok(!drawn.includes("PLAT-1"), "the list is hidden while editing");

  press("j");
  assert.equal(view.at, 0, "letters go to the editor, not the list");
  const next = JSON.stringify({ base_url: "https://jira.example.com", token_on: "box", filters: [{ name: "Bugs", jql: "type = Bug" }] }, null, 2);
  state.set_value(next);
  save();
  await settle();
  assert.equal(world.files[CONFIG], next);
  assert.deepEqual(calls.write.map((w) => w.expected), [before], "written only over the text it opened");
  assert.equal(view.editing, null);
  assert.ok(state.released);
  assert.equal(new URL(requests.at(-1).url).searchParams.get("jql"), "type = Bug");
  assert.ok(text(view.render()).includes("PLAT-1"));
});

test("settings that would not load are not saved, and say why", async () => {
  const { view, settle, press, save } = setup();
  await settle();
  const before = world.files[CONFIG];
  press("s");
  await settle();
  view.editing.state.set_value('{ "base_url": "jira" }');
  save();
  await settle();
  assert.match(view.note, /^Not saved: .*base_url/);
  assert.equal(world.files[CONFIG], before);
  assert.equal(calls.write.length, 0);
  assert.ok(view.editing, "still editing");
  assert.ok(text(view.render()).includes("Not saved"));
});

test("a file changed elsewhere since opening is not overwritten", async () => {
  const { view, settle, press, save } = setup();
  await settle();
  press("s");
  await settle();
  const elsewhere = JSON.stringify({ base_url: "https://other.example.com" });
  world.files[CONFIG] = elsewhere;
  view.editing.state.set_value(JSON.stringify({ base_url: "https://mine.example.com" }));
  save();
  await settle();
  assert.equal(world.files[CONFIG], elsewhere);
  assert.match(view.note, /Not saved: .*changed elsewhere/);
  assert.equal(view.editing.saving, false, "Save works again");
});

test("with no jira.json, Settings starts from a template and Save creates the file", async () => {
  const { view, cx, settle, press, save } = setup();
  await settle();
  delete world.files[CONFIG];
  press("r");
  await settle();
  assert.equal(view.problem.title, "Set up Jira");
  find(view.render(), "jira-settings").handlers.on_click({}, cx);
  await settle();
  assert.match(view.editing.state.value(), /"base_url": "https:\/\/jira.example.com"/);
  save();
  await settle();
  assert.deepEqual(calls.write.map((w) => w.expected), [null], "created, not overwritten");
  assert.equal(view.problem, null);
  assert.equal(view.issues.length, 2);
});

test("Esc closes the editor only when nothing changed; Cancel discards", async () => {
  const { view, cx, settle, press } = setup();
  await settle();
  press("s");
  await settle();
  press("escape");
  assert.equal(view.editing, null, "unchanged: Esc closes");
  press("s");
  await settle();
  view.editing.state.set_value("{}");
  press("escape");
  assert.ok(view.editing, "changed: Esc keeps the typing");
  assert.match(view.note, /Unsaved changes/);
  find(view.render(), "jira-settings-cancel").handlers.on_click({}, cx);
  assert.equal(view.editing, null);
  assert.equal(calls.write.length, 0);
});

test("loads the first filter with a bearer token read on the configured machine", async () => {
  const { view, requests, settle } = setup();
  await settle();
  assert.equal(view.problem, null);
  assert.deepEqual(view.issues.map((i) => i.key), ["PLAT-1", "PLAT-2"]);
  assert.deepEqual(calls.exec[0], { command: "pass", args: ["show", "jira/token"], options: { on: "box", timeout: 15000 } });
  assert.equal(requests[0].options.headers.Authorization, "Bearer s3cret");
  assert.equal(new URL(requests[0].url).searchParams.get("jql"), "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC");
  const drawn = text(view.render());
  for (const expected of ["PLAT-1", "Fix login timeout", "In Progress", "PLAT-2", "Agent", "Worktree"]) assert.ok(drawn.includes(expected), expected);
  assert.ok(!drawn.includes("s3cret"), "the token is never drawn");
  assert.equal(store.size, 0, "nothing stored until a filter is picked");
});

test("a missing config explains itself and calls nothing", async () => {
  const { view, requests, settle } = setup();
  delete world.files[CONFIG];
  view.config = null; view.load({ spawn: (fn) => fn({ notify() {} }), notify() {} }, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(view.problem.title, "Set up Jira");
  assert.ok(text(view.render()).includes("jira.json"));
  await settle();
  assert.ok(requests.length <= 1);
});

test("a locked token is reported with how to unlock it, and Jira is not called", async () => {
  const { view, requests, settle } = setup({ token: "" });
  await settle();
  assert.equal(view.problem.title, "The Jira token is locked or missing");
  assert.match(view.problem.detail, /pass show jira\/token" on box .*No secret key.*on box to unlock/);
  assert.equal(requests.length, 0);
  assert.ok(text(view.render()).includes("locked or missing"));
});

test("401 drops the token so the next load reads it again", async () => {
  const { view, settle } = setup({ answer: () => ({ status: 401, json: {} }) });
  await settle();
  assert.match(view.problem.detail, /401/);
  assert.equal(view.token, null);
});

test("cloud falls back to the earlier search endpoint on 404", async () => {
  const { view, requests, settle } = setup({ config: { flavor: "cloud", auth: "basic", email: "a@b.c" }, answer: (u) => (u.includes("/search/jql") ? { status: 404, json: {} } : { status: 200, json: SEARCH }) });
  await settle();
  assert.equal(view.issues.length, 2);
  assert.deepEqual(requests.map((r) => new URL(r.url).pathname), ["/rest/api/2/search/jql", "/rest/api/2/search"]);
  assert.match(requests[0].options.headers.Authorization, /^Basic /);
  assert.equal(calls.exec.length, 1, "the token is read once and reused");
});

test("keys move the selection and switch filters", async () => {
  const { view, requests, settle, press } = setup({ config: { filters: [{ name: "Mine", jql: "assignee = currentUser()" }, { name: "Bugs", jql: "type = Bug" }] } });
  await settle();
  press("j"); assert.equal(view.at, 1);
  press("j"); assert.equal(view.at, 1, "stops at the end");
  press("k"); assert.equal(view.at, 0);
  press("2"); await settle();
  assert.equal(view.filter, 1);
  assert.equal(store.get("filter"), "1");
  assert.equal(new URL(requests.at(-1).url).searchParams.get("jql"), "type = Bug");
  press("9"); assert.equal(view.filter, 1, "a filter that doesn't exist is ignored");
  assert.ok(text(view.render()).includes("2 Bugs"));
  assert.equal(view.key({ key: "d", modifiers: { control: true } }, {}), undefined, "ctrl+d is left to the terminal bindings");
  assert.equal(calls.run.length, 0);
});

test("o opens the issue in the browser on this computer", async () => {
  const { settle, press } = setup();
  await settle();
  press("o");
  assert.deepEqual(calls.exec.at(-1), { command: "open", args: ["https://jira.example.com/browse/PLAT-1"], options: {} });
});

test("d starts the agent in a new tab with the issue as its first message", async () => {
  const { view, settle, press } = setup({ config: { agent: ["claude", "--model", "opus"] } });
  await settle();
  press("d");
  assert.match(view.busy, /PLAT-1/);
  await settle();
  assert.equal(view.busy, null);
  assert.equal(view.note, null);
  assert.equal(calls.run.length, 1);
  const { name, args } = calls.run[0];
  assert.equal(name, "tab.new");
  assert.equal(args.name, "PLAT-1");
  assert.deepEqual(args.argv, ["claude", "--model", "opus"]);
  for (const part of ["PLAT-1", "Fix login timeout", "https://jira.example.com/browse/PLAT-1", "Users are logged out after 5 minutes."]) assert.ok(args.task.includes(part), part);
});

test("w makes a worktree on the space's machine, then a space with the agent", async () => {
  const { view, settle, press } = setup();
  world.spaces = [{ id: "box/s1", name: "api", active: true, machine: "box", folder: "/srv/api", tabs: [{ id: "box/t1" }] }];
  world.panes = [{ tab: "box/t1", cwd: "/srv/api/src" }];
  const git = [];
  world.exec = (command, args, options) => {
    if (command === "pass") return { code: 0, stdout: "s3cret\n", stderr: "" };
    if (command === "sh") return { code: 0, stdout: "/home/alik", stderr: "" };
    git.push({ args, options });
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { code: 0, stdout: "/srv/api\n", stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: "/srv/api/.git\n", stderr: "" };
    if (args[0] === "show-ref") return { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  await settle();
  press("w");
  await settle();
  assert.equal(view.note, null);
  const add = git.find((g) => g.args[0] === "worktree");
  assert.deepEqual(add.args, ["worktree", "add", "-b", "PLAT-1-fix-login-timeout", "/home/alik/.herdr/worktrees/api/PLAT-1-fix-login-timeout", "HEAD"]);
  assert.equal(add.options.on, "box");
  assert.equal(add.options.cwd, "/srv/api");
  assert.ok(git.every((g) => g.options.on === "box"), "every git command runs on the space's machine");
  assert.equal(calls.run[0].name, "space.new");
  assert.deepEqual({ ...calls.run[0].args, task: undefined }, { folder: "/home/alik/.herdr/worktrees/api/PLAT-1-fix-login-timeout", machine: "box", tab: "PLAT-1", argv: ["claude"], task: undefined });
  assert.ok(calls.run[0].args.task.includes("Users are logged out"));
});

test("a failed worktree shows git's message and opens nothing", async () => {
  const { view, settle, press } = setup();
  world.spaces = [{ id: "s1", name: "notes", active: true, machine: null, folder: "/tmp/notes", tabs: [] }];
  world.exec = (command) => (command === "pass" ? { code: 0, stdout: "s3cret\n", stderr: "" } : { code: 128, stdout: "", stderr: "fatal: not a git repository" });
  await settle();
  press("w");
  await settle();
  assert.match(view.note, /not in a git repository/);
  assert.equal(calls.run.length, 0);
  assert.ok(text(view.render()).includes("not in a git repository"));
});

test("under `herdr-app check` it draws without running commands or calling Jira", () => {
  reset();
  world.checking = true;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; };
  const view = new Jira();
  view.init({}, { spawn() { throw new Error("no tasks during a check"); }, timer: { every() { throw new Error("no timers during a check"); } }, focus_handle: () => ({ focus() {} }) });
  assert.ok(text(view.render()).includes("Loading"));
  assert.equal(calls.exec.length + calls.read.length + fetched, 0);
});

test("the count for the first filter comes from the list itself, with no extra request", async () => {
  const { requests, settle } = setup();
  await settle();
  assert.equal(world.shared["jira.count"], "2");
  assert.equal(requests.length, 1);
});

test("count_filter names another filter: it is searched once per load, not on filter switches", async () => {
  const filters = [{ name: "Mine", jql: "assignee = currentUser()" }, { name: "Bugs", jql: "type = Bug" }];
  const { requests, settle, press } = setup({ config: { filters, count_filter: 2 }, answer: (u) => ({ status: 200, json: u.includes("Bug") ? { total: 7, issues: [] } : SEARCH }) });
  await settle();
  assert.equal(world.shared["jira.count"], "7");
  assert.deepEqual(requests.map((r) => new URL(r.url).searchParams.get("jql")), ["assignee = currentUser()", "type = Bug"]);
  press("2"); await settle();
  press("1"); await settle();
  assert.equal(requests.length, 4, "switching filters adds no count requests");
  assert.equal(world.shared["jira.count"], "7");
});

test("no count when count_filter is null or Jira can't be read", async () => {
  const off = setup({ config: { count_filter: null } });
  await off.settle();
  assert.equal(world.shared["jira.count"] ?? null, null);
  const locked = setup({ token: "" });
  world.shared["jira.count"] = "5"; // from an earlier run
  locked.press("r");
  await locked.settle();
  assert.equal(world.shared["jira.count"], null, "a stale number is cleared");
});

test("as a tab-bar toggle it only shows or hides the jira-panel node", () => {
  reset();
  world.props = { role: "toggle" };
  world.files[CONFIG] = JSON.stringify({ base_url: "https://jira.example.com" });
  const panel = { id: "jira-panel", hidden: true, children: [] };
  world.layout = { id: "root", children: [{ id: "work", children: [panel] }] };
  const view = new Jira();
  view.init({}, { spawn() { throw new Error("a toggle starts no work"); }, timer: { every() { throw new Error("no timers"); } }, focus_handle: () => ({ focus() {} }) });
  assert.equal(calls.read.length + calls.exec.length, 0);
  const button = find(view.render(), "jira-toggle");
  assert.equal(text(view.render()), "Jira", "no badge before the panel has counted");
  button.handlers.on_click();
  assert.deepEqual(calls.run, [{ name: "layout.toggle", args: { id: "jira-panel" } }]);
  world.shared["jira.count"] = "12";
  assert.equal(text(view.render()), "Jira 12");
});

test("clicking a row selects it; the buttons do what the keys do", async () => {
  const { view, cx, settle } = setup();
  await settle();
  find(view.render(), "jira-PLAT-2").handlers.on_click({}, cx);
  assert.equal(view.at, 1);
  find(view.render(), "jira-agent").handlers.on_click({}, cx);
  await settle();
  assert.equal(calls.run[0].args.name, "PLAT-2");
});
