# Jira panel for the Herdr desktop app

A mod that lists your Jira issues beside your terminals and hands one to a
coding agent, in a new tab or in a fresh git worktree.

Written against herdr-app 0.1.16's mod API (`AGENTS.md`, `herdr.d.ts`). The app
changes that API often, so run the check below after every app update.

## Install

On the computer that runs the Herdr app:

```sh
./install.sh
```

It copies `mods/jira/` to `~/.config/herdr-app/mods/jira/` (replacing any
earlier copy), copies `jira.example.json` to `~/.config/herdr-app/jira.json`
if that file doesn't exist yet, and runs `herdr-app check` if `herdr-app` is
on your `PATH`. Then edit `jira.json`, in any editor or with `s` in the panel.
Re-run it after pulling updates; your settings are kept.

To install by hand instead:

1. Copy `mods/jira/` to `~/.config/herdr-app/mods/jira/`.
2. Copy `jira.example.json` to `~/.config/herdr-app/jira.json` and edit it.
3. Validate it:

   ```sh
   herdr-app check ~/.config/herdr-app/mods/jira
   herdr-app status
   ```

The first time Herdr sees the folder it docks the panel on the right. To open
it elsewhere:

```sh
herdr-app do pane.split --direction right --mod jira   # beside the focused pane
herdr-app do tab.new --mod jira                        # as its own tab
```

### A Jira button in the tab bar

The shipped tab bar draws only Files and Changes, and Herdr's own layouts are
read-only, so the button lives in a layout of your own. If you don't have one,
clone `main` first:

```sh
herdr-app do layout.clone '{"name":"main","as":"my-layout"}'
```

In `~/.config/herdr-app/layouts/my-layout.json`:

1. Wrap the `tabs` block in a row and add the button after it. The button is
   a second copy of this mod, which only shows or hides `jira-panel`. It also
   shows how many issues the filter numbered `count_filter` matches (see
   Settings); the panel counts them when it loads, and the button just reads
   that number:

   ```json
   { "id": "tabs-row", "type": "row", "size": { "px": 42 }, "resizable": false, "children": [
     { "id": "tabs", "type": "block", "content": { "mod": "tabs" }, "window_drag": true },
     { "id": "jira-toggle", "type": "block", "content": { "mod": "jira", "props": { "role": "toggle" } }, "size": { "px": 88 } }
   ] }
   ```

2. Add the panel at the end of `work-body`'s `children`, after the `panel`
   column. Add `"hidden": true` if it should start closed:

   ```json
   { "id": "jira-panel", "type": "column", "size": { "px": 360 }, "min": 300, "max": 720, "children": [
     { "id": "jira", "type": "block", "content": { "mod": "jira" } }
   ] }
   ```

3. Remove the block Herdr docked at the window's edge when it first saw the
   mod (`"content": { "mod": "jira" }` with a generated id), so the panel
   isn't shown twice.

Layouts apply live; `herdr-app status` lists any errors.

To bind a key, add this to the `global` section of `keys.json`. Editing that
file makes it yours: Herdr stops adding new default shortcuts to it.

```json
"ctrl-shift-j": { "command": "tab.new", "args": { "mod": "jira" } }
```

## Settings: `~/.config/herdr-app/jira.json`

Press `s` in the panel, or click Settings, to edit this file right there.
Herdr's own Settings screen has no place for mods, so this is the panel's own
editor. If the file doesn't exist yet, the editor starts from a template.
cmd-s or ctrl-s (or Save) checks the settings the way loading does and saves
only if they're valid, then reloads. If the file changed somewhere else after
you opened it, the save is refused rather than overwriting it. Esc closes the
editor only when nothing changed; Cancel discards your changes.

| Key | Meaning | Default |
|---|---|---|
| `base_url` | Your Jira address. Required. | |
| `flavor` | `"server"` (Server / Data Center) or `"cloud"` | `"server"` |
| `auth` | `"bearer"` (personal access token) or `"basic"` (email + API token) | `"bearer"` |
| `email` | Your Atlassian email. Needed for `"basic"`. | |
| `token_cmd` | Command that prints the token on its first line | `["pass", "show", "jira/token"]` |
| `token_on` | Machine that runs `token_cmd`, as `hc machine ls` names it; `null` for this computer | `null` |
| `filters` | List of `{ "name", "jql" }` | one filter, "Mine" |
| `agent` | Command that starts your agent | `["claude"]` |
| `branch` | Worktree branch name; `{key}` and `{slug}` are filled in | `"{key}-{slug}"` |
| `prompt` | The agent's first message; `{key}` `{summary}` `{url}` `{type}` `{status}` `{description}` | see `jira.js` |
| `max_results` | Issues per filter, 1 to 200 | `50` |
| `refresh_minutes` | How often the list reloads | `5` |
| `count_filter` | Which filter the tab-bar button counts, numbered from 1 like the panel's filter tabs; `null` for no count. Jira Cloud only says whether more issues follow, so beyond `max_results` it shows e.g. `50+` | `1` |

Token examples:

- `pass` on a remote machine: `"token_cmd": ["pass", "show", "jira/token"], "token_on": "my-remote-box"`.
  The store must be unlocked there (run `pass show jira/token` in a terminal on
  that machine once after a reboot), then press `r` in the panel.
- macOS Keychain: `"token_cmd": ["security", "find-generic-password", "-s", "jira", "-w"], "token_on": null`.

## Keys

Click the panel, or move onto it with `pane.go`, to give it the keyboard.

| Key | Action |
|---|---|
| `↑` `↓` or `j` `k` | Move |
| `Enter` or `o` | Open the issue in your browser |
| `d` | Start the agent in a new tab of the shown space, with the issue as its first message |
| `w` | Make a worktree for the issue in the shown space's repo, then start the agent there |
| `f`, `1`-`9` | Next filter, or filter by number |
| `r` | Reload settings and issues |
| `s` | Edit `jira.json` in the panel (also the Settings button) |

## How it works

- The token command runs through `exec`, on `token_on` if set. The token stays
  in memory, is sent only to `base_url`, and is never written to disk or drawn.
- Jira is called with `fetch` from the computer running the app, so that
  computer must be able to reach `base_url`.
- Worktrees go where Herdr's own worktree mod puts them
  (`worktrees.directory` in `settings.json`, else `~/.herdr/worktrees`), on the
  space's machine, on a new branch from `HEAD`.

## Trust

Mods are unsandboxed: this one runs your token command, `git`, and your
browser opener, and talks to your Jira. Read `main.js` and `jira.js` before
installing; together they are about 600 lines.

## Tests

```sh
npm test
```

`jira.js` holds the logic with no app imports. The tests run it, and run the
real `main.js` against stand-ins for the app's modules (`test/stubs/`): they
cover loading, the token and error paths, keys, and the commands sent to
Herdr. They do not prove the panel draws correctly in the app; `herdr-app
check` and a look at the window do that.
