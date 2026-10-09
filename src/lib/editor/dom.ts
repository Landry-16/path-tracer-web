/**
 * Tiny DOM toolkit for the editor: element factory, icons and bound input fields.
 * Every field reads its value through a getter, so `refresh()` keeps it in sync
 * with changes made elsewhere (gizmos, undo) without rebuilding the panel.
 */

import { clamp, type Vec3 } from "../core/math";

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | null | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "class") {
      el.className = String(value);
    } else if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

/* ---------------------------------------------------------------- icons */

const ICON_PATHS: Record<string, string> = {
  sphere: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8c0 1.6 2.5 2.8 5.5 2.8s5.5-1.2 5.5-2.8"/>',
  box: '<path d="M8 2.2 13.3 5v6L8 13.8 2.7 11V5z"/><path d="M2.7 5 8 7.8 13.3 5M8 7.8v6"/>',
  cylinder: '<ellipse cx="8" cy="4" rx="4.8" ry="1.8"/><path d="M3.2 4v8c0 1 2.1 1.8 4.8 1.8s4.8-.8 4.8-1.8V4"/>',
  cone: '<path d="M8 2.2 3.2 12c0 1 2.1 1.8 4.8 1.8s4.8-.8 4.8-1.8z"/>',
  plane: '<path d="M1.8 10.5 5.5 5.5h8.7l-3.7 5z"/>',
  disk: '<ellipse cx="8" cy="9" rx="6" ry="3"/>',
  area: '<path d="M3 4.5h10v3H3z"/><path d="M5 9.5 4 12M8 9.5V12.5M11 9.5l1 2.5"/>',
  "light-sphere": '<circle cx="8" cy="7" r="3.2"/><path d="M8 1.5v1M2.5 7h1M12.5 7h1M4 3l.8.8M12 3l-.8.8M6.5 12.5h3M7 14.3h2"/>',
  point: '<circle cx="8" cy="8" r="1.8"/><path d="M8 2v2M8 12v2M2 8h2M12 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M3.8 12.2l1.4-1.4M10.8 5.2l1.4-1.4"/>',
  sun: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.3v1.6M8 13.1v1.6M1.3 8h1.6M13.1 8h1.6M3.3 3.3l1.1 1.1M11.6 11.6l1.1 1.1M3.3 12.7l1.1-1.1M11.6 4.4l1.1-1.1"/>',
  eye: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.9"/>',
  "eye-off": '<path d="M2 2l12 12M6.4 3.8A6.7 6.7 0 0 1 8 3.5c4.1 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.8 2.4M4.2 5.1A11 11 0 0 0 1.5 8s2.4 4.5 6.5 4.5a6.5 6.5 0 0 0 3.2-.8"/>',
  trash: '<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"/>',
  copy: '<rect x="5" y="5" width="8.5" height="8.5" rx="1"/><path d="M3 10.5V3a.5.5 0 0 1 .5-.5H11"/>',
  undo: '<path d="M5.5 3 2.5 6l3 3"/><path d="M2.5 6h7a4 4 0 0 1 0 8H7"/>',
  redo: '<path d="M10.5 3l3 3-3 3"/><path d="M13.5 6h-7a4 4 0 0 0 0 8H9"/>',
  move: '<path d="M8 1.5v13M1.5 8h13M8 1.5 6 3.5M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2"/>',
  rotate: '<path d="M13.2 8.5A5.2 5.2 0 1 1 11.6 4"/><path d="M12.5 1.5v3h-3"/>',
  scale: '<path d="M2.5 13.5h6v-6h-6zM8.5 7.5l5-5M9.5 2.5h4v4"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  share: '<circle cx="12" cy="3.5" r="1.8"/><circle cx="4" cy="8" r="1.8"/><circle cx="12" cy="12.5" r="1.8"/><path d="M5.6 7.1l4.8-2.7M5.6 8.9l4.8 2.7"/>',
  code: '<path d="M5.5 4 1.5 8l4 4M10.5 4l4 4-4 4"/>',
  download: '<path d="M8 2v8.5M4.5 7 8 10.5 11.5 7M2.5 13.5h11"/>',
  upload: '<path d="M8 10.5V2M4.5 5.5 8 2l3.5 3.5M2.5 13.5h11"/>',
  camera: '<path d="M2 5h2.5l1.2-1.8h4.6L11.5 5H14v8H2z"/><circle cx="8" cy="9" r="2.5"/>',
  pause: '<path d="M5 3v10M11 3v10"/>',
  play: '<path d="M4.5 2.8v10.4L13 8z"/>',
  follow: '<path d="M3 2.5l4.2 10.5 1.5-4.3 4.3-1.5z"/><path d="M11.5 11.5l2.5 2.5"/>',
  panel: '<rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M6 2.5v11"/>',
  "panel-right": '<rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M10 2.5v11"/>',
  scene: '<path d="M2 12.5 6 6l3 4 2-2.5 3 5z"/><circle cx="11" cy="4" r="1.5"/>',
  material: '<circle cx="8" cy="8" r="5.5"/><path d="M5.2 5.5a3.5 3.5 0 0 1 3-1.6"/>',
  close: '<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>',
  focus: '<path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5"/><circle cx="8" cy="8" r="2"/>',
  chevron: '<path d="M4.5 6.5 8 10l3.5-3.5"/>',
};

