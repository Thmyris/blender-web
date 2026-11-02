// Document files: saved in the browser's storage (like a virtual disk) and
// downloadable/uploadable as .blend.json files. Includes a Blender-like file browser.

import { app } from '../app';
import type { Doc } from '../core/types';
import { purgeOrphans } from '../core/scene';
import { h, clear, downloadFile, pickFile } from '../ui/dom';
import { icon } from '../ui/icons';
import { showDialog } from '../ui/popup';

const INDEX_KEY = 'blender-web:files';
const FILE_PREFIX = 'blender-web:file:';
const STARTUP_KEY = 'blender-web:startup';

export interface FileEntry { name: string; size: number; modified: number }

export function listFiles(): FileEntry[] {
  try { return (JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]') as FileEntry[]).sort((a, b) => a.name.localeCompare(b.name)); } catch { return []; }
}

function writeIndex(list: FileEntry[]): void { localStorage.setItem(INDEX_KEY, JSON.stringify(list)); }

export function serializeDoc(doc: Doc): string {
  const copy: Doc = JSON.parse(JSON.stringify(doc));
  purgeOrphans(copy);
  // selection state of meshes is kept; it is small
  return JSON.stringify({ format: 'blender-web', version: 1, doc: copy });
}

export function parseDoc(text: string): Doc {
  const data = JSON.parse(text);
  const doc: Doc = data && data.format === 'blender-web' ? data.doc : data;
  if (!doc || !Array.isArray(doc.scenes) || !doc.objects) throw new Error('Not a blender-web file');
  return doc;
}

export function saveToBrowser(name: string): boolean {
  const fname = name.endsWith('.blend') ? name : `${name}.blend`;
  const data = serializeDoc(app.doc);
  try {
    localStorage.setItem(FILE_PREFIX + fname, data);
  } catch {
    app.report('ERROR', 'Browser storage is full: use File > Export > Download .blend.json instead');
    return false;
  }
  const list = listFiles().filter((f) => f.name !== fname);
  list.push({ name: fname, size: data.length, modified: Date.now() });
  writeIndex(list);
  app.doc.filename = fname;
  app.dirty = false;
  addRecent(fname);
  app.report('INFO', `Saved "${fname}"`);
  app.notify('all');
  return true;
}

export function loadFromBrowser(name: string): boolean {
  const raw = localStorage.getItem(FILE_PREFIX + name);
  if (!raw) { app.report('ERROR', `Cannot read file "${name}": not found`); return false; }
  try {
    app.loadDoc(parseDoc(raw), name);
    addRecent(name);
    app.report('INFO', `Read blend: ${name}`);
    return true;
  } catch (err) {
    app.report('ERROR', `Cannot read file "${name}": ${(err as Error).message}`);
    return false;
  }
}

export function deleteFile(name: string): void {
  localStorage.removeItem(FILE_PREFIX + name);
  writeIndex(listFiles().filter((f) => f.name !== name));
}

export function addRecent(name: string): void {
  const r = [name, ...app.prefs.lastFiles.filter((x) => x !== name)].slice(0, 10);
  app.prefs.lastFiles = r;
  try { localStorage.setItem('blender-web:userprefs', JSON.stringify(app.prefs)); } catch { /* ignore */ }
}

export function downloadDoc(name?: string): void {
  const base = (name ?? app.doc.filename) || 'untitled.blend';
  downloadFile(`${base.replace(/\.json$/, '')}.json`, serializeDoc(app.doc), 'application/json');
}

export async function openFromDisk(): Promise<boolean> {
  const f = await pickFile('.json,.blend.json,application/json');
  if (!f) return false;
  try {
    const text = await f.text();
    const name = f.name.replace(/\.json$/i, '');
    app.loadDoc(parseDoc(text), name.endsWith('.blend') ? name : `${name}.blend`);
    app.report('INFO', `Read blend: ${f.name}`);
    return true;
  } catch (err) {
    app.report('ERROR', `Cannot open "${f.name}": ${(err as Error).message}`);
    return false;
  }
}

/** "Save Startup File" (Ctrl+U) and loading it on File > New. */
export function saveStartup(): void {
  try { localStorage.setItem(STARTUP_KEY, serializeDoc(app.doc)); app.report('INFO', 'Saved startup file'); } catch { app.report('ERROR', 'Could not save startup file'); }
}

export function readStartup(): Doc | null {
  try { const raw = localStorage.getItem(STARTUP_KEY); return raw ? parseDoc(raw) : null; } catch { return null; }
}

export function clearStartup(): void { localStorage.removeItem(STARTUP_KEY); }

// ------------------------------------------------------------------ file browser

export function fileBrowser(mode: 'open' | 'save'): void {
  let selected = mode === 'save' ? (app.doc.filename || 'untitled.blend') : '';
  let input!: HTMLInputElement;
  const listEl = h('div', { class: 'ui-list', style: { height: '300px', background: '#3a3a3a' } });
  const render = () => {
    clear(listEl);
    const files = listFiles();
    if (!files.length) listEl.append(h('div', { class: 'label', style: { color: '#bbb', padding: '6px' } }, 'No files saved in this browser yet.'));
    for (const f of files) {
      const row = h('div', { class: `ui-list-row${f.name === selected ? ' active' : ''}`, style: { color: f.name === selected ? '#000' : '#ddd' } },
        icon('FILE_BLEND'), h('div', { class: 'name' }, f.name),
        h('div', { style: { color: '#999', flex: '0 0 auto', marginRight: '10px' } }, `${(f.size / 1024).toFixed(1)} KiB`),
        h('div', { style: { color: '#999', flex: '0 0 auto' } }, new Date(f.modified).toLocaleString()));
      const del = h('div', { class: 'icon-btn', title: 'Delete file' }, icon('X'));
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteFile(f.name); if (selected === f.name) selected = ''; render(); });
      row.append(del);
      row.addEventListener('pointerdown', () => { selected = f.name; input.value = f.name; render(); });
      row.addEventListener('dblclick', () => { selected = f.name; input.value = f.name; confirm(); });
      listEl.append(row);
    }
  };
  const confirm = () => {
    const name = input.value.trim();
    if (!name) return;
    if (mode === 'save') {
      const fname = name.endsWith('.blend') ? name : `${name}.blend`;
      if (saveToBrowser(fname)) dlg.close();
    } else if (loadFromBrowser(name)) dlg.close();
  };
  const dlg = showDialog({
    title: mode === 'save' ? 'Save As Blender File' : 'Open Blender File', icon: 'FILESEL', width: 640,
    draw: (l) => {
      const top = l.row();
      top.label('Browser storage (files are kept in this browser)', { icon: 'FILE_FOLDER' });
      const r = top.row(true);
      r.el.style.flex = '0 0 auto';
      if (mode === 'open') r.button('Open from Disk...', async () => { if (await openFromDisk()) dlg.close(); }, { icon: 'FILE_FOLDER' });
      else r.button('Download .blend.json', () => { downloadDoc(input.value.trim() || undefined); }, { icon: 'EXPORT' });
      l.el.append(listEl);
      const row = l.row();
      input = h('input', { class: 'menu-search', value: selected, spellcheck: 'false', style: { margin: '0', flex: '1 1 auto' } }) as HTMLInputElement;
      input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') confirm(); if (e.key === 'Escape') dlg.close(); });
      row.el.append(input);
      const ok = row.button(mode === 'save' ? 'Save As Blender File' : 'Open Blender File', confirm);
      ok.style.flex = '0 0 180px';
    },
  });
  render();
  setTimeout(() => { input.focus(); input.select(); }, 0);
}
