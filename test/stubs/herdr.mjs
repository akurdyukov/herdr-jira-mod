// A controllable stand-in for the app. Tests set `world` and read `calls`.
export const world = {};
export const calls = { exec: [], run: [], read: [], write: [] };
export function reset() {
  Object.assign(world, { checking: false, files: {}, exec: () => ({ code: 0, stdout: "", stderr: "" }), spaces: [], panes: [], platform: "macos", commands: [], props: {}, layout: { id: "root", children: [] }, shared: {} });
  calls.exec.length = calls.run.length = calls.read.length = calls.write.length = 0;
}
reset();
export const checking = () => world.checking;
export const appHome = () => "/home/me/.config/herdr-app";
export const home = () => "/home/me";
export const readTextFile = async (path, options) => { calls.read.push({ path, options }); return world.files[path] ?? null; };
// Like the app: writes only if the file still holds `expected` (null: must not exist yet).
export const writeTextFile = async (path, text, expected) => {
  calls.write.push({ path, text, expected });
  if ((world.files[path] ?? null) !== expected) throw new Error("the file changed since it was read");
  world.files[path] = text;
  return null;
};
export const props = () => world.props;
export const shared = (key) => world.shared[key] ?? null;
export const setShared = (key, value) => { world.shared[key] = value; return null; };
export const layout = () => world.layout;
export const settings = () => ({ font_family: "Mono", font_size: 13 });
export const exec = async (command, args = [], options = {}) => { calls.exec.push({ command, args, options }); return world.exec(command, args, options); };
export const run = (name, args) => { calls.run.push({ name, args }); return null; };
export const theme = () => new Proxy({}, { get: (_t, name) => `#${String(name)}` });
export const spaces = () => world.spaces;
export const panes = () => world.panes;
export const window = () => ({ platform: world.platform });
export const nextCommand = () => new Promise(() => {}); // no key commands arrive in tests
