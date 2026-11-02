// Hand-made 16x16 SVG icon set in the spirit of Blender 2.79's icon sheet.
// Names follow Blender's icon identifiers so code reads like Blender's Python UI.

const OL = '#1a1a1a';          // outline
const LT = '#e8e8e8';          // light glyph
const OR = '#f2a03c';          // object orange
const BL = '#6aa0e6';          // blue
const GR = '#7fc35a';          // green
const RD = '#e05a4a';          // red
const YE = '#f0d040';          // yellow
const GY = '#9a9a9a';

const s = (d: string, fill = LT, stroke = OL, w = 1) => `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`;
const ln = (d: string, stroke = OL, w = 1.2) => `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`;
const c = (cx: number, cy: number, r: number, fill = LT, stroke = OL, w = 1) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${w}"/>`;
const rect = (x: number, y: number, w: number, h: number, fill = LT, stroke = OL, rx = 1) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`;
const dot = (cx: number, cy: number, r = 1.2, fill = OL) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`;

const cube = (fill = LT) => s('M8 2.5 L13.5 5 L13.5 11 L8 13.5 L2.5 11 L2.5 5 Z', fill) + ln('M2.5 5 L8 7.5 L13.5 5 M8 7.5 L8 13.5', OL, 0.9);
const tri = (fill = LT) => s('M8 2.5 L13.5 13 L2.5 13 Z', fill) + dot(8, 2.5, 1.3) + dot(13.5, 13, 1.3) + dot(2.5, 13, 1.3);
const camera = (fill = LT) => s('M2 5.5 h8 v6 h-8 Z', fill) + s('M10 7.5 L14 5.5 L14 11.5 L10 9.5 Z', fill);
const bulb = (fill = YE) => s('M8 2 C11 2 12.5 4.2 12.5 6.3 C12.5 8.3 10.5 9.3 10.2 11 L5.8 11 C5.5 9.3 3.5 8.3 3.5 6.3 C3.5 4.2 5 2 8 2 Z', fill) + rect(6, 11.5, 4, 2.5, GY);
const empty = (stroke = OL) => ln('M8 2 V14 M2 8 H14 M4 4 L12 12', stroke, 1.4);
const sphere = (fill = LT) => c(8, 8, 5.5, fill) + ln('M2.5 8 C4.5 10 11.5 10 13.5 8 M8 2.5 C6 5 6 11 8 13.5', OL, 0.8);
const globe = () => c(8, 8, 5.8, BL) + ln('M2.2 8 H13.8 M8 2.2 C5 5 5 11 8 13.8 M8 2.2 C11 5 11 11 8 13.8 M3.3 5 H12.7 M3.3 11 H12.7', OL, 0.7);
const wrench = (fill = BL) => s('M11.5 1.8 C9.6 1.6 8.3 3.4 8.9 5.1 L2.4 11.6 C1.8 12.2 1.8 13.2 2.4 13.8 C3 14.4 4 14.4 4.6 13.8 L11.1 7.3 C12.8 7.9 14.6 6.4 14.2 4.4 L12.6 5.9 L10.9 5.3 L10.3 3.6 Z', fill);
const chain = () => s('M3 9.5 L6.5 6 C7.3 5.2 8.6 5.2 9.4 6 L9.5 6.1 L8.3 7.3 C8.1 7.1 7.7 7.1 7.5 7.3 L4.3 10.5 C4.1 10.7 4.1 11.1 4.3 11.3 L4.7 11.7 C4.9 11.9 5.3 11.9 5.5 11.7 L6.3 10.9 L7.6 11.1 L6.8 11.9 C6 12.7 4.7 12.7 3.9 11.9 L3.1 11.1 C2.3 10.3 2.3 10.1 3 9.5 Z', GY) + s('M13 6.5 L9.5 10 C8.7 10.8 7.4 10.8 6.6 10 L6.5 9.9 L7.7 8.7 C7.9 8.9 8.3 8.9 8.5 8.7 L11.7 5.5 C11.9 5.3 11.9 4.9 11.7 4.7 L11.3 4.3 C11.1 4.1 10.7 4.1 10.5 4.3 L9.7 5.1 L8.4 4.9 L9.2 4.1 C10 3.3 11.3 3.3 12.1 4.1 L12.9 4.9 C13.7 5.7 13.7 5.9 13 6.5 Z', GY);
const checker = () => rect(2.5, 2.5, 11, 11, '#fff') + `<path d="M3 3h2.6v2.6H3zM8.2 3h2.6v2.6H8.2zM5.6 5.6h2.6v2.6H5.6zM10.8 5.6h2.4v2.6h-2.4zM3 8.2h2.6v2.6H3zM8.2 8.2h2.6v2.6H8.2zM5.6 10.8h2.6v2.4H5.6zM10.8 10.8h2.4v2.4h-2.4z" fill="#c04040"/>`;
const material = () => c(8, 8, 5.8, RD) + `<circle cx="6" cy="6" r="2" fill="#ffd0c8" opacity="0.8"/>`;
const eye = (open = true) => open
  ? s('M1.5 8 C4 3.5 12 3.5 14.5 8 C12 12.5 4 12.5 1.5 8 Z', '#fff') + c(8, 8, 2.4, '#222', '#222')
  : ln('M1.5 7 C4 11 12 11 14.5 7 M4 9.5 L3 11.5 M8 10.6 V12.8 M12 9.5 L13 11.5', OL, 1.3);
const arrowCursor = (fill = '#fff') => s('M4 2 L4 13 L6.8 10.3 L8.8 14.5 L10.6 13.7 L8.6 9.6 L12.3 9.6 Z', fill);
const play = (fill = LT) => s('M4.5 3 L12.5 8 L4.5 13 Z', fill);
const triRight = (fill = '#000') => `<path d="M6 4 L11 8 L6 12 Z" fill="${fill}"/>`;
const triDown = (fill = '#000') => `<path d="M4 6 L12 6 L8 11 Z" fill="${fill}"/>`;
const plus = (stroke = '#000') => ln('M8 3 V13 M3 8 H13', stroke, 2);
const minus = (stroke = '#000') => ln('M3 8 H13', stroke, 2);
const xmark = (stroke = '#000') => ln('M4 4 L12 12 M12 4 L4 12', stroke, 2);
const lock = (open = false) => rect(3.5, 7.5, 9, 6.5, YE) + ln(open ? 'M5.5 7.5 V5 C5.5 2.5 10.5 2.5 10.5 5' : 'M5.5 7.5 V5 C5.5 2.5 10.5 2.5 10.5 5 V7.5', OL, 1.4);
const grid = (n = 4) => {
  let d = '';
  for (let i = 0; i <= n; i++) { const p = 2.5 + (11 / n) * i; d += `M${p} 2.5 V13.5 M2.5 ${p} H13.5 `; }
  return ln(d, OL, 0.9);
};
const meshDot = (x: number, y: number) => dot(x, y, 1.3, '#000');

