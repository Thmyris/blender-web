// Confirmation popups and modal dialogs.

import { h } from './dom';
import { icon } from './icons';
import { showMenu, closeAllMenus } from './menu';
import { buildLayout, type Layout, type LayoutRoot } from './layout';
import { app } from '../app';

/** Blender's "OK?" style confirmation popup at the mouse position. */
export function confirmPopup(title: string, label: string, onOk: () => void, at?: { x: number; y: number }, ic?: string): void {
  const pos = at ?? app.mouse;
  showMenu([{ label, icon: ic, action: onOk }], pos, { title, atMouse: true });
}

export interface DialogOptions {
  title: string;
  icon?: string;
  width?: number;
  draw: (layout: Layout) => void;
  okText?: string;
  onOk?: () => void | boolean;
  cancelText?: string | false;
  onCancel?: () => void;
  modal?: boolean;
}

const openDialogs: (() => void)[] = [];

export function closeTopDialog(): boolean {
  const c = openDialogs.pop();
  if (!c) return false;
  c();
  return true;
}

export function dialogOpen(): boolean { return openDialogs.length > 0; }

export function showDialog(o: DialogOptions): { close(): void; root: LayoutRoot; body: HTMLElement } {
  closeAllMenus();
  const backdrop = o.modal !== false ? h('div', { class: 'modal-backdrop' }) : null;
  const body = h('div', { class: 'dialog-body' });
  const closeBtn = h('div', { class: 'close', title: 'Close' }, icon('X'));
  const footer = h('div', { class: 'dialog-footer' });
  const el = h('div', { class: 'dialog' },
    h('div', { class: 'dialog-title' }, o.icon ? icon(o.icon) : null, h('div', { class: 'title' }, o.title), closeBtn),
    body,
  );
  if (o.width) el.style.width = `${o.width}px`;
  const root = buildLayout(body, null, o.draw);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.remove();
    backdrop?.remove();
    const i = openDialogs.indexOf(close);
    if (i >= 0) openDialogs.splice(i, 1);
    window.removeEventListener('keydown', onKey, true);
  };
  const ok = () => {
    if (o.onOk && o.onOk() === false) return;
    close();
  };
  const cancel = () => { o.onCancel?.(); close(); };
  if (o.onOk || o.okText) {
    if (o.cancelText !== false) {
      const c = h('div', { class: 'w w-button', style: { minWidth: '80px', flex: '0 0 auto' } }, h('div', { class: 'w-text' }, o.cancelText ?? 'Cancel'));
      c.addEventListener('click', cancel);
      footer.append(c);
    }
    const b = h('div', { class: 'w w-button', style: { minWidth: '80px', flex: '0 0 auto' } }, h('div', { class: 'w-text' }, o.okText ?? 'OK'));
    b.addEventListener('click', ok);
    footer.append(b);
    el.append(footer);
  }
  closeBtn.addEventListener('click', cancel);
  backdrop?.addEventListener('pointerdown', cancel);
  const onKey = (e: KeyboardEvent) => {
    if (openDialogs[openDialogs.length - 1] !== close) return;
    if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); cancel(); }
    else if (e.key === 'Enter' && o.onOk) { e.stopPropagation(); e.preventDefault(); ok(); }
  };
  window.addEventListener('keydown', onKey, true);
  if (backdrop) document.body.append(backdrop);
  document.body.append(el);
  openDialogs.push(close);
  // keep widgets in sync while open
  const tick = () => { if (closed) return; root.update(); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return { close, root, body };
}

/** Ask for a string (e.g. file name). Resolves null when cancelled. */
export function promptString(title: string, label: string, value: string, ic?: string): Promise<string | null> {
  return new Promise((resolve) => {
    let input: HTMLInputElement | null = null;
    let done = false;
    const dlg = showDialog({
      title, icon: ic, width: 360,
      draw: (l) => {
        const row = l.row();
        row.label(label).classList.add('fixed');
        input = h('input', { class: 'menu-search', value, spellcheck: 'false', style: { margin: '0', flex: '1 1 auto' } }) as HTMLInputElement;
        row.el.append(input);
      },
      okText: 'OK',
      onOk: () => { done = true; resolve(input?.value ?? null); },
      onCancel: () => { if (!done) resolve(null); },
    });
    void dlg;
    setTimeout(() => {
      if (!input) return;
      input.focus();
      const dot = input.value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { done = true; resolve(input!.value); dlg.close(); }
        if (e.key === 'Escape') { dlg.close(); resolve(null); }
      });
    }, 0);
  });
}
