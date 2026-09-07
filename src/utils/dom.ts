export function $(selector: string, parent: Element | Document = document): HTMLElement | null {
  return parent.querySelector(selector);
}

export function $$(selector: string, parent: Element | Document = document): HTMLElement[] {
  return Array.from(parent.querySelectorAll(selector));
}

export function show(el: HTMLElement | null): void {
  if (!el) return;
  el.style.display = '';
  el.classList.remove('hidden');
}

export function hide(el: HTMLElement | null): void {
  if (!el) return;
  el.style.display = 'none';
  el.classList.add('hidden');
}

// --- Safe HTML templating ------------------------------------------------
// Channel names, programme titles, logo URLs etc. come from untrusted M3U /
// XMLTV sources. Interpolating them straight into innerHTML is a DOM-XSS hole,
// so render templates use the `html` tagged template, which HTML-escapes every
// interpolated value by default. Wrap intentional, trusted markup in `raw()`.

const ESC: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

/** A string that is already trusted HTML and must not be re-escaped. */
export class Safe {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Mark a string as trusted HTML so `html` won't escape it. */
export function raw(value: string): Safe {
  return new Safe(value);
}

function esc(value: unknown): string {
  if (value instanceof Safe) return value.value;
  if (Array.isArray(value)) return value.map(esc).join('');
  if (value == null) return '';
  return String(value).replace(/[&<>"']/g, (c) => ESC[c]);
}

/**
 * Tagged template that escapes interpolated values. Nested `html` results and
 * `raw(...)` values pass through unescaped; arrays are escaped element-wise and
 * concatenated. Returns a `Safe` — call `String(...)` when assigning to innerHTML.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Safe {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += esc(values[i]);
  }
  return new Safe(out);
}

// Escape a value for use inside a `[attr="..."]` selector. Only `\` and `"`
// matter. Avoids relying on `CSS.escape` which jsdom does not implement.
export function attrSelectorEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