const ICONS: Record<string, string> = {
  NONE: '',
  BLANK1: '',
  DOT: dot(8, 8, 2, '#000'),
  BLENDER: c(9, 9, 5, '#f5792a') + c(9, 9, 2.6, BL, '#fff', 0.8) + s('M1.5 7 L8 4 L5 1.5', '#f5792a', '#f5792a', 1.4),
  QUESTION: c(8, 8, 6, BL) + `<text x="8" y="11.5" font-size="10" text-anchor="middle" fill="#fff" font-family="sans-serif" font-weight="bold">?</text>`,
  INFO: c(8, 8, 6, BL) + `<text x="8" y="12" font-size="10" text-anchor="middle" fill="#fff" font-family="serif" font-weight="bold">i</text>`,
  ERROR: s('M8 1.8 L14.5 13.5 L1.5 13.5 Z', RD) + `<text x="8" y="12.4" font-size="9" text-anchor="middle" fill="#fff" font-family="sans-serif" font-weight="bold">!</text>`,
  CANCEL: c(8, 8, 6, RD) + xmark('#fff'),
  X: xmark(),
  PANEL_CLOSE: xmark(),
  ZOOMIN: plus(),
  ZOOMOUT: minus(),
  PLUS: plus(),
  TRIA_RIGHT: triRight(),
  TRIA_DOWN: triDown(),
  TRIA_UP: '<path d="M4 10 L12 10 L8 5 Z" fill="#000"/>',
  TRIA_LEFT: '<path d="M10 4 L5 8 L10 12 Z" fill="#000"/>',
  DISCLOSURE_TRI_RIGHT: triRight('#ddd'),
  DISCLOSURE_TRI_DOWN: triDown('#ddd'),
  CHECKMARK: ln('M3 8.5 L6.5 12 L13 4', '#000', 2),
  GRIP: dot(5, 5) + dot(8, 5) + dot(11, 5) + dot(5, 8) + dot(8, 8) + dot(11, 8) + dot(5, 11) + dot(8, 11) + dot(11, 11),
  // editors
  VIEW3D: cube(),
  TIME: c(8, 8, 6, LT) + ln('M8 4.5 V8 L10.5 9.5', OL, 1.4),
  IPO: rect(1.5, 2.5, 13, 11, '#555') + ln('M2.5 11.5 C6 11.5 6 4.5 9 4.5 C11 4.5 12 8 13.5 8', GR, 1.5),
  ACTION: rect(1.5, 2.5, 13, 11, '#555') + s('M5 5 L7 7 L5 9 L3 7 Z', YE) + s('M11 7 L13 9 L11 11 L9 9 Z', YE),
  NLA: rect(1.5, 2.5, 13, 11, '#555') + rect(3, 4.5, 6, 2.5, '#d8a050') + rect(7, 9, 6, 2.5, '#d8a050'),
  SEQUENCE: rect(1.5, 3, 13, 10, '#444') + rect(3, 5, 4, 3, BL) + rect(8, 9, 5, 3, GR),
  CLIP: rect(2, 3, 12, 10, '#444') + c(8, 8, 3, '#888') + ln('M2 5 H14 M2 11 H14', '#fff', 0.8),
  IMAGE_COL: rect(1.5, 2.5, 13, 11, '#fff') + s('M2 13 L6 7 L9 11 L11 9 L14 13 Z', GR, GR) + c(11, 5.5, 1.5, YE, YE),
  NODETREE: rect(1.5, 3, 5, 4, LT) + rect(9.5, 9, 5, 4, LT) + ln('M6.5 5 C9 5 7 11 9.5 11', OL, 1.2),
  LOGIC: rect(2, 3, 5, 4, LT) + rect(9, 9, 5, 4, LT) + ln('M7 5 H11 V9', OL, 1.2) + rect(2, 9, 5, 4, LT),
  TEXT: rect(3, 1.5, 10, 13, '#fff') + ln('M5 4.5 H11 M5 7 H11 M5 9.5 H11 M5 12 H9', OL, 0.9),
  CONSOLE: rect(1.5, 2.5, 13, 11, '#111', '#555') + ln('M4 6 L6.5 8 L4 10 M7.5 10.5 H11', '#ddd', 1.2),
  INFO_EDITOR: c(8, 8, 6, BL) + `<text x="8" y="12" font-size="10" text-anchor="middle" fill="#fff" font-family="serif" font-weight="bold">i</text>`,
  OOPS: rect(2, 2, 12, 12, LT) + ln('M4 5 H6 M7 5 H12 M5 8 H7 M8 8 H12 M5 11 H7 M8 11 H12', OL, 1.1),
  BUTS: rect(2, 2, 12, 12, LT) + rect(4, 4, 8, 2, BL) + rect(4, 7, 8, 2, GY) + rect(4, 10, 8, 2, GY),
  FILESEL: s('M1.5 4 h5 l1.5 1.5 h6.5 v8 h-13 Z', '#e8c060'),
  PREFERENCES: rect(2, 2, 12, 12, LT) + ln('M5 4 V12 M8 4 V12 M11 4 V12', OL, 1) + rect(4, 9, 2, 2, BL, OL, 0.5) + rect(7, 5, 2, 2, BL, OL, 0.5) + rect(10, 7, 2, 2, BL, OL, 0.5),
  // properties tabs
  SCENE: camera(GY),
  RENDER_STILL: camera(GY),
  RENDER_ANIMATION: rect(2, 3, 12, 10, '#444') + ln('M2 5.5 H14 M2 10.5 H14', '#fff', 0.8) + rect(5, 6.2, 6, 3.6, BL, '#fff', 0.3),
  RENDER_RESULT: rect(2, 2.5, 12, 11, '#444') + c(8, 8, 3, OR, '#000', 0.5),
  RENDERLAYERS: rect(4, 2, 10, 8, '#999') + rect(2, 5, 10, 8, '#ccc') + s('M3 12 L6 8 L8 10.5 L9.5 9 L11 12 Z', GR, GR, 0.5),
  SCENE_DATA: s('M5.5 3 L9 12 L2 12 Z', '#d0d0d0') + c(10.5, 9, 3.5, '#e8e8e8'),
  WORLD: globe(),
  WORLD_DATA: globe(),
  OBJECT_DATA: cube(OR),
  OBJECT_DATAMODE: cube(OR),
  CONSTRAINT: chain(),
  CONSTRAINT_DATA: chain(),
  MODIFIER: wrench(),
  MESH_DATA: tri(),
  CAMERA_DATA: camera(),
  LAMP_DATA: bulb(),
  EMPTY_DATA: empty(),
  MATERIAL: material(),
  MATERIAL_DATA: material(),
  TEXTURE: checker(),
  TEXTURE_DATA: checker(),
  PARTICLES: dot(4, 5, 1.5, '#fff') + dot(9, 3.5, 1.5, '#fff') + dot(12, 8, 1.5, '#fff') + dot(6, 10, 1.5, '#fff') + dot(10, 12.5, 1.5, '#fff') + c(8, 8, 6.5, 'none', '#222', 0.8),
  PHYSICS: c(8, 8, 2.8, BL) + `<ellipse cx="8" cy="8" rx="6.5" ry="2.6" fill="none" stroke="#222" stroke-width="1"/>` + dot(14, 8, 1.4, OR),
  // objects in outliner
  OUTLINER_OB_MESH: tri(OR),
  OUTLINER_OB_CAMERA: camera(OR),
  OUTLINER_OB_LAMP: bulb(OR),
  OUTLINER_OB_EMPTY: empty('#a05a00'),
  OUTLINER_OB_CURVE: ln('M2 12 C4 2 12 14 14 4', '#a05a00', 2),
  OUTLINER_OB_SURFACE: s('M2 11 C5 6 11 6 14 11 L14 13 L2 13 Z', OR),
  OUTLINER_OB_META: c(6, 9, 3.5, OR) + c(10.5, 7, 3, OR),
  OUTLINER_OB_FONT: `<text x="8" y="13" font-size="13" text-anchor="middle" fill="${OR}" stroke="${OL}" stroke-width="0.6" font-family="serif" font-weight="bold">a</text>`,
  OUTLINER_OB_ARMATURE: s('M4 12 L9 4 L11.5 6 L5.5 13 Z', OR) + c(10.5, 4.5, 2, OR),
  OUTLINER_OB_LATTICE: rect(2.5, 2.5, 11, 11, OR) + grid(3),
  OUTLINER_OB_SPEAKER: s('M3 6 H6 L10 2.5 V13.5 L6 10 H3 Z', OR),
  OUTLINER_OB_FORCE_FIELD: c(8, 8, 5.5, 'none', '#a05a00', 1.5) + c(8, 8, 2, OR),
  OUTLINER_OB_GROUP_INSTANCE: c(6, 7, 3, OR) + rect(8, 7, 6, 6, OR),
  OUTLINER_DATA_MESH: tri(),
  OUTLINER_DATA_CAMERA: camera(),
  OUTLINER_DATA_LAMP: bulb(),
  OUTLINER_DATA_EMPTY: empty(),
  OUTLINER_DATA_MATERIAL: material(),
  MESH_PLANE: s('M2 10 L8 13.5 L14 10 L8 6.5 Z', LT) + meshDot(2, 10) + meshDot(8, 13.5) + meshDot(14, 10) + meshDot(8, 6.5),
  MESH_CUBE: cube(),
  MESH_CIRCLE: `<ellipse cx="8" cy="9" rx="6" ry="4" fill="none" stroke="${OL}" stroke-width="1.3"/>` + meshDot(2, 9) + meshDot(14, 9) + meshDot(8, 5) + meshDot(8, 13),
  MESH_UVSPHERE: sphere(),
  MESH_ICOSPHERE: c(8, 8, 5.8) + ln('M8 2.2 L3 6 L5 12.7 L11 12.7 L13 6 Z M8 2.2 L8 7 M3 6 L8 7 L13 6 M5 12.7 L8 7 L11 12.7', OL, 0.7),
  MESH_CYLINDER: s('M3 4.5 V11.5 C3 14 13 14 13 11.5 V4.5 Z', LT) + `<ellipse cx="8" cy="4.5" rx="5" ry="2" fill="${LT}" stroke="${OL}" stroke-width="1"/>`,
  MESH_CONE: s('M8 2 L13 11.5 C13 14 3 14 3 11.5 Z', LT),
  MESH_TORUS: `<ellipse cx="8" cy="8.5" rx="6.3" ry="4.3" fill="${LT}" stroke="${OL}" stroke-width="1"/><ellipse cx="8" cy="8" rx="2.6" ry="1.4" fill="#727272" stroke="${OL}" stroke-width="1"/>`,
  MESH_GRID: rect(2.5, 2.5, 11, 11) + grid(4),
  MESH_MONKEY: c(8, 9, 5) + c(3, 6, 2) + c(13, 6, 2) + c(6.3, 8, 1.4, '#fff') + c(9.7, 8, 1.4, '#fff') + dot(6.3, 8, 0.6) + dot(9.7, 8, 0.6),
  CURVE_BEZCURVE: ln('M2 12 C4 2 12 14 14 4', OL, 1.4),
  CURVE_BEZCIRCLE: c(8, 8, 5, 'none'),
  CURVE_PATH: ln('M2 12 L6 6 L10 10 L14 4', OL, 1.4),
  // curves, surfaces and metaballs (Add menu)
  CURVE_NCURVE: ln('M2 12 L5 4 L11 4 L14 12', GY, 0.8) + ln('M2 12 C5 5.5 11 5.5 14 12', OL, 1.4) + dot(5, 4, 1.1) + dot(11, 4, 1.1),
  CURVE_NCIRCLE: ln('M3 3 H13 V13 H3 Z', GY, 0.8) + c(8, 8, 4.4, 'none', OL, 1.4) + dot(3, 3, 1.1) + dot(13, 3, 1.1) + dot(13, 13, 1.1) + dot(3, 13, 1.1),
  SURFACE_NCURVE: ln('M2 12 C5 5.5 11 5.5 14 12', OR, 1.8) + dot(2, 12, 1.1) + dot(14, 12, 1.1),
  SURFACE_NCIRCLE: c(8, 8, 4.8, 'none', OR, 1.8),
  SURFACE_NSURFACE: s('M2 9 C5 5.5 11 5.5 14 9 L14 12.5 C11 9 5 9 2 12.5 Z', LT) + ln('M6 7 V11.2 M10 7 V11.2', OL, 0.7),
  SURFACE_NCYLINDER: s('M3 4.5 V11.5 C3 14 13 14 13 11.5 V4.5 Z', LT) + `<ellipse cx="8" cy="4.5" rx="5" ry="2" fill="#cfcfcf" stroke="${OL}" stroke-width="1"/>` + ln('M5.5 6.3 V12.8 M10.5 6.3 V12.8', OL, 0.6),
  SURFACE_NSPHERE: c(8, 8, 5.5, LT) + ln('M2.5 8 C4.5 10.5 11.5 10.5 13.5 8 M2.5 8 C4.5 5.5 11.5 5.5 13.5 8', OL, 0.6),
  SURFACE_NTORUS: `<ellipse cx="8" cy="8.5" rx="6.3" ry="4.3" fill="${LT}" stroke="${OL}" stroke-width="1"/><ellipse cx="8" cy="8" rx="2.6" ry="1.4" fill="#727272" stroke="${OL}" stroke-width="1"/>` + ln('M3 6.5 C5 9 11 9 13 6.5', OL, 0.5),
  META_BALL: c(8, 8, 5.2, LT) + `<circle cx="6.3" cy="6.3" r="1.6" fill="#fff" opacity="0.8"/>`,
  META_CAPSULE: rect(1.8, 5, 12.4, 6, LT, OL, 3) + `<circle cx="5" cy="7" r="1.1" fill="#fff" opacity="0.8"/>`,
  META_PLANE: rect(2, 6, 12, 4, LT, OL, 2) + ln('M3.5 7.5 H12.5', '#fff', 0.8),
  META_ELLIPSOID: `<ellipse cx="8" cy="8" rx="6" ry="3.8" fill="${LT}" stroke="${OL}" stroke-width="1"/><circle cx="5.5" cy="6.6" r="1.2" fill="#fff" opacity="0.8"/>`,
  META_CUBE: rect(2.8, 2.8, 10.4, 10.4, LT, OL, 3) + `<circle cx="5.6" cy="5.6" r="1.3" fill="#fff" opacity="0.8"/>`,
  OUTLINER_DATA_CURVE: ln('M2 12 C4 2 12 14 14 4', OL, 1.6),
  OUTLINER_DATA_SURFACE: s('M2 11 C5 6 11 6 14 11 L14 13 L2 13 Z', LT),
  OUTLINER_DATA_META: c(6, 9, 3.5, LT) + c(10.5, 7, 3, LT),
  HANDLETYPE_AUTO_VEC: c(8, 8, 2.2, YE) + ln('M2 8 H14', YE, 1.2),
  HANDLETYPE_VECTOR_VEC: c(8, 8, 2.2, GR) + ln('M2 11 L8 8 L14 11', GR, 1.2),
  HANDLETYPE_ALIGNED_VEC: c(8, 8, 2.2, '#e070e0') + ln('M2 10 L14 6', '#e070e0', 1.2),
  HANDLETYPE_FREE_VEC: c(8, 8, 2.2, '#d02020') + ln('M2 11 L8 8 L14 5', '#d02020', 1.2),
  LAMP_POINT: bulb(),
  LAMP_SUN: c(8, 8, 3, YE) + ln('M8 1.5 V3.5 M8 12.5 V14.5 M1.5 8 H3.5 M12.5 8 H14.5 M3.4 3.4 L4.8 4.8 M11.2 11.2 L12.6 12.6 M3.4 12.6 L4.8 11.2 M11.2 4.8 L12.6 3.4', OL, 1.2),
  LAMP_SPOT: s('M6 2 H10 L13.5 13 H2.5 Z', YE),
  LAMP_HEMI: s('M2.5 10 C2.5 4 13.5 4 13.5 10 Z', YE) + ln('M4 12 L3 14 M8 12 V14.5 M12 12 L13 14', OL, 1.1),
  LAMP_AREA: rect(3, 3, 10, 7, YE) + ln('M4.5 12 L4 14.5 M8 12 V14.5 M11.5 12 L12 14.5', OL, 1.1),
  // outliner restriction toggles
  RESTRICT_VIEW_OFF: eye(true),
  RESTRICT_VIEW_ON: eye(false),
  VISIBLE_IPO_ON: eye(true),
  VISIBLE_IPO_OFF: eye(false),
  RESTRICT_SELECT_OFF: arrowCursor(),
  RESTRICT_SELECT_ON: arrowCursor('#777'),
  RESTRICT_RENDER_OFF: camera(GY),
  RESTRICT_RENDER_ON: camera('#555') + ln('M3 13 L13 3', OL, 1.2),
  // viewport shading
  BBOX: ln('M3 5 L8 2.5 L13 5 L13 11 L8 13.5 L3 11 Z M3 5 L8 7.5 L13 5 M8 7.5 V13.5', OL, 1),
  WIRE: ln('M8 2.5 L13.5 5 L13.5 11 L8 13.5 L2.5 11 L2.5 5 Z M2.5 5 L8 7.5 L13.5 5 M8 7.5 L8 13.5 M2.5 11 L8 7.5 L13.5 11', OL, 1),
  SOLID: cube('#bfbfbf'),
  TEXTURE_SHADED: s('M8 2.5 L13.5 5 L13.5 11 L8 13.5 L2.5 11 L2.5 5 Z', '#fff') + `<path d="M8 7.5 L13.5 5 L13.5 8 L10.7 9.3 Z M2.5 5 L5.2 6.3 L5.2 9.2 L2.5 8 Z M5.2 9.2 L8 10.5 L8 13.5 L5.2 12.2 Z" fill="#c04040"/>` + ln('M2.5 5 L8 7.5 L13.5 5 M8 7.5 L8 13.5', OL, 0.9),
  MATERIAL_SHADED: c(8, 8, 5.8, '#d06050'),
  SMOOTH: c(8, 8, 5.8, '#ddd') + `<circle cx="6.3" cy="6.3" r="2.3" fill="#fff"/>`,
  RENDERED: c(8, 8, 5.8, '#ffb070') + `<circle cx="6.3" cy="6.3" r="2.3" fill="#fff3d0"/>`,
  // pivot
  ROTATE: rect(3, 3, 10, 10, 'none') + dot(8, 8, 1.6),
  CURSOR: c(8, 8, 4.5, 'none', RD, 1.5) + `<circle cx="8" cy="8" r="4.5" fill="none" stroke="#fff" stroke-width="1.5" stroke-dasharray="3.5 3.5"/>` + ln('M8 1 V5 M8 11 V15 M1 8 H5 M11 8 H15', OL, 1),
  ROTATECOLLECTION: dot(4, 4, 1.6) + dot(12, 5, 1.6) + dot(6, 12, 1.6) + c(4, 4, 2.8, 'none', OL, 0.6) + c(12, 5, 2.8, 'none', OL, 0.6) + c(6, 12, 2.8, 'none', OL, 0.6),
  ROTATECENTER: dot(3, 4) + dot(13, 5) + dot(5, 13) + dot(12, 12) + c(8, 8, 1.8, OR),
  ROTACTIVE: dot(3, 4) + dot(13, 5) + dot(5, 13) + c(12, 12, 2, '#fff'),
  // manipulator
  MANIPUL: s('M5 14 L5 8 C5 6 7 6 7 8 L7 3 C7 1.5 9 1.5 9 3 L9 7 C9 5.5 11 5.5 11 7 L11 8.5 C11 7 13 7 13 8.5 L13 11 C13 13 11.5 14 10 14 Z', '#f2d0b0'),
  MAN_TRANS: ln('M8 14 V3 M5.5 5.5 L8 2.5 L10.5 5.5', '#000', 1.5),
  MAN_ROT: `<path d="M12.5 8 A4.5 4.5 0 1 1 8 3.5" fill="none" stroke="#000" stroke-width="1.5"/>` + ln('M6.5 1.8 L8.5 3.5 L6.8 5.5', '#000', 1.5),
  MAN_SCALE: ln('M3 13 L11 5', '#000', 1.5) + rect(10, 2.5, 3.5, 3.5, '#000', '#000', 0.2),
  // proportional / snapping
  PROP_OFF: c(8, 8, 5.5, 'none', OL, 1.2) + dot(8, 8, 1.5),
  PROP_ON: c(8, 8, 5.5, 'none', '#ffe080', 1.6) + dot(8, 8, 1.6, '#fff'),
  PROP_CON: c(8, 8, 5.5, 'none', '#ffe080', 1.6) + ln('M3 13 L8 8 L13 13', '#fff', 1.2),
  SNAP_OFF: s('M3 3 V9 C3 13 13 13 13 9 V3 H10 V9 C10 10.5 6 10.5 6 9 V3 Z', '#888'),
  SNAP_ON: s('M3 3 V9 C3 13 13 13 13 9 V3 H10 V9 C10 10.5 6 10.5 6 9 V3 Z', RD) + rect(3, 3, 3, 2, '#fff', OL, 0) + rect(10, 3, 3, 2, '#fff', OL, 0),
  SNAP_INCREMENT: grid(3) + dot(8.0, 8.0, 1.6, OR),
  SNAP_VERTEX: rect(3, 3, 10, 10, 'none') + c(13, 3, 2, OR),
  SNAP_EDGE: rect(3, 3, 10, 10, 'none') + ln('M3 3 H13', OR, 2),
  SNAP_FACE: rect(3, 3, 10, 10, OR),
  SNAP_VOLUME: cube(OR),
  // mesh select mode
  VERTEXSEL: s('M3 12 L3 5 L10 3 L13 10 Z', '#c8c8c8', '#555', 0.8) + c(3, 12, 1.8, '#fff', OL) + c(13, 10, 1.8, '#fff', OL) + c(10, 3, 1.8, '#fff', OL) + c(3, 5, 1.8, '#fff', OL),
  EDGESEL: s('M3 12 L3 5 L10 3 L13 10 Z', '#c8c8c8', '#555', 0.8) + ln('M3 12 L13 10', '#fff', 2.4) + ln('M3 12 L13 10', OL, 0.6),
  FACESEL: s('M3 12 L3 5 L10 3 L13 10 Z', '#fff', OL, 1),
  ORTHO: cube('#9fb3cc'),
  // playback
  REW: ln('M3 3 V13', '#000', 1.8) + s('M13 3 L5 8 L13 13 Z', LT),
  FF: ln('M13 3 V13', '#000', 1.8) + s('M3 3 L11 8 L3 13 Z', LT),
  PLAY: play(),
  PLAY_REVERSE: s('M11.5 3 L3.5 8 L11.5 13 Z', LT),
  PAUSE: rect(4, 3, 3, 10, LT) + rect(9, 3, 3, 10, LT),
  PREV_KEYFRAME: s('M8 4 L12 8 L8 12 L4 8 Z', YE) + s('M3 8 L1 6.5 L1 9.5 Z', '#000', '#000'),
  NEXT_KEYFRAME: s('M8 4 L12 8 L8 12 L4 8 Z', YE) + s('M13 8 L15 6.5 L15 9.5 Z', '#000', '#000'),
  REC: c(8, 8, 5, '#666', '#333'),
  REC_ON: c(8, 8, 5, '#e02020', '#300'),
  KEY_HLT: s('M8 2 L14 8 L8 14 L2 8 Z', YE),
  KEY_DEHLT: s('M8 2 L14 8 L8 14 L2 8 Z', '#ddd'),
  KEYINGSET: s('M3 9 C3 5 9 5 9 9 C9 13 3 13 3 9 Z', YE) + ln('M9 9 H14 M12 9 V12 M14 9 V11.5', OL, 1.4),
  KEYTYPE_KEYFRAME_VEC: s('M8 3 L13 8 L8 13 L3 8 Z', '#ddd'),
  // file
  FILE: s('M3.5 1.5 H9.5 L12.5 4.5 V14.5 H3.5 Z', '#fff'),
  FILE_NEW: s('M3.5 1.5 H9.5 L12.5 4.5 V14.5 H3.5 Z', '#fff') + ln('M8 6.5 V12.5 M5 9.5 H11', GR, 1.8),
  FILE_FOLDER: s('M1.5 4 h5 l1.5 1.5 h6.5 v8 h-13 Z', '#e8c060'),
  FILE_BLEND: s('M3.5 1.5 H9.5 L12.5 4.5 V14.5 H3.5 Z', '#fff') + c(8, 10, 2.5, '#f5792a', '#000', 0.6),
  FILE_TICK: s('M3.5 1.5 H9.5 L12.5 4.5 V14.5 H3.5 Z', '#fff') + ln('M5 9.5 L7 11.5 L11 7', GR, 1.8),
  RECOVER_LAST: s('M3.5 1.5 H9.5 L12.5 4.5 V14.5 H3.5 Z', '#fff') + ln('M10 10 A2.5 2.5 0 1 1 8 7.5 L9.5 7.5', BL, 1.4),
  RECOVER_AUTO: c(8, 8, 6, '#fff') + ln('M8 4.5 V8 L10.5 9.5', BL, 1.4),
  SAVE_AS: rect(2, 2, 12, 12, BL) + rect(4, 2, 8, 4.5, '#fff') + rect(4.5, 9, 7, 5, '#ddd'),
  FILE_REFRESH: ln('M12.5 8 A4.5 4.5 0 1 1 10.5 4.2', OL, 1.6) + s('M9.5 2 L12.5 3.5 L10.5 6 Z', OL, OL, 0.5),
  IMPORT: s('M3.5 1.5 H12.5 V14.5 H3.5 Z', '#fff') + ln('M1 8 H8.5 M6 5.5 L8.5 8 L6 10.5', GR, 1.6),
  EXPORT: s('M3.5 1.5 H12.5 V14.5 H3.5 Z', '#fff') + ln('M7 8 H15 M12.5 5.5 L15 8 L12.5 10.5', RD, 1.6),
  APPEND_BLEND: s('M3.5 1.5 H12.5 V14.5 H3.5 Z', '#fff') + plus(GR),
  LINK_BLEND: s('M3.5 1.5 H12.5 V14.5 H3.5 Z', '#fff') + chain(),
  QUIT: c(8, 9, 5, 'none', '#000', 1.6) + ln('M8 2 V8', '#000', 1.8),
  // misc
  LOCKED: lock(false),
  UNLOCKED: lock(true),
  PINNED: s('M6 2 H10 L9.5 7 L12 9.5 H4 L6.5 7 Z', RD) + ln('M8 9.5 V14.5', OL, 1.4),
  UNPINNED: s('M6 2 H10 L9.5 7 L12 9.5 H4 L6.5 7 Z', '#999') + ln('M8 9.5 V14.5', OL, 1.4),
  FAKE_USER_OFF: `<text x="8" y="12.5" font-size="11" text-anchor="middle" fill="#000" font-family="sans-serif">F</text>`,
  FAKE_USER_ON: `<text x="8" y="12.5" font-size="11" text-anchor="middle" fill="#fff" font-family="sans-serif" font-weight="bold">F</text>`,
  VIEWZOOM: c(6.5, 6.5, 4.2, '#ddd') + ln('M9.5 9.5 L14 14', OL, 2.2),
  HAND: s('M5 14 L5 8 C5 6 7 6 7 8 L7 3 C7 1.5 9 1.5 9 3 L9 7 C9 5.5 11 5.5 11 7 L11 8.5 C11 7 13 7 13 8.5 L13 11 C13 13 11.5 14 10 14 Z', '#f2d0b0'),
  FULLSCREEN_ENTER: ln('M2 6 V2 H6 M10 2 H14 V6 M14 10 V14 H10 M6 14 H2 V10', '#000', 1.5),
  FULLSCREEN_EXIT: ln('M6 2 V6 H2 M14 6 H10 V2 M10 14 V10 H14 M2 10 H6 V14', '#000', 1.5),
  SCRIPT: s('M4 2 H12 V12 C12 14 10 14 10 12 V4 H4 Z', '#fff') + ln('M6 6 H10 M6 8.5 H10', OL, 0.9),
  SCRIPTWIN: s('M4 2 H12 V12 C12 14 10 14 10 12 V4 H4 Z', '#fff'),
  URL: c(8, 8, 6, BL) + ln('M2 8 H14 M8 2 C5.5 5 5.5 11 8 14 M8 2 C10.5 5 10.5 11 8 14', '#fff', 0.8),
  HELP: c(8, 8, 6, BL) + `<text x="8" y="11.5" font-size="10" text-anchor="middle" fill="#fff" font-family="sans-serif" font-weight="bold">?</text>`,
  GROUP: c(5.5, 6, 3, LT) + c(10.5, 6, 3, LT) + c(8, 10.5, 3, LT),
  SOUND: s('M3 6 H6 L10 2.5 V13.5 L6 10 H3 Z', LT) + ln('M12 5 C13.5 7 13.5 9 12 11', OL, 1.2),
  IMAGE_DATA: rect(1.5, 2.5, 13, 11, '#fff') + s('M2 13 L6 7 L9 11 L11 9 L14 13 Z', GR, GR) + c(11, 5.5, 1.5, YE, YE),
  NODE: rect(2, 4, 12, 8, LT) + rect(2, 4, 12, 2.5, '#888'),
  LINKED: chain(),
  UNLINKED: ln('M3 13 L13 3', OL, 1.2) + chain(),
  EDITMODE_HLT: tri(OR),
  OBJECT_MODE: cube(OR),
  SCULPTMODE_HLT: c(8, 8, 5.5, LT) + ln('M3 9 C6 7 10 11 13 8', BL, 1.5),
  VPAINT_HLT: s('M3 13 L5 9 L11 3 L13 5 L7 11 Z', LT) + c(4, 12, 1.8, RD, RD),
  WPAINT_HLT: s('M3 13 L5 9 L11 3 L13 5 L7 11 Z', LT) + c(4, 12, 1.8, '#3060e0', '#3060e0'),
  TPAINT_HLT: s('M3 13 L5 9 L11 3 L13 5 L7 11 Z', LT) + c(4, 12, 1.8, GR, GR),
  POSE_HLT: s('M4 12 L9 4 L11.5 6 L5.5 13 Z', BL) + c(10.5, 4.5, 2, BL),
  PARTICLEMODE: dot(4, 5, 1.6) + dot(9, 3.5, 1.6) + dot(12, 8, 1.6) + dot(6, 10, 1.6) + dot(10, 12.5, 1.6),
  SORTALPHA: `<text x="8" y="12" font-size="9" text-anchor="middle" fill="#000" font-family="sans-serif">az</text>`,
  FILTER: s('M2 3 H14 L9.5 8.5 V13 L6.5 14 V8.5 Z', LT),
  COLLAPSEMENU: ln('M3 4 H13 M3 8 H13 M3 12 H13', '#000', 1.6),
  DOWNARROW_HLT: triDown(),
  RIGHTARROW: triRight(),
  RADIOBUT_OFF: c(8, 8, 4.5, '#444'),
  RADIOBUT_ON: c(8, 8, 4.5, '#444') + dot(8, 8, 2, '#fff'),
  CHECKBOX_DEHLT: rect(3, 3, 10, 10, '#444', '#000', 2),
  CHECKBOX_HLT: rect(3, 3, 10, 10, '#444', '#000', 2) + ln('M5 8 L7 10.5 L11 5.5', '#fff', 1.6),
  MOD_SUBSURF: s('M3 9 C3 4 13 4 13 9 C13 13 3 13 3 9 Z', BL) + ln('M3 9 H13 M8 4.5 V13', OL, 0.8),
  MOD_MIRROR: s('M7 3 L2 13 H7 Z', BL) + s('M9 3 L14 13 H9 Z', LT) + ln('M8 1.5 V14.5', OL, 0.8),
  MOD_ARRAY: rect(1.5, 5, 4, 6, BL) + rect(6, 5, 4, 6, BL) + rect(10.5, 5, 4, 6, LT),
  MOD_SOLIDIFY: s('M2 6 L10 3 L14 6 L14 10 L6 13 L2 10 Z', BL) + ln('M2 6 L6 9 L14 6 M6 9 V13', OL, 0.8),
  MOD_TRIANGULATE: s('M2.5 13 L8 3 L13.5 13 Z', BL) + ln('M5.3 8 L10.7 8 L8 13 Z', OL, 0.8),
  MOD_SMOOTH: ln('M1.5 10 C4 4 6 4 8 8 C10 12 12 12 14.5 6', BL, 2),
  MOD_WAVE: ln('M1.5 8 C3.5 3 5.5 3 8 8 C10.5 13 12.5 13 14.5 8', BL, 2),
  MOD_DISPLACE: rect(2, 9, 12, 4, LT) + s('M2 9 C5 9 5 4 8 4 C11 4 11 9 14 9 Z', BL),
  MOD_SIMPLEDEFORM: s('M4 2 C9 5 3 11 8 14 L12 14 C7 11 13 5 8 2 Z', BL),
  MOD_CAST: c(8, 8, 5.5, 'none', OL, 1) + rect(4.5, 4.5, 7, 7, BL),
  MOD_DECIM: s('M2.5 13 L8 3 L13.5 13 Z', BL),
  MOD_EDGESPLIT: s('M2 12 L7 4 L7 12 Z', BL) + s('M9 12 L9 4 L14 12 Z', BL),
  MOD_WIREFRAME: ln('M2.5 13 L8 3 L13.5 13 Z M5.3 8 L10.7 8', BL, 1.6),
  MOD_BEVEL: s('M2 13 V6 L6 2 H14 V13 Z', BL),
  MOD_SCREW: ln('M3 4 C13 4 13 7 3 7 C13 7 13 10 3 10 C13 10 13 13 3 13', BL, 1.4),
  MOD_BUILD: rect(2, 9, 4, 4, BL) + rect(6, 9, 4, 4, BL) + rect(10, 9, 4, 4, LT) + rect(2, 5, 4, 4, BL),
  MOD_BOOLEAN: c(6, 8, 4, BL) + c(10, 8, 4, LT),
  MOD_LATTICE: rect(2.5, 2.5, 11, 11, BL) + grid(3),
  MOD_CURVE: ln('M2 12 C4 2 12 14 14 4', BL, 2),
  MOD_SHRINKWRAP: c(8, 8, 5, 'none', OL, 1) + c(8, 8, 3, BL),
  MOD_MESHDEFORM: cube(BL),
  MOD_SKIN: s('M3 3 L13 3 L13 13 L3 13 Z', BL),
  MOD_REMESH: rect(2.5, 2.5, 11, 11, BL) + grid(4),
  MOD_MASK: c(8, 8, 5.5, '#444') + c(8, 8, 2.5, '#fff'),
  MOD_MULTIRES: s('M3 9 C3 4 13 4 13 9 C13 13 3 13 3 9 Z', BL) + grid(3),
  MOD_UVPROJECT: rect(2, 2, 12, 12, '#fff') + checker(),
  MOD_WARP: ln('M2 4 C8 4 8 12 14 12', BL, 2),
  MOD_HOOK: ln('M8 2 V10 C8 14 3 14 3 10', BL, 2),
  MOD_CLOTH: s('M2 3 H14 V9 C10 13 6 7 2 11 Z', BL),
  MOD_FLUIDSIM: s('M8 2 C12 7 12 9 12 10 C12 12.5 10 14 8 14 C6 14 4 12.5 4 10 C4 9 4 7 8 2 Z', BL),
  MOD_SMOKE: c(6, 10, 3, '#bbb') + c(10, 8, 3.5, '#ddd') + c(8, 5, 2.5, '#eee'),
  MOD_SOFT: c(8, 9, 5, BL) + c(6, 7, 1.5, '#fff'),
  MOD_PHYSICS: c(8, 8, 2.8, BL),
  MOD_PARTICLES: dot(4, 5, 1.5) + dot(9, 3.5, 1.5) + dot(12, 8, 1.5) + dot(6, 10, 1.5),
  MOD_DYNAMICPAINT: s('M3 13 L5 9 L11 3 L13 5 L7 11 Z', BL),
  MOD_OCEAN: ln('M1.5 7 C3.5 4 5.5 4 8 7 C10.5 10 12.5 10 14.5 7 M1.5 11 C3.5 8 5.5 8 8 11 C10.5 14 12.5 14 14.5 11', BL, 1.4),
  MOD_EXPLODE: dot(8, 8, 2) + ln('M8 1.5 V4 M8 12 V14.5 M1.5 8 H4 M12 8 H14.5 M3 3 L5 5 M11 11 L13 13 M3 13 L5 11 M11 5 L13 3', BL, 1.4),
  MOD_DATA_TRANSFER: ln('M2 5 H12 M9 2 L12 5 L9 8 M14 11 H4 M7 8 L4 11 L7 14', BL, 1.4),
  MOD_NORMALEDIT: ln('M2 12 H14 M8 12 V3 M5.5 5.5 L8 3 L10.5 5.5', BL, 1.4),
  MOD_LAPLACIAN: ln('M1.5 10 C4 4 6 4 8 8 C10 12 12 12 14.5 6', BL, 2),
  MOD_VERTEX_WEIGHT: s('M2 13 L8 3 L14 13 Z', RD),
  FORCE_FORCE: c(8, 8, 2.5, OR) + c(8, 8, 5.5, 'none', OL, 1),
  FORCE_WIND: ln('M2 5 H11 C14 5 14 1.5 11 2 M2 8 H13 M2 11 H10 C13 11 13 14.5 10 14', OL, 1.4),
  FORCE_VORTEX: ln('M8 8 C10 8 10 5 8 5 C5 5 5 11 8 11 C12 11 12 3 8 3 C3 3 3 13 8 13', OL, 1.2),
  FORCE_MAGNETIC: s('M3 3 V9 C3 13 13 13 13 9 V3 H10 V9 C10 10.5 6 10.5 6 9 V3 Z', RD),
  FORCE_HARMONIC: ln('M2 8 L4 3 L6 13 L8 3 L10 13 L12 3 L14 8', OL, 1.2),
  FORCE_CHARGE: c(8, 8, 5, YE) + plus(),
  FORCE_LENNARDJONES: c(5, 8, 3, YE) + c(11, 8, 3, BL),
  FORCE_TEXTURE: checker(),
  FORCE_CURVE: ln('M2 12 C4 2 12 14 14 4', OL, 1.6),
  FORCE_BOID: s('M2 9 L14 5 L9 13 L8 9 Z', LT),
  FORCE_TURBULENCE: ln('M2 5 C5 2 6 9 9 6 C12 3 13 10 14 8 M2 11 C5 8 6 15 9 12', OL, 1.2),
  FORCE_DRAG: ln('M2 8 H14 M10 4 L14 8 L10 12', OL, 1.4),
  FORCE_SMOKEFLOW: c(6, 10, 3, '#bbb') + c(10, 7, 3, '#ddd'),
  STICKY_UVS_LOC: rect(2, 2, 12, 12, '#fff'),
  SPACE2: ln('M3 13 L8 3 L13 13', OL, 1.4),
  CAMERA_STEREO: camera(),
  AXIS_TOP: ln('M8 14 V3', BL, 1.6) + ln('M3 12 L13 12', RD, 1.6),
  AXIS_FRONT: ln('M3 12 H13', RD, 1.6) + ln('M3 12 V3', BL, 1.6),
  AXIS_SIDE: ln('M3 12 H13', GR, 1.6) + ln('M3 12 V3', BL, 1.6),
  ALIGN: ln('M2 3 H14 M4 7 H12 M2 11 H14', OL, 1.6),
  ANIM: s('M8 2 L14 8 L8 14 L2 8 Z', YE),
  ANIM_DATA: s('M8 2 L14 8 L8 14 L2 8 Z', YE),
  MARKER: s('M4 3 H12 V9 L8 13 L4 9 Z', '#fff'),
  MARKER_HLT: s('M4 3 H12 V9 L8 13 L4 9 Z', '#ffd040'),
  SAVE_COPY: rect(2, 2, 12, 12, BL) + rect(4, 2, 8, 4.5, '#fff'),
  SAVE_PREFS: rect(2, 2, 12, 12, BL) + rect(4, 2, 8, 4.5, '#fff') + rect(4.5, 9, 7, 5, '#ddd'),
  WINDOW: rect(1.5, 2.5, 13, 11, '#ddd') + rect(1.5, 2.5, 13, 3, BL),
  SPLITSCREEN: rect(1.5, 2.5, 13, 11, '#ddd') + ln('M8 2.5 V13.5', OL, 1.2),
  GHOST_ENABLED: c(8, 7, 5, '#ddd'),
  RENDER_REGION: `<rect x="2.5" y="3.5" width="11" height="9" fill="none" stroke="#000" stroke-dasharray="2 1.5"/>`,
  BORDER_RECT: `<rect x="2.5" y="3.5" width="11" height="9" fill="none" stroke="#000" stroke-dasharray="2 1.5"/>`,
  BORDERMOVE: `<rect x="2.5" y="3.5" width="11" height="9" fill="none" stroke="#000" stroke-dasharray="2 1.5"/>` + arrowCursor(),
  MOUSE_LMB: rect(4, 2, 8, 12, '#ddd', OL, 4) + `<path d="M4.5 6 V5 C4.5 3 6 2.5 8 2.5 V6 Z" fill="#000"/>`,
  MOUSE_MMB: rect(4, 2, 8, 12, '#ddd', OL, 4) + rect(7, 3.5, 2, 3, '#000', '#000', 1),
  MOUSE_RMB: rect(4, 2, 8, 12, '#ddd', OL, 4) + `<path d="M11.5 6 V5 C11.5 3 10 2.5 8 2.5 V6 Z" fill="#000"/>`,
  LAYER_USED: dot(8, 8, 2, '#000'),
  LAYER_ACTIVE: dot(8, 8, 2.4, OR),
  OUTLINER: rect(2, 2, 12, 12, LT) + ln('M4 5 H6 M7 5 H12 M5 8 H7 M8 8 H12 M5 11 H7 M8 11 H12', OL, 1.1),
  BORDER_LASSO: ln('M3 10 C1 5 9 1 12 4 C15 7 10 11 7 10 L6 14', OL, 1.2),
  SORTSIZE: ln('M3 4 H13 M3 8 H10 M3 12 H7', OL, 1.6),
  LAMP: bulb(),
  CAMERA: camera(),
  OBJECT_ORIGIN: c(8, 8, 3, OR),
  CLIPUV_HLT: rect(2, 2, 12, 12, 'none'),
  NEW: FILE_NEW_PLACEHOLDER(),
  DUPLICATE: rect(2, 2, 8, 8, '#ddd') + rect(6, 6, 8, 8, '#fff'),
  COPYDOWN: rect(2, 2, 8, 8, '#ddd') + rect(6, 6, 8, 8, '#fff'),
  PASTEDOWN: rect(4, 3, 8, 11, '#e8c060') + rect(6, 2, 4, 3, '#999'),
  TRASH: s('M4 5 H12 L11 14 H5 Z', '#ddd') + ln('M3 4 H13 M6.5 4 V2.5 H9.5 V4', OL, 1.2),
  LOOP_BACK: ln('M12 8 A4 4 0 1 1 8 4 H10', OL, 1.6) + s('M9 1.8 L11.5 4 L9 6.2 Z', OL, OL, 0.5),
  LOOP_FORWARDS: ln('M4 8 A4 4 0 1 0 8 4 H6', OL, 1.6) + s('M7 1.8 L4.5 4 L7 6.2 Z', OL, OL, 0.5),
  BACK: ln('M10 3 L5 8 L10 13', OL, 2),
  FORWARD: ln('M6 3 L11 8 L6 13', OL, 2),
  MOVE_UP_VEC: ln('M4 10 L8 5 L12 10', OL, 1.8),
  MOVE_DOWN_VEC: ln('M4 6 L8 11 L12 6', OL, 1.8),
  TRIA_UP_BAR: '<path d="M4 11 L12 11 L8 6 Z" fill="#000"/>' + ln('M4 4 H12', '#000', 1.5),
  TRIA_DOWN_BAR: '<path d="M4 5 L12 5 L8 10 Z" fill="#000"/>' + ln('M4 12 H12', '#000', 1.5),
  STYLUS_PRESSURE: ln('M3 13 L11 5 L13 3', OL, 1.6),
  GREASEPENCIL: s('M3 13 L4 10 L11 3 L13 5 L6 12 Z', '#e8c060'),
  BRUSH_DATA: s('M3 13 L5 9 L11 3 L13 5 L7 11 Z', '#ddd'),
  TEMPERATURE: rect(6.5, 2, 3, 9, '#fff', OL, 1.5) + c(8, 12, 2.5, RD),
  MONKEY: c(8, 9, 5) + c(3, 6, 2) + c(13, 6, 2) + c(6.3, 8, 1.4, '#fff') + c(9.7, 8, 1.4, '#fff'),
  WORDWRAP_ON: ln('M2 4 H14 M2 8 H12 C14 8 14 12 12 12 H9', OL, 1.3),
  LINENUMBERS_ON: `<text x="4" y="7" font-size="5.5" fill="#000" font-family="monospace">1</text><text x="4" y="13" font-size="5.5" fill="#000" font-family="monospace">2</text>` + ln('M8 5 H14 M8 11 H14', OL, 1.2),
  SYNTAX_ON: `<text x="8" y="12" font-size="9" text-anchor="middle" fill="${BL}" font-family="monospace" font-weight="bold">{}</text>`,
  PLUGIN: rect(3, 5, 10, 8, '#ddd') + rect(5, 2, 2, 4, '#999') + rect(9, 2, 2, 4, '#999'),
  HIDE_ON: eye(false),
  HIDE_OFF: eye(true),
  SPEAKER: s('M3 6 H6 L10 2.5 V13.5 L6 10 H3 Z', LT),
  CURVE_DATA: ln('M2 12 C4 2 12 14 14 4', OL, 1.6),
  FONT_DATA: `<text x="8" y="13" font-size="13" text-anchor="middle" fill="${LT}" stroke="${OL}" stroke-width="0.6" font-family="serif" font-weight="bold">a</text>`,
  ARMATURE_DATA: s('M4 12 L9 4 L11.5 6 L5.5 13 Z', LT) + c(10.5, 4.5, 2, LT),
  BONE_DATA: s('M3.5 12.5 L5 9 L10 4 L12 6 L7 11 Z', LT) + c(4, 12, 1.6, LT) + c(11.3, 4.7, 1.8, LT),
  OUTLINER_DATA_ARMATURE: s('M4 12 L9 4 L11.5 6 L5.5 13 Z', LT) + c(10.5, 4.5, 2, LT),
  OUTLINER_DATA_LATTICE: rect(2.5, 2.5, 11, 11, LT) + grid(3),
  OUTLINER_DATA_POSE: s('M4 12 L9 4 L11.5 6 L5.5 13 Z', BL) + c(10.5, 4.5, 2, BL),
  POSE_DATA: s('M4 12 L9 4 L11.5 6 L5.5 13 Z', BL) + c(10.5, 4.5, 2, BL),
  MOD_ARMATURE: s('M3 13 L8.5 4.5 L11 6.5 L5 13.5 Z', BL) + c(10.2, 5, 2, BL) + ln('M1.5 9 L4 7', OL, 1),
  HOOK: ln('M9 2 V9 C9 12.5 4 12.5 4 9.5', OL, 2.2) + ln('M9 2 V9 C9 12.5 4 12.5 4 9.5', LT, 1.1) + ln('M2.8 10.8 L4 9.5 L5.4 10.5', OL, 1.2),
  GROUP_VERTEX: s('M3 12 L8 3 L13 12 Z', LT) + dot(3, 12, 1.6, '#000') + dot(8, 3, 1.6, '#000') + dot(13, 12, 1.6, '#000'),
  GROUP_BONE: s('M3.5 12.5 L5 9 L10 4 L12 6 L7 11 Z', GR) + c(4, 12, 1.6, GR) + c(11.3, 4.7, 1.8, GR),
  CONSTRAINT_BONE: ln('M3 5 L6 2 L9 5 M6 2 V9', OL, 1.4) + s('M8 14 L9.5 10.5 L13 7 L14.5 8.5 L11 12 Z', LT) + c(13.5, 7.5, 1.4, LT),
  LATTICE_DATA: rect(2.5, 2.5, 11, 11, LT) + grid(3),
  META_DATA: c(6, 9, 3.5, LT) + c(10.5, 7, 3, LT),
  SURFACE_DATA: s('M2 11 C5 6 11 6 14 11 L14 13 L2 13 Z', LT),
  OUTLINER_DATA_FONT: `<text x="8" y="13" font-size="13" text-anchor="middle" fill="${LT}" stroke="${OL}" stroke-width="0.6" font-family="serif" font-weight="bold">a</text>`,
};

