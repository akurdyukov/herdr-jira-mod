const stubs = { "gpui-kit": "./stubs/gpui-kit.mjs", "gpui-base": "./stubs/gpui-base.mjs", herdr: "./stubs/herdr.mjs" };
export async function resolve(specifier, context, next) {
  if (stubs[specifier]) return { url: new URL(stubs[specifier], import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