export function icon(name: string, title?: string): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "pt-icon");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICON_PATHS[name] ?? ICON_PATHS.box;
  if (title) {
    const t = document.createElementNS(ns, "title");
    t.textContent = title;
    svg.prepend(t);
  }
  return svg;
}

export function iconButton(name: string, label: string, onClick: (e: MouseEvent) => void, extraClass = ""): HTMLButtonElement {
  const button = h("button", { type: "button", class: `pt-icon-btn ${extraClass}`.trim(), title: label, "aria-label": label }, icon(name));
  button.addEventListener("click", onClick);
  return button;
}

/* --------------------------------------------------------------- fields */

/** Focus check that also works inside shadow roots. */
export function isFocused(el: Element): boolean {
  const root = el.getRootNode() as Document | ShadowRoot;
  return root.activeElement === el;
}

export interface Field {
  el: HTMLElement;
  refresh(): void;
}

export interface FieldHooks {
  /** Value changed while editing (dragging, typing). */
  onInput: () => void;
  /** Editing finished: the change should become an undo step. */
  onCommit: () => void;
}

export interface NumberOptions {
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  /** Renders a fill bar and maps pointer drags to the absolute position (needs min and max). */
  slider?: boolean;
  suffix?: string;
}

/**
 * Numeric input that can be typed into or scrubbed: drag horizontally to change the
 * value (Shift for fine steps), click to type, arrow keys to step.
 */
export function numberInput(get: () => number, set: (v: number) => void, hooks: FieldHooks, options: NumberOptions = {}): Field {
  const { min = -Infinity, max = Infinity, step = 0.01, precision = 3, slider = false, suffix = "" } = options;
  const input = h("input", { type: "text", inputmode: "decimal", class: slider ? "pt-num pt-slider" : "pt-num", spellcheck: "false", autocomplete: "off" });
  const format = (v: number): string => `${Number(v.toFixed(precision))}${suffix}`;
  const apply = (v: number): void => {
    if (!Number.isFinite(v)) return;
    set(clamp(v, min, max));
    hooks.onInput();
    refresh();
  };
  const refresh = (): void => {
    const v = get();
    if (!isFocused(input)) input.value = format(v);
    if (slider && Number.isFinite(min) && Number.isFinite(max)) {
      const t = clamp((v - min) / (max - min), 0, 1);
      input.style.setProperty("--fill", `${(t * 100).toFixed(2)}%`);
    }
  };

  let drag: { x: number; value: number; moved: boolean; id: number } | null = null;
  input.addEventListener("pointerdown", (e) => {
    if (isFocused(input)) return;
    if (e.button !== 0) return;
    e.preventDefault();
    input.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, value: get(), moved: false, id: e.pointerId };
  });
  input.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 3) return;
    drag.moved = true;
    input.classList.add("pt-scrubbing");
    if (slider && Number.isFinite(min) && Number.isFinite(max)) {
      const rect = input.getBoundingClientRect();
      const t = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      apply(Math.round((min + t * (max - min)) / step) * step);
    } else {
      const fine = e.shiftKey ? 0.1 : 1;
      apply(Math.round((drag.value + dx * step * fine) / (step * fine)) * (step * fine));
    }
  });
  const end = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    input.classList.remove("pt-scrubbing");
    if (moved) hooks.onCommit();
    else {
      input.focus();
      input.select();
    }
  };
  input.addEventListener("pointerup", end);
  input.addEventListener("pointercancel", end);

  const commitText = (): void => {
    const raw = input.value.replace(suffix, "").replace(",", ".").trim();
    const value = raw === "" ? NaN : Number(raw);
    if (Number.isFinite(value) && value !== get()) {
      apply(value);
      hooks.onCommit();
    }
    refresh();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      commitText();
      input.blur();
    } else if (e.key === "Escape") {
      refresh();
      input.blur();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const delta = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
      apply(get() + delta);
      hooks.onCommit();
    }
  });
  input.addEventListener("blur", () => {
    commitText();
    refresh();
  });
  refresh();
  return { el: input, refresh };
}