function FILE_NEW_PLACEHOLDER(): string {
  return s('M3.5 1.5 H9.5 L12.5 4.5 V14.5 H3.5 Z', '#fff') + ln('M8 6.5 V12.5 M5 9.5 H11', GR, 1.8);
}

// node, NLA, sequencer and movie clip editor icons
const mk = (x: number, y: number) => rect(x - 3, y - 3, 6, 6, 'none', '#000', 0) + ln(`M${x - 4.5} ${y} H${x - 1.5} M${x + 1.5} ${y} H${x + 4.5} M${x} ${y - 4.5} V${y - 1.5} M${x} ${y + 1.5} V${y + 4.5}`, '#000', 1);
Object.assign(ICONS, {
  NODE_COMPOSITING: rect(1.5, 2.5, 7, 6, '#ddd') + s('M2.5 7.5 L4.5 5 L6 6.5 L7.5 4.5 L7.5 7.5 Z', GR, GR, 0.5) + rect(9.5, 8.5, 5, 5, LT) + ln('M8.5 5.5 C11 5.5 7.5 11 9.5 11', OL, 1.1),
  NODE_MATERIAL: c(5, 6, 3.6, RD) + `<circle cx="4" cy="5" r="1.2" fill="#ffd0c8"/>` + rect(9.5, 8.5, 5, 5, LT) + ln('M8.6 6 C11 6 7.5 11 9.5 11', OL, 1.1),
  NODE_TEXTURE: rect(1.5, 2.5, 6.5, 6.5, '#fff') + `<path d="M2 3h2.8v2.8H2zM4.8 5.8h2.8v2.8H4.8z" fill="#c04040"/>` + rect(9.5, 8.5, 5, 5, LT) + ln('M8 5.5 C11 5.5 7.5 11 9.5 11', OL, 1.1),
  ARROW_LEFTRIGHT: ln('M2 8 H14 M2 8 L5 5 M2 8 L5 11 M14 8 L11 5 M14 8 L11 11', '#000', 1.5),
  FILE_MOVIE: rect(2.5, 1.5, 11, 13, '#444') + rect(5, 3.5, 6, 9, BL) + `<path d="M3.3 3h1v1.4h-1zM3.3 6h1v1.4h-1zM3.3 9h1v1.4h-1zM3.3 12h1v1.4h-1zM11.7 3h1v1.4h-1zM11.7 6h1v1.4h-1zM11.7 9h1v1.4h-1zM11.7 12h1v1.4h-1z" fill="#ddd"/>`,
  FILE_IMAGE: rect(1.5, 2.5, 13, 11, '#fff') + s('M2 13 L6 7 L9 11 L11 9 L14 13 Z', GR, GR) + c(11, 5.5, 1.5, YE, YE),
  MUTE_IPO_OFF: rect(3, 3, 10, 10, LT) + ln('M5 8 L7.3 10.5 L11.5 5', '#000', 1.6),
  MUTE_IPO_ON: rect(3, 3, 10, 10, '#777'),
  SOLO_OFF: s('M8 1.8 L9.8 6 L14.3 6.2 L10.8 9 L12 13.6 L8 11 L4 13.6 L5.2 9 L1.7 6.2 L6.2 6 Z', 'none', '#222', 1),
  SOLO_ON: s('M8 1.8 L9.8 6 L14.3 6.2 L10.8 9 L12 13.6 L8 11 L4 13.6 L5.2 9 L1.7 6.2 L6.2 6 Z', YE, '#222', 1),
  SEQ_SEQUENCER: rect(1.5, 2.5, 13, 11, '#444') + rect(2.5, 4, 7, 2.5, BL) + rect(6, 7.5, 7.5, 2.5, GR) + rect(3.5, 11, 5, 1.8, '#c8a050'),
  SEQ_PREVIEW: rect(1.5, 3, 13, 10, '#222') + s('M2.5 12 L6 7.5 L8.5 10.5 L10.5 8.5 L13.5 12 Z', GR, GR, 0.5) + c(11.5, 5.5, 1.2, YE, YE),
  SEQ_SPLITVIEW: rect(1.5, 1.5, 13, 6, '#222') + s('M2.5 7 L5 4 L7 6 L9 4.5 L13.5 7 Z', GR, GR, 0.5) + rect(1.5, 9, 13, 5.5, '#444') + rect(2.5, 10, 6, 1.5, BL) + rect(7, 12, 6, 1.5, GR),
  COLOR: c(6, 6, 3.2, RD) + c(10, 6, 3.2, GR) + c(8, 10, 3.2, BL),
  TRACKING: mk(8, 8),
  TRACKER: mk(8, 8),
  TRACKING_FORWARDS: mk(5.5, 8) + s('M10.5 4.5 L14.5 8 L10.5 11.5 Z', '#000', '#000', 0.5),
  TRACKING_BACKWARDS: mk(10.5, 8) + s('M5.5 4.5 L1.5 8 L5.5 11.5 Z', '#000', '#000', 0.5),
  TRACKING_FORWARDS_SINGLE: mk(5.5, 8) + s('M10.5 5 L13.5 8 L10.5 11 Z', '#000', '#000', 0.5) + ln('M14.5 5 V11', '#000', 1.2),
  TRACKING_BACKWARDS_SINGLE: mk(10.5, 8) + s('M5.5 5 L2.5 8 L5.5 11 Z', '#000', '#000', 0.5) + ln('M1.5 5 V11', '#000', 1.2),
  NLA_PUSHDOWN: rect(2, 10.5, 12, 3.5, '#d8a050') + s('M6 2 H10 V5.5 H12.5 L8 9.5 L3.5 5.5 H6 Z', LT),
  ACTION_TWEAK: rect(1.5, 2.5, 13, 11, '#555') + s('M5 5 L7 7 L5 9 L3 7 Z', YE) + s('M8.5 12.5 L9 10 L13 6 L14.5 7.5 L10.5 11.5 Z', '#f0a040'),
  FCURVE: ln('M1.5 12 C5 12 5 4 8 4 C11 4 11 12 14.5 12', '#000', 1.4),
  FILE_SOUND: s('M3 6 H6 L10 2.5 V13.5 L6 10 H3 Z', LT) + ln('M12 5 C13.5 7 13.5 9 12 11', OL, 1.2),
});

