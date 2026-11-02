// Small DOM helpers.

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'html') el.innerHTML = String(v);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Track a pointer drag from a pointerdown event. Returns a cancel function. */
export function trackDrag(
  e: PointerEvent | MouseEvent,
  onMove: (ev: PointerEvent, dx: number, dy: number) => void,
  onUp?: (ev: PointerEvent, moved: boolean) => void,
  opts: { threshold?: number; cursor?: string; lock?: boolean } = {},
): () => void {
  const sx = e.clientX, sy = e.clientY;
  let moved = false;
  const threshold = opts.threshold ?? 3;
  const overlay = document.createElement('div');
  overlay.className = 'drag-overlay';
  if (opts.cursor) overlay.style.cursor = opts.cursor;
  document.body.appendChild(overlay);
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    if (!moved && Math.hypot(dx, dy) < threshold) return;
    moved = true;
    onMove(ev, dx, dy);
  };
  const up = (ev: PointerEvent) => {
    cleanup();
    onUp?.(ev, moved);
  };
  const cleanup = () => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    overlay.remove();
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  return cleanup;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function isTextInput(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

/** Download a blob or text as a file. */
export function downloadFile(name: string, data: Blob | string, mime = 'application/octet-stream'): void {
  const blob = typeof data === 'string' ? new Blob([data], { type: mime }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Ask the user to pick a file. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    let done = false;
    input.addEventListener('change', () => {
      done = true;
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    // resolve null if the dialog is dismissed
    window.addEventListener('focus', () => setTimeout(() => { if (!done) { resolve(null); input.remove(); } }, 800), { once: true });
    input.click();
  });
}
