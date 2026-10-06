/**
 * Tiny helpers for building the interface out of plain HTML elements.
 * Text that could come from the player (island names) always goes in as text, never as HTML.
 */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

export function text<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, content: string): HTMLElementTagNameMap[K] {
  const e = el(tag, cls);
  e.textContent = content;
  return e;
}

/** A button with an icon (trusted SVG from icons.ts) and an optional visible label. */
export function iconButton(cls: string, icon: string, label: string, onClick: () => void, showLabel = false): HTMLButtonElement {
  const b = el('button', cls, icon);
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = label;
  if (showLabel) b.appendChild(text('span', '', label));
  b.addEventListener('click', onClick);
  return b;
}

/** A row of choices where exactly one is on. Returns a setter for the current value. */
export function pills<T extends string>(options: readonly (readonly [T, string])[], current: T, onPick: (v: T) => void): { row: HTMLDivElement; set(v: T): void } {
  const row = el('div', 'pills');
  row.setAttribute('role', 'radiogroup');
  const buttons: [T, HTMLButtonElement][] = [];
  const set = (v: T) => {
    for (const [k, b] of buttons) {
      b.classList.toggle('on', k === v);
      b.setAttribute('aria-checked', String(k === v));
    }
  };
  for (const [v, label] of options) {
    const b = text('button', 'pill', label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => {
      set(v);
      onPick(v);
    });
    buttons.push([v, b]);
    row.appendChild(b);
  }
  set(current);
  return { row, set };
}
