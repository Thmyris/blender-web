// Blender-style colour picker popup: HSV circle, value slider, RGB/HSV/Hex fields.

import { h } from './dom';
import { popupLayer } from './menu';
import { colorToHex, hexToColor, hsvToRgb, linearToSrgb, rgbToHsv, srgbToLinear } from './format';

export interface ColorPickerOptions {
  get(): number[];
  set(v: number[]): void;
  onDone(changed: boolean): void;
  alpha?: boolean;
}

let current: { close(): void } | null = null;

export function closeColorPicker(): void { current?.close(); }

export function showColorPicker(anchor: DOMRect, opts: ColorPickerOptions): void {
  current?.close();
  const start = opts.get().slice();
  // picker works in display (sRGB) space like Blender's colour wheel
  const disp = () => opts.get().slice(0, 3).map((c) => Math.min(1, Math.max(0, linearToSrgb(c))));
  let [hh, ss, vv] = rgbToHsv(...(disp() as [number, number, number]));
  let changed = false;

  const wheel = h('canvas', { class: 'wheel', width: 320, height: 320 }) as HTMLCanvasElement;
  const valueBar = h('canvas', { class: 'value', width: 36, height: 320 }) as HTMLCanvasElement;
  const fields = h('div', { class: 'layout-col align' });
  const mode = { m: 'RGB' as 'RGB' | 'HSV' };
  const hexInput = h('input', { class: 'menu-search', style: { margin: '0', width: '100%' }, spellcheck: 'false' }) as HTMLInputElement;
  const modeRow = h('div', { class: 'layout-row align' });
  const el = h('div', { class: 'popup-panel' },
    h('div', { class: 'colorpicker' },
      h('div', { class: 'cp-top' }, wheel, valueBar),
      modeRow,
      fields,
      h('div', { class: 'layout-row', style: { gap: '6px' } }, h('div', { class: 'label fixed' }, 'Hex:'), hexInput),
    ),
  );

  const apply = () => {
    const rgb = hsvToRgb(hh, ss, vv).map(srgbToLinear);
    const cur = opts.get();
    const out = cur.length === 4 ? [...rgb, cur[3]] : rgb;
    opts.set(out);
    changed = true;
    draw();
  };

  const drawWheel = () => {
    const ctx = wheel.getContext('2d')!;
    const W = wheel.width, R = W / 2;
    const img = ctx.createImageData(W, W);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const dx = x - R + 0.5, dy = y - R + 0.5;
      const d = Math.hypot(dx, dy) / R;
      const i = (y * W + x) * 4;
      if (d > 1) { img.data[i + 3] = 0; continue; }
      let a = Math.atan2(-dy, dx) / (Math.PI * 2);
      if (a < 0) a += 1;
      const [r, g, b] = hsvToRgb(a, d, vv);
      img.data[i] = r * 255; img.data[i + 1] = g * 255; img.data[i + 2] = b * 255;
      img.data[i + 3] = d > 0.985 ? Math.max(0, (1 - d) / 0.015) * 255 : 255;
    }
    ctx.putImageData(img, 0, 0);
    const ang = hh * Math.PI * 2;
    const px = R + Math.cos(ang) * ss * R, py = R - Math.sin(ang) * ss * R;
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000';
    ctx.beginPath(); ctx.arc(px, py, 8, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.stroke();
  };
  const drawValue = () => {
    const ctx = valueBar.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, 0, valueBar.height);
    const [r, gg, b] = hsvToRgb(hh, ss, 1);
    g.addColorStop(0, `rgb(${r * 255},${gg * 255},${b * 255})`);
    g.addColorStop(1, '#000');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, valueBar.width, valueBar.height);
    const y = (1 - vv) * valueBar.height;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, y - 2, valueBar.width, 4);
    ctx.strokeStyle = '#000';
    ctx.strokeRect(0.5, y - 2.5, valueBar.width - 1, 5);
  };

  const numField = (label: string, get: () => number, set: (v: number) => void) => {
    const f = h('div', { class: 'w w-num' }, h('div', { class: 'w-text' }));
    const upd = () => { (f.firstChild as HTMLElement).textContent = `${label}: ${get().toFixed(3)}`; };
    upd();
    f.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      let last = e.clientX;
      let moved = false;
      const move = (ev: PointerEvent) => {
        const d = ev.clientX - last;
        if (Math.abs(ev.clientX - e.clientX) > 2) moved = true;
        last = ev.clientX;
        set(Math.min(1, Math.max(0, get() + d / 200)));
        upd();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (!moved) {
          const input = h('input', { class: 'w-edit', value: get().toFixed(3) }) as HTMLInputElement;
          f.append(input);
          input.select();
          input.focus();
          const finish = (ok: boolean) => {
            if (ok) { const v = parseFloat(input.value); if (isFinite(v)) set(Math.min(1, Math.max(0, v))); }
            input.remove();
            upd();
          };
          input.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') finish(true); if (ev.key === 'Escape') finish(false); });
          input.addEventListener('blur', () => finish(true));
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    return { el: f, upd };
  };

  let fieldUpdaters: (() => void)[] = [];
  const buildFields = () => {
    fields.innerHTML = '';
    fieldUpdaters = [];
    const add = (f: { el: HTMLElement; upd: () => void }) => { fields.append(f.el); fieldUpdaters.push(f.upd); };
    if (mode.m === 'RGB') {
      (['R', 'G', 'B'] as const).forEach((n, i) => add(numField(n, () => opts.get()[i], (v) => {
        const c = opts.get().slice(); c[i] = v; opts.set(c); changed = true;
        [hh, ss, vv] = rgbToHsv(...(disp() as [number, number, number]));
        draw(false);
      })));
    } else {
      add(numField('H', () => hh, (v) => { hh = v; apply(); }));
      add(numField('S', () => ss, (v) => { ss = v; apply(); }));
      add(numField('V', () => vv, (v) => { vv = v; apply(); }));
    }
    if (opts.alpha) add(numField('A', () => opts.get()[3] ?? 1, (v) => { const c = opts.get().slice(); c[3] = v; opts.set(c); changed = true; }));
  };
  const modeBtn = (m: 'RGB' | 'HSV') => {
    const b = h('div', { class: 'w w-radio' }, h('div', { class: 'w-text' }, m));
    b.addEventListener('pointerdown', () => { mode.m = m; modeRow.querySelectorAll('.w-radio').forEach((x) => x.classList.toggle('on', x === b)); buildFields(); });
    if (mode.m === m) b.classList.add('on');
    return b;
  };
  modeRow.append(modeBtn('RGB'), modeBtn('HSV'));

  const draw = (fieldsToo = true) => {
    drawWheel();
    drawValue();
    if (fieldsToo) for (const u of fieldUpdaters) u();
    else for (const u of fieldUpdaters) u();
    if (document.activeElement !== hexInput) hexInput.value = colorToHex(opts.get());
  };

  const wheelPick = (e: PointerEvent) => {
    const r = wheel.getBoundingClientRect();
    const R = r.width / 2;
    const dx = e.clientX - r.left - R, dy = e.clientY - r.top - R;
    let a = Math.atan2(-dy, dx) / (Math.PI * 2);
    if (a < 0) a += 1;
    hh = a;
    ss = Math.min(1, Math.hypot(dx, dy) / R);
    apply();
  };
  const dragOn = (target: HTMLElement, fn: (e: PointerEvent) => void) => {
    target.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      fn(e);
      const move = (ev: PointerEvent) => fn(ev);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  };
  dragOn(wheel, wheelPick);
  dragOn(valueBar, (e) => {
    const r = valueBar.getBoundingClientRect();
    vv = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    apply();
  });
  hexInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const c = hexToColor(hexInput.value);
      if (c) {
        const cur = opts.get();
        opts.set(cur.length === 4 ? [...c, cur[3]] : c);
        changed = true;
        [hh, ss, vv] = rgbToHsv(...(disp() as [number, number, number]));
        draw();
      }
    }
    if (e.key === 'Escape') close(true);
  });

  buildFields();
  popupLayer().append(el);
  const r = el.getBoundingClientRect();
  let x = anchor.left + anchor.width / 2 - r.width / 2;
  let y = anchor.bottom + 2;
  if (y + r.height > window.innerHeight) y = anchor.top - r.height - 2;
  x = Math.max(2, Math.min(x, window.innerWidth - r.width - 2));
  y = Math.max(2, y);
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  draw();

  // close when the mouse leaves the popup by a margin (Blender behaviour), on outside click or Esc
  const onMove = (e: PointerEvent) => {
    if (e.buttons) return;
    const b = el.getBoundingClientRect();
    const m = 50;
    if (e.clientX < b.left - m || e.clientX > b.right + m || e.clientY < b.top - m || e.clientY > b.bottom + m) close(false);
  };
  const onDown = (e: PointerEvent) => { if (!el.contains(e.target as Node)) { close(false); } };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(true); }
    if (e.key === 'Enter' && document.activeElement !== hexInput) { e.stopPropagation(); close(false); }
  };
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('keydown', onKey, true);
  function close(revert: boolean) {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    el.remove();
    current = null;
    if (revert && changed) { opts.set(start); changed = false; }
    opts.onDone(changed);
  }
  current = { close: () => close(false) };
}
