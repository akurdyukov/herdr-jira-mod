// Jira issues beside your terminals. Lists the issues a saved JQL filter
// returns (yours by default), opens one in the browser, and hands one to a
// coding agent: in a new tab of the shown space, or in a fresh git worktree.
//
// Settings: ~/.config/herdr-app/jira.json (see README.md).
// Keys while the panel has the keyboard: ↑/↓ or j/k move, Enter or o open,
// d agent in a new tab, w agent in a new worktree, f or 1-9 filter, r reload,
// s edit jira.json here (cmd/ctrl-s save, Esc close when unchanged).

import { View, div } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, Editor, EditorState } from "gpui-base";
import { exec, run, theme, settings, spaces, panes, home, appHome, readTextFile, writeTextFile, window, nextCommand, checking, layout, shared, setShared, props as blockProps } from "herdr";
import { parseConfig, starterConfig, tokenFrom, authHeader, searchUrl, issueUrl, browseUrl, issuesFrom, countFrom, branchName, promptFor, folderName, httpMessage } from "./jira.js";

// Something the panel explains to the person instead of a stack trace.
class Problem extends Error {
  constructor(title, detail) {
    super(detail);
    this.title = title;
    this.detail = detail;
  }
}

const firstLine = (text) => (text ?? "").trim().split("\n")[0] ?? "";

// With props { "role": "toggle" } the block is a tab-bar button that shows or hides the
// layout node with this id; the panel lives in that node (see README.md).
const PANEL = "jira-panel";
// The panel publishes count_filter's issue count here for the button to draw.
const COUNT = "jira.count";
const publishCount = (value) => { if (shared(COUNT) !== value) setShared(COUNT, value); };

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const hit = findNode(child, id); if (hit) return hit; }
  return null;
}

