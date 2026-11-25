// An element that accepts any chained builder call and records the tree, so
// tests can run render() and read the text it would draw.
export function element(kind) {
  const node = { kind, children: [], handlers: {}, id: null };
  const proxy = new Proxy(node, {
    get(target, name) {
      if (name === "__node") return target;
      if (typeof name !== "string") return undefined;
      return (...args) => {
        if (name === "child") target.children.push(args[0]);
        else if (name === "children") target.children.push(...args[0]);
        else if (name === "id") target.id = args[0];
        else if (name === "when") { if (args[0]) return args[1](proxy); }
        else if (name.startsWith("on_")) target.handlers[name] = args[args.length - 1];
        else if (name === "hover") args[0](element("style"));
        return proxy;
      };
    },
  });
  return proxy;
}
export function text(el) {
  if (el === null || el === undefined) return "";
  if (typeof el === "string") return el;
  return el.__node.children.map(text).join(" ");
}
export function find(el, id) {
  if (!el || typeof el === "string") return null;
  if (el.__node.id === id) return el.__node;
  for (const c of el.__node.children) { const hit = find(c, id); if (hit) return hit; }
  return null;
}
