// Startup splash screen (an original design, in the spirit of Blender 2.79's splash).

import { app } from '../app';
import { h } from './dom';
import { icon } from './icons';
import { BLENDER_VERSION_FULL } from '../core/scene';

let open: HTMLElement | null = null;

export function closeSplash(): void { open?.remove(); open = null; }

export function showSplash(): void {
  closeSplash();
  const img = h('div', { class: 'splash-image' });
  const canvas = h('canvas', { width: 1002, height: 500 }) as HTMLCanvasElement;
  img.append(canvas, h('div', { class: 'brand' }, icon('BLENDER'), 'blender-web', h('small', {}, 'a 2.79b-style UI in your browser')), h('div', { class: 'ver' }, `${BLENDER_VERSION_FULL}`));
  drawArt(canvas);
  const link = (label: string, ic: string, fn: () => void) => {
    const el = h('div', { class: 'splash-link' }, icon(ic), label);
    el.addEventListener('click', () => { closeSplash(); fn(); });
    return el;
  };
  const recent = app.prefs.lastFiles.slice(0, 5);
  const body = h('div', { class: 'splash-body' },
    h('div', { class: 'splash-col' },
      h('h4', {}, 'Links'),
      link('Donations', 'URL', () => window.open('https://fund.blender.org', '_blank')),
      link('Credits', 'URL', () => window.open('https://www.blender.org/about/credits/', '_blank')),
      link('Release Log', 'URL', () => window.open('https://www.blender.org/download/releases/2-79/', '_blank')),
      link('Manual', 'URL', () => window.open('https://docs.blender.org/manual/en/2.79/', '_blank')),
      link('Python API Reference', 'URL', () => window.open('https://docs.blender.org/api/2.79/', '_blank')),
      link('Keyboard Shortcuts', 'HELP', () => void app.callOperator('wm.keymap_show')),
    ),
    h('div', { class: 'splash-col' },
      h('h4', {}, 'Recent'),
      ...(recent.length ? recent.map((f) => link(f, 'FILE_BLEND', () => void app.callOperator('wm.open_mainfile', { filepath: f }, { exec: true }))) : [h('div', { class: 'splash-link', style: { color: '#888' } }, 'No recent files')]),
      link('Open...', 'FILE_FOLDER', () => void app.callOperator('wm.open_mainfile')),
      link('Recover Last Session', 'RECOVER_LAST', () => void app.callOperator('wm.recover_last_session')),
    ),
  );
  const el = h('div', { class: 'splash' }, img, body);
  document.body.append(el);
  open = el;
  const close = (e: Event) => {
    if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') { closeSplash(); window.removeEventListener('keydown', close, true); window.removeEventListener('pointerdown', close, true); return; }
    if (e.type === 'pointerdown' && el.contains(e.target as Node)) return;
    closeSplash();
    window.removeEventListener('pointerdown', close, true);
    window.removeEventListener('keydown', close, true);
  };
  setTimeout(() => {
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close, true);
  }, 50);
}

/** Procedural artwork: a low-poly landscape with glowing spheres. */
function drawArt(c: HTMLCanvasElement): void {
  const ctx = c.getContext('2d');
  if (!ctx) return;
  const W = c.width, H = c.height;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#0b1626');
  g.addColorStop(0.55, '#1d3557');
  g.addColorStop(1, '#e07a2f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 140; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.3 + rnd() * 0.6})`;
    ctx.fillRect(rnd() * W, rnd() * H * 0.5, 1.5, 1.5);
  }
  const layers = [{ y: 0.62, c: '#14213d', a: 90 }, { y: 0.72, c: '#0f1a2e', a: 70 }, { y: 0.84, c: '#0a1220', a: 50 }];
  for (const L of layers) {
    ctx.fillStyle = L.c;
    ctx.beginPath();
    ctx.moveTo(0, H);
    let x = 0;
    while (x <= W) { ctx.lineTo(x, H * L.y - rnd() * L.a); x += 40 + rnd() * 60; }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
  }
  const orb = (x: number, y: number, r: number, col: string) => {
    const rg = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
    rg.addColorStop(0, '#fff');
    rg.addColorStop(0.35, col);
    rg.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = rg;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  };
  orb(W * 0.72, H * 0.45, 70, '#f5792a');
  orb(W * 0.58, H * 0.58, 34, '#4a90e2');
  orb(W * 0.83, H * 0.62, 24, '#7fc35a');
}
