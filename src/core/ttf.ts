// A small TrueType / OpenType font reader: turns the glyph outlines of a .ttf (glyf) or .otf (CFF)
// file into the typeface data used by three's Font class (FontLoader format: per glyph an
// advance "ha" and an outline string of m / l / q / b commands). Glyphs are decoded on demand.

export interface TypefaceGlyph { ha: number; x_min: number; x_max: number; o: string }
export interface TypefaceData {
  glyphs: Record<string, TypefaceGlyph>;
  familyName: string;
  ascender: number;
  descender: number;
  underlinePosition: number;
  underlineThickness: number;
  boundingBox: { xMin: number; yMin: number; xMax: number; yMax: number };
  resolution: number;
  original_font_information: Record<string, string>;
}

class Reader {
  constructor(public v: DataView, public p = 0) {}
  u8(): number { return this.v.getUint8(this.p++); }
  i8(): number { return this.v.getInt8(this.p++); }
  u16(): number { const x = this.v.getUint16(this.p); this.p += 2; return x; }
  i16(): number { const x = this.v.getInt16(this.p); this.p += 2; return x; }
  u32(): number { const x = this.v.getUint32(this.p); this.p += 4; return x; }
  tag(): string { let s = ''; for (let i = 0; i < 4; i++) s += String.fromCharCode(this.u8()); return s; }
}

type Pt = { x: number; y: number; on: boolean };
/** A decoded outline: contours of points (TrueType, quadratic) or commands (CFF, cubic). */
type Outline = { kind: 'quad'; contours: Pt[][] } | { kind: 'cmd'; cmds: string[] };

export function parseFontFile(buf: ArrayBuffer): TypefaceData {
  const v = new DataView(buf);
  const r = new Reader(v);
  const sfnt = r.u32();
  if (sfnt !== 0x00010000 && sfnt !== 0x4f54544f && sfnt !== 0x74727565) throw new Error('Not a TrueType / OpenType font');
  const numTables = r.u16();
  r.p += 6;
  const tables: Record<string, { off: number; len: number }> = {};
  for (let i = 0; i < numTables; i++) { const tag = r.tag(); r.u32(); const off = r.u32(); const len = r.u32(); tables[tag] = { off, len }; }
  const need = (t: string) => { const x = tables[t]; if (!x) throw new Error(`Font has no '${t}' table`); return x; };
  // head
  const head = new Reader(v, need('head').off);
  head.p += 18;
  const unitsPerEm = head.u16();
  head.p += 16;
  const bbox = { xMin: head.i16(), yMin: head.i16(), xMax: head.i16(), yMax: head.i16() };
  head.p += 6;
  const indexToLoc = head.i16();
  // maxp / hhea / hmtx
  const numGlyphs = new Reader(v, need('maxp').off + 4).u16();
  const hh = new Reader(v, need('hhea').off + 4);
  const ascender = hh.i16(), descender = hh.i16();
  const numHMetrics = new Reader(v, tables.hhea.off + 34).u16();
  const hmtxOff = need('hmtx').off;
  const advance = (g: number) => v.getUint16(hmtxOff + 4 * Math.min(g, numHMetrics - 1));
  // post (underline)
  let ulPos = -Math.round(unitsPerEm * 0.1), ulThick = Math.round(unitsPerEm * 0.05);
  if (tables.post) { const pr = new Reader(v, tables.post.off + 8); ulPos = pr.i16(); ulThick = pr.i16(); }
  // name (family)
  let family = 'Font';
  if (tables.name) family = readName(v, tables.name.off, 1) ?? family;
  // cmap
  const cmap = readCmap(v, need('cmap').off);
  // outlines
  let outline: (g: number) => Outline;
  if (tables.glyf && tables.loca) {
    const loca = tables.loca.off, glyf = tables.glyf.off;
    const glyphOff = (g: number) => (indexToLoc === 0 ? v.getUint16(loca + g * 2) * 2 : v.getUint32(loca + g * 4));
    const decode = (g: number, depth = 0): Pt[][] => {
      if (g < 0 || g >= numGlyphs || depth > 8) return [];
      const start = glyphOff(g), end = glyphOff(g + 1);
      if (end <= start) return [];
      return readGlyf(v, glyf + start, (cg) => decode(cg, depth + 1));
    };
    outline = (g) => ({ kind: 'quad', contours: decode(g) });
  } else if (tables['CFF ']) {
    const cff = readCff(v, tables['CFF '].off);
    outline = (g) => ({ kind: 'cmd', cmds: cff(g) });
  } else throw new Error('Font has no glyph outlines');

  const glyphCache = new Map<string, TypefaceGlyph | null>();
  const glyphFor = (ch: string): TypefaceGlyph | null => {
    if (glyphCache.has(ch)) return glyphCache.get(ch)!;
    const cp = ch.codePointAt(0) ?? 0;
    const g = cmap(cp);
    let res: TypefaceGlyph | null = null;
    if (g > 0 || ch === ' ') {
      const ol = outline(g);
      const o = ol.kind === 'quad' ? quadOutline(ol.contours) : ol.cmds.join(' ');
      const xs = (o.match(/-?\d+(\.\d+)?/g) ?? []).map(Number).filter((_, i) => i % 2 === 0);
      res = { ha: advance(g), x_min: xs.length ? Math.min(...xs) : 0, x_max: xs.length ? Math.max(...xs) : 0, o };
    }
    glyphCache.set(ch, res);
    return res;
  };
  const glyphs = new Proxy({} as Record<string, TypefaceGlyph>, {
    get: (_t, key) => (typeof key === 'string' ? glyphFor(key) ?? undefined : undefined),
    has: (_t, key) => typeof key === 'string' && !!glyphFor(key),
  });
  return {
    glyphs, familyName: family, ascender, descender, underlinePosition: ulPos, underlineThickness: ulThick, boundingBox: bbox, resolution: unitsPerEm,
    original_font_information: { format: 0 as unknown as string, fontFamily: family },
  };
}