export default class Jira extends View {
  init(_props, cx) {
    this.role = blockProps()?.role === "toggle" ? "toggle" : "panel";
    if (this.role === "toggle") return; // just a button: no token, no Jira
    this.config = null;
    this.problem = null; // { title, detail } shown in place of the list
    this.issues = [];
    this.at = 0;
    this.filter = Number(localStorage.getItem("filter") ?? 0) || 0;
    this.pending = 0; // loads in flight
    this.seq = 0; // the newest search; older answers are dropped
    this.loadedAt = 0;
    this.token = null; // kept in memory only, never stored
    this.busy = null; // "Starting agent…" while an action runs
    this.note = null; // the last action's error
    this.editing = null; // { state, original, saving } while jira.json is open here
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    // `herdr-app check` runs init for real: don't run the token command or call Jira there.
    if (checking()) return;

    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.handle.focus();
        else if (command === "refresh") this.load(cx, true);
        cx.notify();
      }
    });
    // One tick a minute decides whether the list is old enough to fetch again.
    cx.timer.every(60000, (cx) => {
      if (this.config && !this.pending && Date.now() - this.loadedAt >= this.config.refresh_minutes * 60000) this.load(cx);
    });
    this.load(cx, true);
  }

  // ---- loading ----

  // `recount`: also refresh the tab-bar count (not needed when only the shown filter changed).
  load(cx, rereadConfig = false, recount = true) {
    this.pending++;
    cx.spawn(async (cx) => {
      try {
        if (rereadConfig || !this.config) await this.readConfig();
        if (this.config) await this.search();
        if (this.config && recount) await this.count();
      } catch (e) {
        this.problem = e instanceof Problem ? { title: e.title, detail: e.detail } : { title: "Something went wrong", detail: String(e) };
        if (recount) publishCount(null);
      }
      this.pending--;
      this.loadedAt = Date.now();
      cx.notify();
    });
  }

  configPath() {
    return `${appHome()}/jira.json`;
  }

  async readConfig() {
    const path = this.configPath();
    const parsed = parseConfig(await readTextFile(path));
    this.token = null; // a changed config may mean a changed token
    if (parsed.error) {
      this.config = null;
      this.issues = [];
      throw parsed.error === "missing"
        ? new Problem("Set up Jira", `Press s or Settings to create ${path} with your Jira address and how to read your token. The mod's README explains each setting.`)
        : new Problem("Settings problem", parsed.error);
    }
    this.config = parsed.config;
    if (this.filter >= this.config.filters.length) this.filter = 0;
  }

  async readToken() {
    if (this.token) return this.token;
    const c = this.config, [command, ...args] = c.token_cmd;
    const where = c.token_on ? ` on ${c.token_on}` : "";
    let r;
    try {
      r = await exec(command, args, { on: c.token_on, timeout: 15000 });
    } catch (e) {
      throw new Problem("Could not read the Jira token", `Running "${c.token_cmd.join(" ")}"${where} failed: ${e}`);
    }
    const token = r.code === 0 ? tokenFrom(r.stdout) : "";
    if (!token) {
      const why = firstLine(r.stderr) || `exit code ${r.code}`;
      throw new Problem("The Jira token is locked or missing", `"${c.token_cmd.join(" ")}"${where} gave no token (${why}). Run it in a terminal${where} to unlock it, then press r here.`);
    }
    this.token = token;
    return token;
  }

  async get(url) {
    const token = await this.readToken();
    let response;
    try {
      response = await fetch(url, { headers: { Accept: "application/json", Authorization: authHeader(this.config, token) } });
    } catch (e) {
      throw new Problem("Could not reach Jira", `${this.config.base_url} did not answer from this computer: ${e?.message ?? e}`);
    }
    if (response.status === 401) this.token = null; // read it again next time
    return response;
  }

  // One search, answered as JSON.
  async query(jql) {
    const c = this.config;
    let response = await this.get(searchUrl(c, jql));
    // Older Cloud sites and proxies only know the earlier endpoint.
    if (response.status === 404 && c.flavor === "cloud") response = await this.get(searchUrl(c, jql, true));
    if (!response.ok) throw new Problem("Jira request failed", httpMessage(response.status));
    return response.json();
  }

  async search() {
    const seq = ++this.seq, index = this.filter;
    const json = await this.query(this.config.filters[index].jql);
    if (seq !== this.seq) return; // a newer search (another filter) owns the list now
    const issues = issuesFrom(json), key = this.issues[this.at]?.key;
    this.issues = issues;
    this.at = Math.max(0, issues.findIndex((i) => i.key === key));
    this.problem = null;
    if (index === this.config.count_filter - 1) publishCount(countFrom(json));
  }

  // The tab-bar button's number. When the list shows that filter, search() already set it.
  async count() {
    const n = this.config.count_filter;
    if (n === null) return publishCount(null);
    if (n - 1 === this.filter) return;
    try {
      publishCount(countFrom(await this.query(this.config.filters[n - 1].jql)));
    } catch {
      publishCount(null); // no number rather than a stale one
    }
  }

  // ---- actions ----

  setFilter(index, cx) {
    if (!this.config || index >= this.config.filters.length || index === this.filter) return;
    this.filter = index;
    localStorage.setItem("filter", String(index));
    this.issues = [];
    this.at = 0;
    this.seq++; // drop the answer for the filter we just left
    this.load(cx, false, false);
  }

  move(by) {
    if (!this.issues.length) return;
    this.at = Math.max(0, Math.min(this.issues.length - 1, this.at + by));
    this.scroll.scroll_to_item(this.at);
  }

  open(issue) {
    if (!issue) return;
    const platform = window().platform;
    const opener = platform === "macos" ? "open" : platform === "windows" ? "explorer" : "xdg-open";
    exec(opener, [browseUrl(this.config, issue.key)]).catch(() => {});
  }

  act(label, cx, work) {
    if (this.busy) return;
    this.busy = label;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        await work();
      } catch (e) {
        this.note = e instanceof Problem ? e.detail : String(e);
      }
      this.busy = null;
      cx.notify();
    });
  }

  // The agent's first message: the issue with its description.
  async task(issue) {
    const response = await this.get(issueUrl(this.config, issue.key));
    if (!response.ok) throw new Problem("Jira request failed", httpMessage(response.status));
    const json = await response.json();
    return promptFor(this.config, issue, json?.fields?.description);
  }

  startAgent(issue, cx) {
    if (!issue) return;
    this.act(`Starting an agent for ${issue.key}…`, cx, async () => {
      const task = await this.task(issue);
      // No space named: the tab opens in the shown space, on that space's machine.
      run("tab.new", { name: issue.key, argv: this.config.agent, task });
    });
  }

  startWorktree(issue, cx) {
    if (!issue) return;
    this.act(`Making a worktree for ${issue.key}…`, cx, async () => {
      const space = spaces().find((s) => s.active);
      if (!space) throw new Problem("", "Show a space in the repository first.");
      const on = space.machine ?? null;
      const tabs = new Set(space.tabs.map((t) => t.id));
      const folder = panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder;
      if (!folder) throw new Problem("", `Could not tell which folder ${space.name} is in.`);
      const git = async (cwd, args, timeout) => {
        const r = await exec("git", args, { cwd, on, ...(timeout ? { timeout } : {}) });
        return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
      };
      const top = await git(folder, ["rev-parse", "--show-toplevel"]);
      const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      if (!top.ok || !common.ok) throw new Problem("", `${space.name} is not in a git repository.`);
      const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
      const parts = main.split("/"), repo = parts.at(-1) === ".bare" ? parts.at(-2) : parts.at(-1);

      // Ask Jira before touching git, so a failed request leaves no checkout behind.
      const task = await this.task(issue);
      const branch = branchName(this.config, issue);
      const path = `${await this.worktreeRoot(on)}/${repo}/${folderName(branch)}`;
      const exists = (await git(main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
      const add = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "HEAD"];
      const made = await git(top.out, add, 600000);
      if (!made.ok) throw new Problem("", made.err || "git worktree add failed.");
      // Unnamed, like Herdr's own worktree spaces, so it nests under its repo.
      run("space.new", { folder: path, machine: on ?? "", tab: issue.key, argv: this.config.agent, task });
    });
  }

  // Where Herdr's own worktree mod puts checkouts (settings.json, else ~/.herdr/worktrees).
  async worktreeRoot(on) {
    let userHome = home();
    if (on) {
      const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on });
      if (r.code !== 0 || !r.stdout.trim()) throw new Problem("", `Could not find the home folder on ${on}.`);
      userHome = r.stdout.trim();
    }
    let directory = "~/.herdr/worktrees";
    try {
      const raw = await readTextFile(`${appHome()}/settings.json`);
      const set = raw === null ? null : JSON.parse(raw)?.worktrees?.directory;
      if (typeof set === "string" && set.trim()) directory = set.trim();
    } catch {}
    if (directory === "~" || directory.startsWith("~/")) directory = userHome.replace(/\/$/, "") + directory.slice(1);
    return directory.replace(/\/+$/, "");
  }

  // ---- settings ----

  // Opens jira.json in an editor in the panel; a missing file starts from a template.
  editSettings(cx) {
    if (this.editing) return;
    this.editing = { state: null, original: null, saving: false }; // opening
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        const original = await readTextFile(this.configPath());
        const t = theme();
        const state = EditorState.new({ language: "json", value: original ?? starterConfig(),
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, number: t.ansi1, constant: t.ansi6, boolean: t.ansi6 } });
        this.editing = { state, original, saving: false };
        state.focus();
      } catch (e) {
        this.editing = null;
        this.note = `Could not open ${this.configPath()}: ${e?.message ?? e}`;
      }
      cx.notify();
    });
  }

  // Checks the text the way loading would, writes it only if the file is unchanged on disk, then reloads.
  saveSettings(cx) {
    const editing = this.editing;
    if (!editing?.state || editing.saving) return;
    const text = editing.state.value();
    const parsed = parseConfig(text);
    if (parsed.error) {
      this.note = `Not saved: ${parsed.error}`;
      return;
    }
    editing.saving = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(this.configPath(), text, editing.original);
        this.closeSettings();
        this.load(cx, true);
      } catch (e) {
        editing.saving = false;
        this.note = `Not saved: ${e?.message ?? e}. If jira.json changed elsewhere since you opened it, press Cancel, then s to edit the current file.`;
      }
      cx.notify();
    });
  }

  closeSettings() {
    this.editing?.state?.release();
    this.editing = null;
    this.note = null;
    this.handle.focus();
  }

  // Esc must not throw away typing: it closes only when nothing changed.
  escapeSettings() {
    const { state, original } = this.editing;
    if (state && state.value() !== (original ?? starterConfig())) this.note = "Unsaved changes: press Save, or Cancel to discard them.";
    else this.closeSettings();
  }

  key(e, cx) {
    const m = e.modifiers ?? {};
    if (this.editing) {
      // Every other key belongs to the editor (they reach this handler on their way up).
      if (e.keystroke === "cmd-s" || e.keystroke === "ctrl-s") this.saveSettings(cx);
      else if (e.keystroke === "escape") this.escapeSettings();
      else return;
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (m.control || m.alt || m.platform) return;
    const k = e.key, selected = this.issues[this.at];
    if (k === "down" || k === "j") this.move(1);
    else if (k === "up" || k === "k") this.move(-1);
    else if (k === "enter" || k === "o") this.open(selected);
    else if (k === "d") this.startAgent(selected, cx);
    else if (k === "w") this.startWorktree(selected, cx);
    else if (k === "r") this.load(cx, true);
    else if (k === "s") this.editSettings(cx);
    else if (k === "f" && this.config) this.setFilter((this.filter + 1) % this.config.filters.length, cx);
    else if (/^[1-9]$/.test(k)) this.setFilter(Number(k) - 1, cx);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // ---- drawing ----

  // Drawn like the tab bar's Files and Changes buttons.
  renderToggle() {
    const t = theme(), node = findNode(layout(), PANEL), on = Boolean(node) && !node.hidden;
    const count = shared(COUNT);
    return h_flex().size_full().pr(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("jira-toggle").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => run("layout.toggle", { id: PANEL }))
        .child("Jira")
        .when(typeof count === "string", (el) => el.child(div().id("jira-count").px(5).rounded(4).border_1().border_color(t.border).text_size(10).child(count))));
  }

  render() {
    if (this.role === "toggle") return this.renderToggle();
    const t = theme(), c = this.config, selected = this.issues[this.at];
    const loading = this.pending > 0;
    const statusColor = (issue) => (issue.category === "done" ? t.done : issue.category === "indeterminate" ? t.working : t.muted);

    const button = (id, label, enabled, onClick) =>
      div().id(id).px(8).py(3).rounded(6).border_1().border_color(t.border).text_size(11)
        .text_color(enabled ? t.foreground : t.dim)
        .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick))
        .child(label);

    // A card like the Files and Changes panels.
    const root = v_flex().id("jira").track_focus(this.handle).size_full().min_h(0).rounded(10).overflow_hidden().border_1().border_color(t.border)
      .bg(t.chrome).text_size(13).text_color(t.foreground)
      // A click in the editor must leave the keyboard there.
      .on_click(() => { if (!this.editing) this.handle.focus(); })
      .on_key_down((e, cx) => this.key(e, cx));
    const bar = () => h_flex().h(38).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border);
    const noteLine = () => div().text_size(11).text_color(t.ansi1).child(this.note ?? "");

    if (this.editing) {
      const { state, saving } = this.editing, font = settings();
      return root
        .child(bar()
          .child(div().font_semibold().child("Jira settings"))
          .child(div().flex_1())
          .child(button("jira-settings-save", saving ? "Saving…" : "Save", Boolean(state) && !saving, (_e, cx) => { this.saveSettings(cx); cx.notify(); }))
          .child(button("jira-settings-cancel", "Cancel", !saving, (_e, cx) => { this.closeSettings(); cx.notify(); })))
        .child(state
          ? Editor.new(state).font_family(font.font_family).text_size(font.font_size).flex_1().min_h(0)
          : div().flex_1().p(14).text_size(12).text_color(t.muted).child("Loading…"))
        .child(v_flex().flex_none().p(10).gap(6).border_t(1).border_color(t.border)
          .when(Boolean(this.note), (el) => el.child(noteLine()))
          .child(div().text_size(10).text_color(t.dim).child(`${this.configPath()} · cmd/ctrl-s save · esc close · the README explains each setting`)));
    }

    const header = bar()
      .child(div().font_semibold().child("Jira"))
      .when(this.issues.length > 0, (el) => el.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(String(this.issues.length))))
      .child(div().flex_1())
      .when(loading, (el) => el.child(div().text_size(11).text_color(t.dim).child("Loading…")))
      .child(button("jira-settings", "Settings", true, (_e, cx) => { this.editSettings(cx); cx.notify(); }))
      .child(button("jira-reload", "Reload", !loading, (_e, cx) => { this.load(cx, true); cx.notify(); }));

    const filters = h_flex().flex_none().px(8).py(6).gap(4).overflow_hidden().border_b(1).border_color(t.border)
      .children((c?.filters ?? []).map((f, i) =>
        div().id(`jira-filter-${i}`).flex_none().px(8).py(2).rounded(6).text_size(11).cursor_pointer()
          .text_color(i === this.filter ? t.foreground : t.muted)
          .when(i === this.filter, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.setFilter(i, cx); cx.notify(); })
          .child(i < 9 ? `${i + 1} ${f.name}` : f.name)));

    const row = (issue, i) =>
      v_flex().id(`jira-${issue.key}`).w_full().flex_none().px(10).py(6).gap(2).rounded(7).cursor_pointer()
        .when(i === this.at, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.at = i; this.handle.focus(); cx.notify(); })
        .child(h_flex().w_full().gap(8).items_center()
          .child(div().flex_none().font_semibold().text_color(t.accent).child(issue.key))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(issue.type))
          .child(div().flex_none().text_size(11).text_color(statusColor(issue)).child(issue.status)))
        .child(div().w_full().truncate().text_color(i === this.at ? t.foreground : t.muted).child(issue.summary));

    const message = (title, detail) =>
      v_flex().flex_1().min_h(0).p(14).gap(6)
        .when(Boolean(title), (el) => el.child(div().font_semibold().child(title)))
        .child(div().text_size(12).text_color(t.muted).child(detail));

    const body = this.problem
      ? message(this.problem.title, this.problem.detail)
      : this.issues.length
        ? v_flex().id("jira-list").flex_1().min_h(0).p(6).overflow_y_scrollbar().track_scroll(this.scroll).children(this.issues.map(row))
        : message("", loading || !c ? "Loading…" : "No issues match this filter.");

    const footer = v_flex().flex_none().p(10).gap(6).border_t(1).border_color(t.border)
      .when(Boolean(selected), (el) => el
        .child(div().text_size(12).child(selected ? `${selected.key}  ${selected.summary}` : ""))
        .child(h_flex().gap(6).items_center()
          .child(button("jira-open", "Open", true, () => this.open(selected)))
          .child(button("jira-agent", "Agent", !this.busy, (_e, cx) => { this.startAgent(selected, cx); cx.notify(); }))
          .child(button("jira-worktree", "Worktree", !this.busy, (_e, cx) => { this.startWorktree(selected, cx); cx.notify(); }))))
      .when(Boolean(this.busy), (el) => el.child(div().text_size(11).text_color(t.muted).child(this.busy ?? "")))
      .when(Boolean(this.note), (el) => el.child(noteLine()))
      .child(div().text_size(10).text_color(t.dim).child("↑↓ move · o open · d agent · w worktree · f filter · r reload · s settings"));

    return root
      .child(header)
      .when(Boolean(c) && c.filters.length > 1, (el) => el.child(filters))
      .child(body)
      .child(footer);
  }
}
