import { element } from "./element.mjs";
export const v_flex = () => element("v_flex");
export const h_flex = () => element("h_flex");
export const scrolled = [];
export const ScrollHandle = { new: () => ({ scroll_to_item: (i) => scrolled.push(i) }) };
// Tests type by calling set_value, as the person would by typing.
export const EditorState = {
  new: (options = {}) => {
    let value = options.value ?? "";
    return { options, focused: false, released: false, value: () => value, set_value(v) { value = v; }, focus() { this.focused = true; }, release() { this.released = true; return true; } };
  },
};
export const Editor = { new: () => element("editor") };