function readName(v: DataView, off: number, id: number): string | null {
  const count = v.getUint16(off + 2), strOff = off + v.getUint16(off + 4);
  for (let i = 0; i < count; i++) {
    const r = off + 6 + i * 12;
    const platform = v.getUint16(r), nameId = v.getUint16(r + 6), len = v.getUint16(r + 8), o = v.getUint16(r + 10);
    if (nameId !== id) continue;
    let s = '';
    if (platform === 3 || platform === 0) for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(v.getUint16(strOff + o + k));
    else for (let k = 0; k < len; k++) s += String.fromCharCode(v.getUint8(strOff + o + k));
    if (s) return s;
  }
  return null;
}

function readCmap(v: DataView, off: number): (cp: number) => number {
  const n = v.getUint16(off + 2);
  let best = -1, bestFmt = 0;
  for (let i = 0; i < n; i++) {
    const platform = v.getUint16(off + 4 + i * 8), enc = v.getUint16(off + 6 + i * 8);
    const sub = off + v.getUint32(off + 8 + i * 8);
    const fmt = v.getUint16(sub);
    const unicode = platform === 0 || (platform === 3 && (enc === 1 || enc === 10));
    if (!unicode) continue;
    if (fmt === 12 && bestFmt !== 12) { best = sub; bestFmt = 12; }
    else if (fmt === 4 && bestFmt === 0) { best = sub; bestFmt = 4; }
  }
  if (best < 0) return () => 0;
  if (bestFmt === 12) {
    const groups = v.getUint32(best + 12);
    return (cp) => {
      let lo = 0, hi = groups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = best + 16 + mid * 12;
        const s = v.getUint32(g), e = v.getUint32(g + 4);
        if (cp < s) hi = mid - 1; else if (cp > e) lo = mid + 1; else return v.getUint32(g + 8) + cp - s;
      }
      return 0;
    };
  }
  const segX2 = v.getUint16(best + 6);
  const ends = best + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
  return (cp) => {
    if (cp > 0xffff) return 0;
    for (let i = 0; i < segX2 / 2; i++) {
      const end = v.getUint16(ends + i * 2);
      if (cp > end) continue;
      const start = v.getUint16(starts + i * 2);
      if (cp < start) return 0;
      const delta = v.getInt16(deltas + i * 2), ro = v.getUint16(ranges + i * 2);
      if (!ro) return (cp + delta) & 0xffff;
      const gi = v.getUint16(ranges + i * 2 + ro + (cp - start) * 2);
      return gi ? (gi + delta) & 0xffff : 0;
    }
    return 0;
  };
}