// aliases
ICONS.OPEN_RECENT = ICONS.FILE_FOLDER;
ICONS.LOAD_FACTORY = ICONS.FILE_REFRESH;
ICONS.MATERIAL_DATA = ICONS.MATERIAL;
ICONS.MESH = ICONS.MESH_DATA;

// UV editing, images and texture paint
const uvSquare = (extra: string) => rect(2, 2, 12, 12, '#7a7a7a', OL, 0.5) + ln('M2 8 H14 M8 2 V14', '#5a5a5a', 0.8) + extra;
const brushTip = (fill: string) => s('M2.5 13.5 L4.5 9.5 L11 3 L13 5 L6.5 11.5 Z', '#ddd') + c(4, 12, 2, fill, OL, 0.8);
Object.assign(ICONS, {
  GROUP_UVS: rect(2.5, 2.5, 11, 11, '#d0d0d0') + ln('M2.5 8 H13.5 M8 2.5 V13.5', OL, 0.8) + s('M4 12 L8 4 L12 12 Z', 'none', '#c03030', 1.2),
  UV_VERTEXSEL: uvSquare(s('M4 12 L12 12 L12 4 Z', 'none', LT, 0.9) + dot(12, 4, 1.8, OR)),
  UV_EDGESEL: uvSquare(s('M4 12 L12 12 L12 4 Z', 'none', LT, 0.9) + ln('M4 12 L12 12', OR, 2)),
  UV_FACESEL: uvSquare(s('M4 12 L12 12 L12 4 Z', 'rgba(242,160,60,0.6)', OR, 1.2)),
  UV_ISLANDSEL: uvSquare(s('M3 12 L7 12 L7 8 Z', 'rgba(242,160,60,0.6)', OR, 1) + s('M9 7 L13 7 L13 3 Z', 'rgba(242,160,60,0.6)', OR, 1)),
  UV_SYNC_SELECT: s('M2 6 L8 2.5 L14 6 L8 9.5 Z', LT) + ln('M2 10 L8 13.5 L14 10', OR, 1.4) + ln('M8 9.5 V13.5', OR, 1),
  STICKY_UVS_DISABLE: rect(2, 2, 5, 5, LT) + rect(9, 9, 5, 5, LT),
  STICKY_UVS_VERT: rect(2, 2, 5, 5, LT) + rect(9, 9, 5, 5, LT) + ln('M7 7 L9 9', OR, 1.6),
  IMAGE_RGB: rect(2, 3, 12, 10, '#fff') + rect(3, 4, 3, 8, RD, RD, 0) + rect(6.5, 4, 3, 8, GR, GR, 0) + rect(10, 4, 3, 8, BL, BL, 0),
  IMAGE_RGB_ALPHA: checker(),
  IMAGE_ALPHA: rect(2, 3, 12, 10, '#fff') + `<path d="M2 3 H14 L2 13 Z" fill="#222"/>`,
  BRUSH_TEXDRAW: brushTip('#e0e0e0'),
  BRUSH_SOFTEN: brushTip('#b0c8e0'),
  BRUSH_SMEAR: brushTip('#e0b0b0'),
  BRUSH_CLONE: brushTip(GR),
  BRUSH_TEXFILL: s('M3 7 L8 2.5 L13 7 L8 12.5 Z', LT) + s('M11 9 C12 11 14 12 13 13.5 C12 14.5 10.5 13.5 11 12 Z', BL),
  BRUSH_TEXMASK: brushTip('#333'),
});

