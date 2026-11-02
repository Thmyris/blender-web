// Text Editor (with Python syntax highlighting and Run Script) and Python Console.

import { app } from '../app';
import { Editor, registerEditor } from '../screen/editor';
import type { Area } from '../screen/screen';
import { h, clear, downloadFile, pickFile } from '../ui/dom';
import { pulldown, type MenuItem } from '../ui/menu';
import type { Layout } from '../ui/layout';
import { createText, renameData } from '../core/scene';
import { runScript, consolePush, consoleComplete, loadPython, pythonStatus, pythonError, pythonListeners, CONSOLE_BANNER } from '../python/python';

const KEYWORDS = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '));
const BUILTINS = new Set('abs all any bin bool dict dir enumerate filter float format getattr hasattr hex int isinstance len list map max min next object open ord pow print range repr reversed round set setattr sorted str sum super tuple type zip self'.split(' '));

function esc(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/** Simple Python syntax highlighter (colours similar to Blender 2.79's text editor theme). */
export function highlightPython(src: string): string {
  const re = /(#[^\n]*)|("""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)|(\b\d+\.?\d*(?:e[-+]?\d+)?\b)|(@\w+)|(\b[A-Za-z_]\w*\b)/g;
  let out = '';
  let last = 0;
  let prev = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    const t = m[0];
    if (m[1]) out += `<span style="color:#235a23">${esc(t)}</span>`;
    else if (m[2]) out += `<span style="color:#1b3d8c">${esc(t)}</span>`;
    else if (m[3]) out += `<span style="color:#0000c8">${esc(t)}</span>`;
    else if (m[4]) out += `<span style="color:#5f5f00">${esc(t)}</span>`;
    else if (KEYWORDS.has(t)) out += `<span style="color:#800050;font-weight:bold">${esc(t)}</span>`;
    else if (prev === 'def' || prev === 'class') out += `<span style="color:#5f5f00;font-weight:bold">${esc(t)}</span>`;
    else if (BUILTINS.has(t)) out += `<span style="color:#800050">${esc(t)}</span>`;
    else out += esc(t);
    if (m[5]) prev = t;
    last = m.index + t.length;
  }
  out += esc(src.slice(last));
  return out + '\n';
}

const TEMPLATES: Record<string, string> = {
  'Cube Grid': `import bpy

# Add a 5 x 5 grid of cubes with random heights
import random
for x in range(5):
    for y in range(5):
        bpy.ops.mesh.primitive_cube_add(radius=0.4, location=(x - 2, y - 2, 0))
        ob = bpy.context.object
        ob.scale = (1, 1, random.uniform(0.5, 3.0))
        ob.name = "Block_%d_%d" % (x, y)
`,
  'Animate Object': `import bpy

ob = bpy.context.object
scene = bpy.context.scene
scene.frame_start = 1
scene.frame_end = 100

# keyframe a full turn and a jump
for frame, z, rot in [(1, 0, 0), (50, 2, 3.14159), (100, 0, 6.28318)]:
    scene.frame_set(frame)
    ob.location = (ob.location.x, ob.location.y, z)
    ob.rotation_euler = (0, 0, rot)
    ob.keyframe_insert(data_path="location")
    ob.keyframe_insert(data_path="rotation_euler")
scene.frame_set(1)
print("Animated", ob.name)
`,
  'Random Materials': `import bpy
import random

for ob in bpy.context.selected_objects:
    if ob.type != 'MESH':
        continue
    mat = bpy.data.materials.new("Random_" + ob.name)
    mat.diffuse_color = (random.random(), random.random(), random.random())
    ob.active_material = mat
`,
  'Subdivide Selected': `import bpy

for ob in bpy.context.selected_objects:
    if ob.type == 'MESH':
        mod = ob.modifiers.new("Subsurf", 'SUBSURF')
        mod.levels = 2
bpy.ops.object.shade_smooth()
`,
  'Mesh From Python Data': `import bpy

# Build a pyramid from raw vertex/face data
bpy.ops.mesh.primitive_plane_add()
me = bpy.context.object.data
verts = [(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0), (0, 0, 1.5)]
faces = [(3, 2, 1, 0), (0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)]
me.from_pydata(verts, [], faces)
bpy.context.object.name = "Pyramid"
`,
  'List Scene': `import bpy

scene = bpy.context.scene
print("Scene:", scene.name, "frames", scene.frame_start, "-", scene.frame_end)
for ob in scene.objects:
    print("%-12s %-8s loc=%s" % (ob.name, ob.type, tuple(round(v, 3) for v in ob.location)))
`,
};

// ------------------------------------------------------------------ Text editor

export class TextEditor extends Editor {
  static readonly TYPE = 'TEXT_EDITOR';
  private ta: HTMLTextAreaElement;
  private pre: HTMLElement;
  private gutter: HTMLElement;
  private wrap: HTMLElement;
  private empty: HTMLElement;
  private lastId = '';

  constructor(area: Area, state: Record<string, unknown>) {
    super(area, state);
    state.lineNumbers ??= true;
    state.wordWrap ??= false;
    state.syntax ??= true;
    state.fontSize ??= 13;
    const font = '"DejaVu Sans Mono", Menlo, Consolas, monospace';
    this.gutter = h('div', { style: { position: 'absolute', left: '0', top: '0', bottom: '0', width: '40px', background: '#8a8a8a', color: '#333', textAlign: 'right', padding: '4px 6px 4px 0', fontFamily: font, overflow: 'hidden', whiteSpace: 'pre', borderRight: '1px solid #777' } });
    this.pre = h('pre', { style: { position: 'absolute', margin: '0', inset: '0', padding: '4px 6px', fontFamily: font, color: '#000', pointerEvents: 'none', overflow: 'hidden' } });
    this.ta = h('textarea', { spellcheck: 'false', style: { position: 'absolute', inset: '0', margin: '0', padding: '4px 6px', fontFamily: font, background: 'transparent', color: 'transparent', caretColor: '#c00', border: 'none', outline: 'none', resize: 'none', whiteSpace: 'pre', overflow: 'auto', userSelect: 'text' } }) as HTMLTextAreaElement;
    const editorBox = h('div', { style: { position: 'absolute', top: '0', bottom: '0', right: '0', left: '40px', overflow: 'hidden' } }, this.pre, this.ta);
    this.empty = h('div', { style: { position: 'absolute', inset: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#333' } }, 'Create a new text (Text > New) or open one to start editing');
    this.wrap = h('div', { class: 'region', style: { flex: '1 1 auto', background: '#999999', position: 'relative' } }, this.gutter, editorBox, this.empty);
    this.main.append(this.wrap);
    this.ta.addEventListener('input', () => { const t = this.text; if (t) { t.body = this.ta.value; app.dirty = true; } this.paint(); });
    this.ta.addEventListener('scroll', () => this.syncScroll());
    this.ta.addEventListener('keydown', (e) => this.onTextKey(e));
    this.ta.addEventListener('blur', () => { if (this.text) app.pushUndo('Edit Text'); });
    this.wrap.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.state.fontSize = Math.max(8, Math.min(32, (this.state.fontSize as number) + (e.deltaY < 0 ? 1 : -1)));
      this.applyStyle();
    }, { passive: false });
    this.applyStyle();
  }

  get type(): string { return TextEditor.TYPE; }

  get text() {
    const id = this.state.textId as string | undefined;
    return id ? app.doc.texts[id] ?? null : null;
  }

  private applyStyle(): void {
    const fs = `${this.state.fontSize}px`;
    const lh = `${Math.round((this.state.fontSize as number) * 1.35)}px`;
    for (const el of [this.ta, this.pre, this.gutter]) { el.style.fontSize = fs; el.style.lineHeight = lh; }
    const ww = !!this.state.wordWrap;
    this.ta.style.whiteSpace = this.pre.style.whiteSpace = ww ? 'pre-wrap' : 'pre';
    (this.ta.parentElement as HTMLElement).style.left = this.state.lineNumbers ? '40px' : '0';
    this.gutter.style.display = this.state.lineNumbers ? '' : 'none';
    this.paint();
  }

  private paint(): void {
    const t = this.text;
    this.empty.style.display = t ? 'none' : 'flex';
    this.ta.style.display = t ? '' : 'none';
    const src = this.ta.value;
    this.pre.innerHTML = this.state.syntax ? highlightPython(src) : esc(src) + '\n';
    const n = src.split('\n').length;
    this.gutter.textContent = Array.from({ length: n }, (_, i) => String(i + 1)).join('\n');
    this.syncScroll();
  }

  private syncScroll(): void {
    this.pre.style.transform = `translate(${-this.ta.scrollLeft}px, ${-this.ta.scrollTop}px)`;
    this.gutter.style.transform = `translateY(${-this.ta.scrollTop}px)`;
  }

  private onTextKey(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = this.ta.selectionStart, en = this.ta.selectionEnd, v = this.ta.value;
      if (e.shiftKey) {
        const ls = v.lastIndexOf('\n', s - 1) + 1;
        if (v.slice(ls, ls + 4) === '    ') { this.ta.value = v.slice(0, ls) + v.slice(ls + 4); this.ta.selectionStart = this.ta.selectionEnd = Math.max(ls, s - 4); }
      } else {
        this.ta.value = v.slice(0, s) + '    ' + v.slice(en);
        this.ta.selectionStart = this.ta.selectionEnd = s + 4;
      }
      this.ta.dispatchEvent(new Event('input'));
    } else if (e.key === 'Enter') {
      // keep indentation (and indent after ':')
      e.preventDefault();
      const s = this.ta.selectionStart, v = this.ta.value;
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      const line = v.slice(ls, s);
      let ind = /^\s*/.exec(line)![0];
      if (/:\s*$/.test(line)) ind += '    ';
      this.ta.value = v.slice(0, s) + '\n' + ind + v.slice(this.ta.selectionEnd);
      this.ta.selectionStart = this.ta.selectionEnd = s + 1 + ind.length;
      this.ta.dispatchEvent(new Event('input'));
    } else if (e.key.toLowerCase() === 'p' && e.altKey) {
      e.preventDefault();
      void this.run();
    } else if (e.key.toLowerCase() === 's' && e.altKey) {
      e.preventDefault();
      this.save();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'y')) {
      // let the textarea handle its own undo
    }
  }

  private newText(body = '', name = 'Text'): void {
    const t = createText(app.doc, name, body);
    this.state.textId = t.id;
    app.pushUndo('New Text');
    app.notify('all');
  }

  private async open(): Promise<void> {
    const f = await pickFile('.py,.txt,text/*');
    if (!f) return;
    this.newText(await f.text(), f.name);
  }

  private save(): void {
    const t = this.text;
    if (!t) return;
    downloadFile(t.name.endsWith('.py') || t.name.includes('.') ? t.name : `${t.name}.py`, t.body, 'text/x-python');
  }

  async run(): Promise<void> {
    const t = this.text;
    if (!t) return;
    t.body = this.ta.value;
    app.report('INFO', pythonStatus === 'ready' ? `Running ${t.name}...` : 'Loading Python (Pyodide) — first run downloads ~10 MB...');
    try {
      const r = await runScript(t.body, t.name);
      if (r.out) for (const line of r.out.trimEnd().split('\n')) app.report('INFO', line);
      if (!r.ok) {
        app.report('ERROR', 'Python script fail, look in the console for now...');
        for (const line of r.err.trimEnd().split('\n')) app.report('ERROR', line);
        consoleEcho(r.err, 'error');
      } else consoleEcho(r.out, 'output');
    } catch (err) {
      app.report('ERROR', `Python unavailable: ${(err as Error).message}`);
    }
  }

  override headerKey(): string { return `${this.state.textId ?? ''}${this.state.lineNumbers}${this.state.wordWrap}${this.state.syntax}`; }

  override drawHeader(l: Layout): void {
    const area = () => this.area;
    const row = l.row();
    row.el.classList.add('header-row');
    row.el.style.flex = '0 0 auto';
    const textMenu = (): MenuItem[] => [
      { label: 'New', shortcut: 'Ctrl N', action: () => this.newText() },
      { label: 'Open...', shortcut: 'Alt O', action: () => void this.open() },
      { type: 'separator' },
      { label: 'Save', shortcut: 'Alt S', action: () => this.save(), disabled: !this.text },
      { type: 'separator' },
      { label: 'Run Script', shortcut: 'Alt P', action: () => void this.run(), disabled: !this.text },
    ];
    row.el.append(
      pulldown({ label: 'View', items: () => [
        { label: 'Line Numbers', checked: !!this.state.lineNumbers, action: () => { this.state.lineNumbers = !this.state.lineNumbers; this.applyStyle(); } },
        { label: 'Word Wrap', checked: !!this.state.wordWrap, action: () => { this.state.wordWrap = !this.state.wordWrap; this.applyStyle(); } },
        { label: 'Syntax Highlight', checked: !!this.state.syntax, action: () => { this.state.syntax = !this.state.syntax; this.applyStyle(); } },
        { type: 'separator' },
        { label: 'Top of File', action: () => { this.ta.scrollTop = 0; this.ta.setSelectionRange(0, 0); } },
        { label: 'Bottom of File', action: () => { this.ta.scrollTop = this.ta.scrollHeight; } },
      ] }, area),
      pulldown({ label: 'Text', items: textMenu }, area),
      pulldown({ label: 'Edit', items: () => [
        { label: 'Select All', shortcut: 'Ctrl A', action: () => { this.ta.focus(); this.ta.select(); } },
        { label: 'Indent', action: () => this.indentSel(1) },
        { label: 'Unindent', action: () => this.indentSel(-1) },
        { label: 'Comment', action: () => this.commentSel(true) },
        { label: 'Uncomment', action: () => this.commentSel(false) },
      ] }, area),
      pulldown({ label: 'Templates', items: () => [{ type: 'submenu', label: 'Python', items: Object.keys(TEMPLATES).map((k) => ({ label: k, action: () => this.newText(TEMPLATES[k], `${k.replace(/\s+/g, '_').toLowerCase()}.py`) })) }] }, area),
    );
    l.idTemplate({
      icon: 'TEXT', title: 'Text',
      items: () => Object.values(app.doc.texts).map((t) => ({ id: t.id, name: t.name, icon: 'TEXT' })),
      get: () => (this.text ? this.text.id : null),
      set: (id) => { this.state.textId = id; this.refresh(); },
      name: () => this.text?.name ?? '',
      rename: (n) => { if (this.text) renameData(app.doc, 'texts', this.text.id, n); },
      onNew: () => this.newText(),
      unlink: () => { const t = this.text; if (t) { delete app.doc.texts[t.id]; this.state.textId = null; } },
    }).style.flex = '0 1 260px';
    const tg = l.row(true);
    tg.el.style.flex = '0 0 auto';
    tg.prop({ kind: 'bool', name: 'Line Numbers', get: () => !!this.state.lineNumbers, set: (v) => { this.state.lineNumbers = v; this.applyStyle(); }, undo: false, description: 'Show line numbers next to the text' }, { iconOnly: true, icon: 'LINENUMBERS_ON' });
    tg.prop({ kind: 'bool', name: 'Word Wrap', get: () => !!this.state.wordWrap, set: (v) => { this.state.wordWrap = v; this.applyStyle(); }, undo: false, description: 'Wrap words if there is not enough horizontal space' }, { iconOnly: true, icon: 'WORDWRAP_ON' });
    tg.prop({ kind: 'bool', name: 'Syntax Highlight', get: () => !!this.state.syntax, set: (v) => { this.state.syntax = v; this.applyStyle(); }, undo: false, description: 'Syntax highlight for scripting' }, { iconOnly: true, icon: 'SYNTAX_ON' });
    const run = l.button('Run Script', () => void this.run(), { icon: 'PLAY', tip: 'Run Script: execute the text as a Python script (Alt P)', disabled: () => !this.text });
    run.style.flex = '0 0 100px';
    l.prop({ kind: 'bool', name: 'Register', get: () => false, set: () => {}, disabled: () => true, undo: false, description: 'Run this text as a Python script on loading (not available)' });
  }

  private lines(cb: (line: string) => string): void {
    const v = this.ta.value, s = this.ta.selectionStart, e = this.ta.selectionEnd;
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    let le = v.indexOf('\n', e);
    if (le < 0) le = v.length;
    const out = v.slice(ls, le).split('\n').map(cb).join('\n');
    this.ta.value = v.slice(0, ls) + out + v.slice(le);
    this.ta.setSelectionRange(ls, ls + out.length);
    this.ta.dispatchEvent(new Event('input'));
  }
  private indentSel(d: number): void { this.lines((l) => (d > 0 ? `    ${l}` : l.replace(/^ {1,4}/, ''))); }
  private commentSel(c: boolean): void { this.lines((l) => (c ? `# ${l}` : l.replace(/^(\s*)# ?/, '$1'))); }

  override refresh(): void {
    const t = this.text;
    if (!t && this.state.textId) this.state.textId = null;
    const id = t?.id ?? '';
    if (id !== this.lastId || (t && t.body !== this.ta.value && document.activeElement !== this.ta)) {
      this.lastId = id;
      this.ta.value = t?.body ?? '';
      this.paint();
    }
  }

  override onKey(e: KeyboardEvent): boolean {
    if (e.altKey && e.key.toLowerCase() === 'p') { void this.run(); return true; }
    if (e.ctrlKey && e.key.toLowerCase() === 'n' && false) return true;
    if (e.altKey && e.key.toLowerCase() === 'o') { void this.open(); return true; }
    return false;
  }
}

// ------------------------------------------------------------------ Python console

const consoles = new Set<PythonConsole>();
function consoleEcho(text: string, kind: 'output' | 'error'): void {
  if (!text) return;
  for (const c of consoles) c.print(text.trimEnd(), kind);
}

export class PythonConsole extends Editor {
  static readonly TYPE = 'CONSOLE';
  private out: HTMLElement;
  private input: HTMLInputElement;
  private prompt: HTMLElement;
  private history: string[] = [];
  private hi = -1;
  private more = false;
  private unsub: () => void;

  constructor(area: Area, state: Record<string, unknown>) {
    super(area, state);
    state.fontSize ??= 12;
    const font = '"DejaVu Sans Mono", Menlo, Consolas, monospace';
    this.out = h('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'text' } });
    this.prompt = h('span', { style: { color: '#fff' } }, '>>> ');
    this.input = h('input', { spellcheck: 'false', style: { flex: '1 1 auto', background: 'transparent', border: 'none', outline: 'none', color: '#fff', font: 'inherit', padding: '0', caretColor: '#dc6060' } }) as HTMLInputElement;
    const line = h('div', { style: { display: 'flex' } }, this.prompt, this.input);
    const scroll = h('div', { class: 'region-scroll', style: { background: '#000', padding: '4px 6px', fontFamily: font, color: '#6080ff' } }, this.out, line);
    this.main.append(h('div', { class: 'region', style: { flex: '1 1 auto' } }, scroll));
    scroll.addEventListener('pointerup', () => { if (!window.getSelection()?.toString()) this.input.focus(); });
    scroll.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.state.fontSize = Math.max(8, Math.min(28, (this.state.fontSize as number) + (e.deltaY < 0 ? 1 : -1)));
      scroll.style.fontSize = `${this.state.fontSize}px`;
    }, { passive: false });
    scroll.style.fontSize = `${state.fontSize}px`;
    this.input.addEventListener('keydown', (e) => void this.onInputKey(e));
    for (const l of CONSOLE_BANNER) this.print(l, 'output');
    this.print(pythonStatus === 'ready' ? '' : 'Python loads on first use (downloads Pyodide, ~10 MB).', 'info');
    const upd = () => {
      if (pythonStatus === 'loading') this.print('Loading Python...', 'info');
      if (pythonStatus === 'ready') this.print('Python ready.', 'info');
      if (pythonStatus === 'error') this.print(`Python failed to load: ${pythonError}`, 'error');
    };
    pythonListeners.add(upd);
    this.unsub = () => pythonListeners.delete(upd);
    consoles.add(this);
  }

  get type(): string { return PythonConsole.TYPE; }
  override destroy(): void { this.unsub(); consoles.delete(this); }

  print(text: string, kind: 'input' | 'output' | 'error' | 'info'): void {
    const color = kind === 'input' ? '#ffffff' : kind === 'error' ? '#dc6060' : kind === 'info' ? '#00aa00' : '#6080ff';
    this.out.append(h('div', { style: { color } }, text || ' '));
    const sc = this.out.parentElement!;
    sc.scrollTop = sc.scrollHeight;
  }

  private async onInputKey(e: KeyboardEvent): Promise<void> {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const line = this.input.value;
      this.print(`${this.more ? '... ' : '>>> '}${line}`, 'input');
      if (line.trim()) this.history.push(line);
      this.hi = this.history.length;
      this.input.value = '';
      try {
        const r = await consolePush(line);
        this.more = r.more;
        if (r.out) this.print(r.out.replace(/\n$/, ''), 'output');
        if (r.err) this.print(r.err.replace(/\n$/, ''), 'error');
      } catch (err) {
        this.print(`Python unavailable: ${(err as Error).message}`, 'error');
      }
      this.prompt.textContent = this.more ? '... ' : '>>> ';
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (this.hi > 0) { this.hi--; this.input.value = this.history[this.hi]; }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.hi < this.history.length - 1) { this.hi++; this.input.value = this.history[this.hi]; } else { this.hi = this.history.length; this.input.value = ''; }
    } else if (e.key === 'Tab' || (e.key === ' ' && e.ctrlKey)) {
      e.preventDefault();
      const m = /[\w.]*$/.exec(this.input.value);
      const word = m ? m[0] : '';
      if (!word) { this.input.value += '    '; return; }
      const res = await consoleComplete(word);
      if (res.length === 1) this.input.value = this.input.value.slice(0, this.input.value.length - word.length) + res[0];
      else if (res.length > 1) {
        this.print(res.join('  '), 'info');
        let p = res[0];
        for (const r of res) while (!r.startsWith(p)) p = p.slice(0, -1);
        this.input.value = this.input.value.slice(0, this.input.value.length - word.length) + p;
      }
    }
  }

  override drawHeader(l: Layout): void {
    const area = () => this.area;
    const row = l.row();
    row.el.classList.add('header-row');
    row.el.style.flex = '0 0 auto';
    row.el.append(
      pulldown({ label: 'View', items: () => [{ label: 'Zoom In', shortcut: 'Ctrl Wheel', action: () => { this.state.fontSize = (this.state.fontSize as number) + 1; } }, { label: 'Toggle Maximize Area', op: 'screen.screen_full_area' }] }, area),
      pulldown({ label: 'Console', items: () => [
        { label: 'Clear', action: () => clear(this.out) },
        { label: 'Copy History', action: () => void navigator.clipboard?.writeText(this.history.join('\n')) },
        { type: 'separator' },
        { label: 'Load Python Now', action: () => void loadPython().catch(() => {}) },
      ] }, area),
    );
  }

  override mount(): void { setTimeout(() => this.input.focus(), 0); }
}

registerEditor({ type: TextEditor.TYPE, label: 'Text Editor', icon: 'TEXT', create: (area, state) => new TextEditor(area, state) });
registerEditor({ type: PythonConsole.TYPE, label: 'Python Console', icon: 'CONSOLE', create: (area, state) => new PythonConsole(area, state) });