function readGlyf(v: DataView, off: number, component: (g: number) => Pt[][]): Pt[][] {
  const r = new Reader(v, off);
  const nc = r.i16();
  r.p += 8;
  if (nc >= 0) {
    const ends: number[] = [];
    for (let i = 0; i < nc; i++) ends.push(r.u16());
    const nPts = nc ? ends[nc - 1] + 1 : 0;
    r.p += r.u16();
    const flags: number[] = [];
    while (flags.length < nPts) {
      const f = r.u8();
      flags.push(f);
      if (f & 8) { const rep = r.u8(); for (let k = 0; k < rep; k++) flags.push(f); }
    }
    const xs: number[] = [], ys: number[] = [];
    let x = 0, y = 0;
    for (const f of flags) { if (f & 2) x += (f & 16 ? 1 : -1) * r.u8(); else if (!(f & 16)) x += r.i16(); xs.push(x); }
    for (const f of flags) { if (f & 4) y += (f & 32 ? 1 : -1) * r.u8(); else if (!(f & 32)) y += r.i16(); ys.push(y); }
    const contours: Pt[][] = [];
    let s = 0;
    for (const e of ends) { const c: Pt[] = []; for (let i = s; i <= e; i++) c.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) }); contours.push(c); s = e + 1; }
    return contours;
  }
  // composite glyph
  const out: Pt[][] = [];
  for (let guard = 0; guard < 64; guard++) {
    const flags = r.u16(), gi = r.u16();
    let dx: number, dy: number;
    if (flags & 1) { dx = r.i16(); dy = r.i16(); } else { dx = r.i8(); dy = r.i8(); }
    if (!(flags & 2)) { dx = 0; dy = 0; } // point matching is not supported
    let a = 1, b = 0, c = 0, d = 1;
    const f2 = () => r.i16() / 16384;
    if (flags & 8) { a = d = f2(); } else if (flags & 0x40) { a = f2(); d = f2(); } else if (flags & 0x80) { a = f2(); b = f2(); c = f2(); d = f2(); }
    for (const cont of component(gi)) out.push(cont.map((p) => ({ x: p.x * a + p.y * c + dx, y: p.x * b + p.y * d + dy, on: p.on })));
    if (!(flags & 0x20)) break;
  }
  return out;
}

/** Quadratic TrueType contours -> FontLoader outline commands ("q" lists the end point first). */
function quadOutline(contours: Pt[][]): string {
  const out: string[] = [];
  const f = (n: number) => String(Math.round(n * 100) / 100);
  for (const c of contours) {
    if (c.length < 2) continue;
    const n = c.length;
    let startIdx = c.findIndex((p) => p.on);
    let start: { x: number; y: number };
    if (startIdx < 0) { start = { x: (c[0].x + c[n - 1].x) / 2, y: (c[0].y + c[n - 1].y) / 2 }; startIdx = 0; }
    else start = c[startIdx];
    out.push('m', f(start.x), f(start.y));
    let ctrl: { x: number; y: number } | null = null;
    const first = c[startIdx].on ? startIdx + 1 : startIdx;
    for (let k = 0; k < n; k++) {
      const p = c[(first + k) % n];
      const atEnd = k === n - 1 && c[startIdx].on;
      if (p.on) {
        if (ctrl) { out.push('q', f(p.x), f(p.y), f(ctrl.x), f(ctrl.y)); ctrl = null; } else out.push('l', f(p.x), f(p.y));
      } else if (ctrl) {
        const mx = (ctrl.x + p.x) / 2, my = (ctrl.y + p.y) / 2;
        out.push('q', f(mx), f(my), f(ctrl.x), f(ctrl.y));
        ctrl = p;
      } else ctrl = p;
      if (atEnd) break;
    }
    if (ctrl) out.push('q', f(start.x), f(start.y), f(ctrl.x), f(ctrl.y));
  }
  return out.join(' ');
}

// ------------------------------------------------------------------ CFF (OpenType .otf outlines)

function readIndex(v: DataView, off: number): { items: [number, number][]; end: number } {
  const count = v.getUint16(off);
  if (!count) return { items: [], end: off + 2 };
  const offSize = v.getUint8(off + 2);
  const rd = (p: number) => { let x = 0; for (let i = 0; i < offSize; i++) x = x * 256 + v.getUint8(p + i); return x; };
  const base = off + 3 + (count + 1) * offSize - 1;
  const items: [number, number][] = [];
  for (let i = 0; i < count; i++) items.push([base + rd(off + 3 + i * offSize), base + rd(off + 3 + (i + 1) * offSize)]);
  return { items, end: base + rd(off + 3 + count * offSize) };
}

