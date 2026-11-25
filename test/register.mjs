// Maps the app's modules to stubs so main.js loads under plain Node.
import { register } from "node:module";
register("./hooks.mjs", import.meta.url);