export function row(label: string, control: HTMLElement, title?: string): HTMLElement {
  return h("div", { class: "pt-row", title }, h("label", { class: "pt-label" }, label), control);
}

export function numberField(label: string, get: () => number, set: (v: number) => void, hooks: FieldHooks, options: NumberOptions = {}): Field {
  const f = numberInput(get, set, hooks, options);
  return { el: row(label, f.el), refresh: f.refresh };
}

export function vec3Field(label: string, get: () => Vec3, set: (v: Vec3) => void, hooks: FieldHooks, options: NumberOptions = {}): Field {
  const parts = [0, 1, 2].map((i) =>
    numberInput(
      () => get()[i],
      (v) => {
        const next = [...get()] as Vec3;
        next[i] = v;
        set(next);
      },
      hooks,
      options,
    ),
  );
  const axes = ["x", "y", "z"];
  const group = h("div", { class: "pt-vec3" }, ...parts.map((p, i) => h("span", { class: `pt-axis pt-axis-${axes[i]}` }, p.el)));
  return { el: row(label, group), refresh: () => parts.forEach((p) => p.refresh()) };
}

export function colorField(label: string, get: () => string, set: (v: string) => void, hooks: FieldHooks): Field {
  const picker = h("input", { type: "color", class: "pt-color" });
  const text = h("input", { type: "text", class: "pt-hex", spellcheck: "false", maxlength: 7 });
  picker.addEventListener("input", () => {
    set(picker.value);
    text.value = picker.value;
    hooks.onInput();
  });
  picker.addEventListener("change", () => hooks.onCommit());
  const commitText = (): void => {
    const v = text.value.trim();
    const hex = /^#?[0-9a-f]{6}$/i.test(v) ? `#${v.replace("#", "").toLowerCase()}` : null;
    if (hex && hex !== get()) {
      set(hex);
      hooks.onInput();
      hooks.onCommit();
    }
    refresh();
  };
  text.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") text.blur();
  });
  text.addEventListener("blur", commitText);
  const refresh = (): void => {
    const v = get();
    picker.value = v;
    if (!isFocused(text)) text.value = v;
  };
  refresh();
  return { el: row(label, h("div", { class: "pt-color-field" }, picker, text)), refresh };
}

export function selectField<T extends string>(
  label: string,
  options: readonly { value: T; label: string }[],
  get: () => T,
  set: (v: T) => void,
  hooks: FieldHooks,
): Field {
  const select = h("select", { class: "pt-select" }, ...options.map((o) => h("option", { value: o.value }, o.label)));
  select.addEventListener("change", () => {
    set(select.value as T);
    hooks.onInput();
    hooks.onCommit();
  });
  const refresh = (): void => {
    select.value = get();
  };
  refresh();
  return { el: row(label, select), refresh };
}

export function toggleField(label: string, get: () => boolean, set: (v: boolean) => void, hooks: FieldHooks): Field {
  const input = h("input", { type: "checkbox", class: "pt-switch" });
  input.addEventListener("change", () => {
    set(input.checked);
    hooks.onInput();
    hooks.onCommit();
  });
  const refresh = (): void => {
    input.checked = get();
  };
  refresh();
  return { el: row(label, input), refresh };
}

export function textField(label: string, get: () => string, set: (v: string) => void, hooks: FieldHooks): Field {
  const input = h("input", { type: "text", class: "pt-text", spellcheck: "false" });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") input.blur();
  });
  input.addEventListener("blur", () => {
    const v = input.value.trim();
    if (v && v !== get()) {
      set(v);
      hooks.onInput();
      hooks.onCommit();
    }
    refresh();
  });
  const refresh = (): void => {
    if (!isFocused(input)) input.value = get();
  };
  refresh();
  return { el: row(label, input), refresh };
}

export function section(title: string, ...children: Child[]): HTMLDetailsElement {
  return h("details", { class: "pt-section", open: true }, h("summary", {}, icon("chevron"), h("span", {}, title)), ...children);
}