function readDict(v: DataView, start: number, end: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  let ops: number[] = [];
  let p = start;
  while (p < end) {
    const b = v.getUint8(p);
    if (b <= 21) {
      let key = b; p++;
      if (b === 12) { key = 1200 + v.getUint8(p); p++; }
      out.set(key, ops); ops = [];
    } else if (b === 28) { ops.push(v.getInt16(p + 1)); p += 3; }
    else if (b === 29) { ops.push(v.getInt32(p + 1)); p += 5; }
    else if (b === 30) {
      // real number (nibbles)
      let s = ''; p++;
      for (;;) {
        const x = v.getUint8(p++);
        const nib = [x >> 4, x & 15];
        let stop = false;
        for (const n of nib) { if (n === 15) { stop = true; break; } s += n < 10 ? String(n) : n === 10 ? '.' : n === 11 ? 'E' : n === 12 ? 'E-' : n === 14 ? '-' : ''; }
        if (stop) break;
      }
      ops.push(Number(s));
    } else if (b >= 32 && b <= 246) { ops.push(b - 139); p++; }
    else if (b >= 247 && b <= 250) { ops.push((b - 247) * 256 + v.getUint8(p + 1) + 108); p += 2; }
    else if (b >= 251 && b <= 254) { ops.push(-(b - 251) * 256 - v.getUint8(p + 1) - 108); p += 2; }
    else p++;
  }
  return out;
}