export function iconSvg(name: string | undefined | null): string {
  if (!name || name === 'NONE') return '';
  const body = ICONS[name] ?? ICONS.DOT;
  return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

/** Create an icon element. */
export function icon(name: string | undefined | null, cls = ''): HTMLElement {
  const el = document.createElement('span');
  el.className = `icon ${cls}`.trim();
  el.innerHTML = iconSvg(name);
  if (name) el.dataset.icon = name;
  return el;
}

export function hasIcon(name: string): boolean {
  return name in ICONS;
}

/** Icon for an object type as shown in the outliner. */
export function objectIcon(type: string): string {
  switch (type) {
    case 'MESH': return 'OUTLINER_OB_MESH';
    case 'CAMERA': return 'OUTLINER_OB_CAMERA';
    case 'LAMP': return 'OUTLINER_OB_LAMP';
    case 'EMPTY': return 'OUTLINER_OB_EMPTY';
    case 'FONT': return 'OUTLINER_OB_FONT';
    case 'ARMATURE': return 'OUTLINER_OB_ARMATURE';
    case 'LATTICE': return 'OUTLINER_OB_LATTICE';
    case 'CURVE': return 'OUTLINER_OB_CURVE';
    case 'SURFACE': return 'OUTLINER_OB_SURFACE';
    case 'META': return 'OUTLINER_OB_META';
    default: return 'OBJECT_DATA';
  }
}

export function objectDataIcon(type: string): string {
  switch (type) {
    case 'MESH': return 'MESH_DATA';
    case 'CAMERA': return 'CAMERA_DATA';
    case 'LAMP': return 'LAMP_DATA';
    case 'EMPTY': return 'EMPTY_DATA';
    case 'FONT': return 'FONT_DATA';
    case 'ARMATURE': return 'ARMATURE_DATA';
    case 'LATTICE': return 'LATTICE_DATA';
    case 'CURVE': return 'CURVE_DATA';
    case 'SURFACE': return 'SURFACE_DATA';
    case 'META': return 'META_DATA';
    default: return 'DOT';
  }
}