/** CFF table reader: glyph index -> outline commands (cubic, "b" lists the end point first). */
function readCff(v: DataView, off: number): (g: number) => string[] {
  const hdrSize = v.getUint8(off + 2);
  const names = readIndex(v, off + hdrSize);
  const tops = readIndex(v, names.end);
  const strings = readIndex(v, tops.end);
  const gsubrs = readIndex(v, strings.end).items;
  const top = readDict(v, tops.items[0][0], tops.items[0][1]);
  const csOff = off + (top.get(17)?.[0] ?? 0);
  const charStrings = readIndex(v, csOff).items;
  let subrs: [number, number][] = [];
  const priv = top.get(18);
  if (priv && priv.length >= 2) {
    const pOff = off + priv[1];
    const pd = readDict(v, pOff, pOff + priv[0]);
    const so = pd.get(19)?.[0];
    if (so) subrs = readIndex(v, pOff + so).items;
  }
  const bias = (n: number) => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);
  const f = (n: number) => String(Math.round(n * 100) / 100);
  return (g) => {
    const cs = charStrings[g];
    if (!cs) return [];
    const out: string[] = [];
    const stack: number[] = [];
    let x = 0, y = 0, nStems = 0, open = false, haveWidth = false;
    const moveTo = (nx: number, ny: number) => { x = nx; y = ny; out.push('m', f(x), f(y)); open = true; };
    const lineTo = (nx: number, ny: number) => { x = nx; y = ny; out.push('l', f(x), f(y)); };
    const curveTo = (c1x: number, c1y: number, c2x: number, c2y: number, ex: number, ey: number) => { out.push('b', f(ex), f(ey), f(c1x), f(c1y), f(c2x), f(c2y)); x = ex; y = ey; };
    const stems = () => { if (stack.length % 2 && !haveWidth) stack.shift(); haveWidth = true; nStems += stack.length >> 1; stack.length = 0; };
    const run = (s: number, e: number, depth: number): boolean => {
      let p = s;
      while (p < e) {
        const b = v.getUint8(p++);
        if (b >= 32) {
          if (b <= 246) stack.push(b - 139);
          else if (b <= 250) stack.push((b - 247) * 256 + v.getUint8(p++) + 108);
          else if (b <= 254) stack.push(-(b - 251) * 256 - v.getUint8(p++) - 108);
          else { stack.push(v.getInt32(p) / 65536); p += 4; }
          continue;
        }
        if (b === 28) { stack.push(v.getInt16(p)); p += 2; continue; }
        switch (b) {
          case 1: case 3: case 18: case 23: stems(); break;
          case 19: case 20: stems(); p += (nStems + 7) >> 3; break;
          case 21: if (stack.length > 2 && !haveWidth) stack.shift(); haveWidth = true; moveTo(x + stack[0], y + stack[1]); stack.length = 0; break;
          case 22: if (stack.length > 1 && !haveWidth) stack.shift(); haveWidth = true; moveTo(x + stack[0], y); stack.length = 0; break;
          case 4: if (stack.length > 1 && !haveWidth) stack.shift(); haveWidth = true; moveTo(x, y + stack[0]); stack.length = 0; break;
          case 5: for (let i = 0; i + 1 < stack.length; i += 2) lineTo(x + stack[i], y + stack[i + 1]); stack.length = 0; break;
          case 6: case 7: {
            let horiz = b === 6;
            for (const d of stack) { if (horiz) lineTo(x + d, y); else lineTo(x, y + d); horiz = !horiz; }
            stack.length = 0; break;
          }
          case 8: for (let i = 0; i + 5 < stack.length; i += 6) { const c1x = x + stack[i], c1y = y + stack[i + 1], c2x = c1x + stack[i + 2], c2y = c1y + stack[i + 3]; curveTo(c1x, c1y, c2x, c2y, c2x + stack[i + 4], c2y + stack[i + 5]); } stack.length = 0; break;
          case 24: { let i = 0; for (; i + 5 < stack.length - 2; i += 6) { const c1x = x + stack[i], c1y = y + stack[i + 1], c2x = c1x + stack[i + 2], c2y = c1y + stack[i + 3]; curveTo(c1x, c1y, c2x, c2y, c2x + stack[i + 4], c2y + stack[i + 5]); } lineTo(x + stack[i], y + stack[i + 1]); stack.length = 0; break; }
          case 25: { let i = 0; for (; i + 1 < stack.length - 6; i += 2) lineTo(x + stack[i], y + stack[i + 1]); const c1x = x + stack[i], c1y = y + stack[i + 1], c2x = c1x + stack[i + 2], c2y = c1y + stack[i + 3]; curveTo(c1x, c1y, c2x, c2y, c2x + stack[i + 4], c2y + stack[i + 5]); stack.length = 0; break; }
          case 26: case 27: {
            let i = 0;
            let d1 = 0;
            if (stack.length % 2) d1 = stack[i++];
            for (; i + 3 < stack.length; i += 4) {
              if (b === 26) { const c1x = x + d1, c1y = y + stack[i], c2x = c1x + stack[i + 1], c2y = c1y + stack[i + 2]; curveTo(c1x, c1y, c2x, c2y, c2x, c2y + stack[i + 3]); }
              else { const c1x = x + stack[i], c1y = y + d1, c2x = c1x + stack[i + 1], c2y = c1y + stack[i + 2]; curveTo(c1x, c1y, c2x, c2y, c2x + stack[i + 3], c2y); }
              d1 = 0;
            }
            stack.length = 0; break;
          }
          case 30: case 31: {
            let horiz = b === 31;
            for (let i = 0; i + 3 < stack.length; i += 4) {
              const last = i + 5 === stack.length;
              if (horiz) { const c1x = x + stack[i], c1y = y, c2x = c1x + stack[i + 1], c2y = c1y + stack[i + 2]; curveTo(c1x, c1y, c2x, c2y, c2x + (last ? stack[i + 4] : 0), c2y + stack[i + 3]); }
              else { const c1x = x, c1y = y + stack[i], c2x = c1x + stack[i + 1], c2y = c1y + stack[i + 2]; curveTo(c1x, c1y, c2x, c2y, c2x + stack[i + 3], c2y + (last ? stack[i + 4] : 0)); }
              horiz = !horiz;
            }
            stack.length = 0; break;
          }
          case 10: case 29: {
            const idx = stack.pop()! + bias(b === 10 ? subrs.length : gsubrs.length);
            const sub = (b === 10 ? subrs : gsubrs)[idx];
            if (sub && depth < 10 && run(sub[0], sub[1], depth + 1)) return true;
            break;
          }
          case 11: return false;
          case 14: if (stack.length && !haveWidth) stack.shift(); haveWidth = true; void open; return true;
          case 12: {
            const op2 = v.getUint8(p++);
            // flex variants: draw as two curves
            if (op2 === 35 && stack.length >= 12) { for (let i = 0; i < 12; i += 6) { const c1x = x + stack[i], c1y = y + stack[i + 1], c2x = c1x + stack[i + 2], c2y = c1y + stack[i + 3]; curveTo(c1x, c1y, c2x, c2y, c2x + stack[i + 4], c2y + stack[i + 5]); } }
            else if (op2 === 34 && stack.length >= 7) { const y0 = y; let c1x = x + stack[0], c1y = y, c2x = c1x + stack[1], c2y = c1y + stack[2]; curveTo(c1x, c1y, c2x, c2y, c2x + stack[3], c2y); c1x = x + stack[4]; c1y = y; c2x = c1x + stack[5]; c2y = y0; curveTo(c1x, c1y, c2x, c2y, c2x + stack[6], y0); }
            stack.length = 0; break;
          }
          default: stack.length = 0;
        }
      }
      return false;
    };
    run(cs[0], cs[1], 0);
    return out;
  };
}

/** Decode a base64 string to an ArrayBuffer. */
export function base64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
