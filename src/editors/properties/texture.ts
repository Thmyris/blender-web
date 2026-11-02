// Texture context (properties_texture.py of Blender 2.79, Blender Internal) for the
// active material's texture slots.

import { app } from '../../app';
import { createTexture, defaultTextureSlot, renameData } from '../../core/scene';
import type { TextureData, TextureSlot } from '../../core/types';
import { pickFile } from '../../ui/dom';
import { bprop, cprop, eprop, fprop, iprop, type BoolProp, type EnumItem, type FloatProp, type Layout, type PanelDef } from '../../ui/layout';
import {
  activeMaterial, activeTexture, activeTextureSlot, cloneJSON, commitEdit, customPropsBody, flatPanel, NA, naBool, naButton,
  naEnum, naFloat, naString, richList, usersOf, type PropsCtx,
} from './common';
import { drawMaterialPreview, drawTexturePreview, materialPreviewKey, previewCanvas, texturePreviewKey } from './preview';

const MA = activeMaterial;
const T = activeTexture;
const S = activeTextureSlot;
const texType = () => T()?.type ?? 'NONE';
const isType = (...types: string[]) => () => types.includes(texType());

const TYPES: EnumItem[] = [
  { id: 'NONE', label: 'None' },
  { id: 'BLEND', label: 'Blend', description: 'Procedural - create a ramp texture' },
  { id: 'CLOUDS', label: 'Clouds', description: 'Procedural - create a cloud-like fractal noise texture' },
  { id: 'DISTORTED_NOISE', label: 'Distorted Noise', disabled: true, description: NA },
  { id: 'ENVIRONMENT_MAP', label: 'Environment Map', disabled: true, description: NA },
  { id: 'IMAGE', label: 'Image or Movie', description: 'Allow for images or movies to be used as textures' },
  { id: 'MAGIC', label: 'Magic', description: 'Procedural - color texture based on trigonometric functions' },
  { id: 'MARBLE', label: 'Marble', description: 'Procedural - marble-like noise texture with wave generated bands' },
  { id: 'MUSGRAVE', label: 'Musgrave', disabled: true, description: NA },
  { id: 'NOISE', label: 'Noise', description: 'Procedural - random noise, gives a different result every time, for every frame, for every pixel' },
  { id: 'OCEAN', label: 'Ocean', disabled: true, description: NA },
  { id: 'POINT_DENSITY', label: 'Point Density', disabled: true, description: NA },
  { id: 'STUCCI', label: 'Stucci', description: 'Procedural - create a fractal noise texture' },
  { id: 'VORONOI', label: 'Voronoi', description: 'Procedural - create cell-like patterns based on Worley noise' },
  { id: 'VOXEL_DATA', label: 'Voxel Data', disabled: true, description: NA },
  { id: 'WOOD', label: 'Wood', description: 'Procedural - wave generated bands or rings, with optional noise' },
];

const NOISE_BASIS: EnumItem[] = [
  { id: 'BLENDER_ORIGINAL', label: 'Blender Original' }, { id: 'ORIGINAL_PERLIN', label: 'Original Perlin' },
  { id: 'IMPROVED_PERLIN', label: 'Improved Perlin' },
  ...['Voronoi F1', 'Voronoi F2', 'Voronoi F3', 'Voronoi F4', 'Voronoi F2-F1', 'Voronoi Crackle', 'Cell Noise'].map((label) => ({ id: label, label, disabled: true, description: NA })),
];

// ------------------------------------------------------------------ helpers

function noiseType(l: Layout): void {
  l.row().prop(eprop(T, 'noiseType', [
    { id: 'SOFT_NOISE', label: 'Soft', description: 'Generate soft noise (smooth transitions)' },
    { id: 'HARD_NOISE', label: 'Hard', description: 'Generate hard noise (sharp transitions)' },
  ], { name: 'Type', description: 'Noise type' }), { expand: true });
}

function noiseBasis(l: Layout): void {
  l.prop(eprop(T, 'noiseBasis', NOISE_BASIS, { name: 'Basis', description: 'Noise basis used for turbulence' }));
}

const size = () => fprop(T, 'noiseScale', { name: 'Size', min: 0.0001, max: 2, step: 0.01, precision: 3, description: 'Scaling for noise input' });
const depth = () => iprop(T, 'noiseDepth', { name: 'Depth', min: 0, max: 30, softMax: 8, description: 'Depth of the cloud calculation' });
const turbulence = () => fprop(T, 'turbulence', { name: 'Turbulence', min: 0.0001, max: 200, step: 0.1, precision: 3, description: 'Turbulence of the bandnoise and ringnoise types' });

/** Blender's `factor_but`: a checkbox and a factor slider in one aligned row. */
function factorBut(l: Layout, toggle: BoolProp, factor: FloatProp, name: string, active: () => boolean): void {
  const row = l.row(true);
  row.prop(toggle, { text: '' }).classList.add('fixed');
  const sub = row.row(true);
  sub.el.style.opacity = '';
  row.root.widgets.push({ update: () => { sub.el.style.opacity = active() ? '' : '0.55'; } });
  sub.prop(factor, { slider: true, text: name });
}

function naFactor(l: Layout, name: string, value = 1): void {
  const row = l.row(true);
  row.prop(naBool(''), { text: '' }).classList.add('fixed');
  row.prop(naFloat(name, value), { slider: true });
}

async function openImage(id: string): Promise<void> {
  const file = await pickFile('image/*');
  if (!file) return;
  const url = await new Promise<string | null>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : null);
    r.onerror = () => resolve(null);
    r.readAsDataURL(file);
  });
  const t = app.doc.textures[id];
  if (!url || !t) { app.report('ERROR', `Cannot read image "${file.name}"`); return; }
  t.imageData = url;
  t.imageName = file.name;
  commitEdit('Open Image', 'data');
}

function moveSlot(dir: -1 | 1): void {
  const ma = MA();
  if (!ma) return;
  const i = ma.activeTextureIndex, j = i + dir;
  if (j < 0 || j >= ma.textureSlots.length) return;
  [ma.textureSlots[i], ma.textureSlots[j]] = [ma.textureSlots[j], ma.textureSlots[i]];
  ma.activeTextureIndex = j;
  commitEdit('Move Texture Slot', 'data');
}

// ------------------------------------------------------------------ panels

export function texturePanels(ctx: PropsCtx): PanelDef[] {
  const P: PanelDef[] = [];
  const hasTex = () => !!T();
  const hasSlotTex = () => !!T() && !!S();

  P.push({
    id: 'texture.context', label: '', noHeader: true, key: () => `${!!MA()}|${!!T()}`,
    draw: (l) => {
      flatPanel(l);
      l.row().prop({
        kind: 'enum', name: 'Texture Context', undo: false, description: 'Type of texture data to display and edit',
        items: [
          { id: 'MATERIAL', label: 'Material', icon: 'MATERIAL', description: 'Show material textures' },
          { id: 'WORLD', label: 'World', icon: 'WORLD', disabled: true, description: `World textures: ${NA}` },
          { id: 'OTHER', label: 'Other', icon: 'TEXTURE', disabled: true, description: `Other textures: ${NA}` },
        ],
        get: () => 'MATERIAL', set: () => {},
      }, { expand: true });
      const ma = MA();
      if (!ma) {
        l.label(app.activeObject?.type === 'MESH' ? 'The active material slot has no material' : 'Textures can only be used by materials in blender-web', { disabled: true });
        return;
      }
      richList(l, {
        rows: 5,
        items: () => (MA()?.textureSlots ?? []).map((s: TextureSlot | null) => {
          const t = s?.texture ? app.doc.textures[s.texture] : null;
          return {
            label: t?.name ?? '', icon: 'TEXTURE', dim: !t,
            check: t && s ? { get: () => s.use, set: (v: boolean) => { s.use = v; }, tip: 'Enable this texture slot' } : undefined,
          };
        }),
        active: () => MA()?.activeTextureIndex ?? 0,
        setActive: (i) => { const m = MA(); if (m) m.activeTextureIndex = i; },
        rename: (i, name) => { const id = MA()?.textureSlots[i]?.texture; if (id) renameData(app.doc, 'textures', id, name); },
        side: [
          { icon: 'TRIA_UP', tip: 'Move texture slot up', action: () => moveSlot(-1), disabled: () => (MA()?.activeTextureIndex ?? 0) <= 0 },
          { icon: 'TRIA_DOWN', tip: 'Move texture slot down', action: () => moveSlot(1), disabled: () => (MA()?.activeTextureIndex ?? 0) >= (MA()?.textureSlots.length ?? 1) - 1 },
          {
            icon: 'DOWNARROW_HLT', tip: 'Texture Specials', menu: () => [
              { label: 'Copy Texture Slot Settings', disabled: true, description: NA },
              { label: 'Paste Texture Slot Settings', disabled: true, description: NA },
            ],
          },
        ],
      });
      l.idTemplate({
        icon: 'TEXTURE', title: 'Texture',
        items: () => Object.values(app.doc.textures).map((t) => ({ id: t.id, name: t.name, icon: 'TEXTURE' })),
        get: () => S()?.texture ?? null,
        set: (id) => {
          const m = MA();
          if (!m || !id) return;
          const s = m.textureSlots[m.activeTextureIndex];
          if (s) s.texture = id;
          else m.textureSlots[m.activeTextureIndex] = defaultTextureSlot(id);
        },
        name: () => T()?.name ?? '',
        rename: (n) => { const t = T(); if (t) renameData(app.doc, 'textures', t.id, n); },
        users: () => usersOf('textures', T()?.id),
        fakeUser: { get: () => !!T()?.fakeUser, set: (v) => { const t = T(); if (t) t.fakeUser = v; } },
        onNew: () => {
          const m = MA();
          if (!m) return;
          // like texture.new: a copy of the current texture, or a new Clouds texture
          const cur = T();
          const t = createTexture(app.doc, cur?.name ?? 'Texture');
          if (cur) Object.assign(t, cloneJSON({ ...cur, id: t.id, name: t.name, fakeUser: false }));
          const s = m.textureSlots[m.activeTextureIndex];
          if (s) s.texture = t.id;
          else m.textureSlots[m.activeTextureIndex] = defaultTextureSlot(t.id);
        },
        unlink: () => { const m = MA(); if (m) m.textureSlots[m.activeTextureIndex] = null; },
      });
      if (T()) {
        const sp = l.split(0.2);
        sp.column().label('Type:');
        sp.column().prop(eprop(T, 'type', TYPES, { name: 'Type', description: '' }), { noLabel: true });
      }
    },
  });

  P.push({
    id: 'texture.preview', label: 'Preview', poll: hasTex, key: () => String(ctx.state.texPreview ?? 'TEXTURE'),
    draw: (l) => {
      const mode = () => String(ctx.state.texPreview ?? 'TEXTURE');
      previewCanvas(l, () => `${mode()}|${texturePreviewKey(T(), S())}|${mode() !== 'TEXTURE' ? materialPreviewKey(MA()) : ''}`, (c) => {
        const t = T(); const ma = MA();
        if (!t) return;
        const m = mode();
        if (m === 'MATERIAL' && ma) { drawMaterialPreview(c, ma); return; }
        if (m === 'BOTH' && ma) {
          const half = document.createElement('canvas');
          half.width = Math.max(1, Math.floor(c.width / 2));
          half.height = c.height;
          const g = c.getContext('2d')!;
          drawTexturePreview(half, t);
          g.drawImage(half, 0, 0);
          drawMaterialPreview(half, ma);
          g.drawImage(half, half.width, 0);
          return;
        }
        drawTexturePreview(c, t);
      });
      const row = l.row();
      row.prop({
        kind: 'enum', name: 'Preview', undo: false, notify: ['screen'], description: 'Show texture, material, or both in the preview',
        items: [{ id: 'TEXTURE', label: 'Texture' }, { id: 'MATERIAL', label: 'Material' }, { id: 'BOTH', label: 'Both' }],
        get: () => mode(), set: (v) => { ctx.state.texPreview = v; },
      }, { expand: true });
      row.prop(naBool('Show Alpha'));
    },
  });

  P.push({
    id: 'texture.clouds', label: 'Clouds', poll: isType('CLOUDS'),
    draw: (l) => {
      l.row().prop(naEnum('Cloud Type', ['Greyscale', 'Color'], 'Greyscale'), { expand: true });
      l.label('Noise:');
      noiseType(l);
      noiseBasis(l);
      const sp = l.split();
      const c = sp.column();
      c.prop(size());
      c.prop(depth());
      sp.column().prop(naFloat('Nabla', 0.025));
    },
  });

  P.push({
    id: 'texture.wood', label: 'Wood', poll: isType('WOOD'),
    draw: (l) => {
      l.row().prop(naEnum('Noise Basis 2', ['Sin', 'Saw', 'Tri'], 'Sin'), { expand: true });
      l.row().prop(eprop(T, 'woodType', [
        { id: 'BANDS', label: 'Bands', description: 'Use standard wood texture in bands' },
        { id: 'RINGS', label: 'Rings', description: 'Use wood texture in rings' },
        { id: 'BANDNOISE', label: 'Band Noise', description: 'Add noise to standard wood' },
        { id: 'RINGNOISE', label: 'Ring Noise', description: 'Add noise to rings' },
      ], { name: 'Pattern', description: '' }), { expand: true });
      const noisy = () => T()?.woodType === 'BANDNOISE' || T()?.woodType === 'RINGNOISE';
      const col = l.column();
      col.root.widgets.push({ update: () => { col.el.style.opacity = noisy() ? '' : '0.55'; } });
      col.label('Noise:');
      noiseType(col);
      noiseBasis(l);
      const sp = l.split();
      sp.root.widgets.push({ update: () => { sp.el.style.opacity = noisy() ? '' : '0.55'; } });
      const c = sp.column();
      c.prop(size());
      c.prop(turbulence());
      sp.column().prop(naFloat('Nabla', 0.025));
    },
  });

  P.push({
    id: 'texture.marble', label: 'Marble', poll: isType('MARBLE'),
    draw: (l) => {
      l.row().prop(naEnum('Marble Type', ['Soft', 'Sharp', 'Sharper'], 'Soft'), { expand: true });
      l.row().prop(naEnum('Noise Basis 2', ['Sin', 'Saw', 'Tri'], 'Sin'), { expand: true });
      l.label('Noise:');
      noiseType(l);
      noiseBasis(l);
      const sp = l.split();
      const c1 = sp.column();
      c1.prop(size());
      c1.prop(depth());
      const c2 = sp.column();
      c2.prop(turbulence());
      c2.prop(naFloat('Nabla', 0.025));
    },
  });

  P.push({
    id: 'texture.magic', label: 'Magic', poll: isType('MAGIC'),
    draw: (l) => {
      const row = l.row();
      row.prop(depth());
      row.prop(turbulence());
    },
  });

  P.push({
    id: 'texture.blend', label: 'Blend', poll: isType('BLEND'),
    draw: (l) => {
      l.prop(eprop(T, 'progression', [
        { id: 'LINEAR', label: 'Linear', description: 'Create a linear progression' },
        { id: 'QUADRATIC', label: 'Quadratic', description: 'Create a quadratic progression' },
        { id: 'EASING', label: 'Easing', description: 'Create a progression easing from one step to the next' },
        { id: 'DIAGONAL', label: 'Diagonal', description: 'Create a diagonal progression' },
        { id: 'SPHERICAL', label: 'Spherical', description: 'Create a spherical progression' },
        { id: 'QUADRATIC_SPHERE', label: 'Quadratic sphere', description: 'Create a quadratic progression in the shape of a sphere' },
        { id: 'RADIAL', label: 'Radial', description: 'Create a radial progression' },
      ], { name: 'Progression', description: 'Style of the color blending' }));
      l.row().prop(naEnum('Flip Axis', ['Horizontal', 'Vertical'], 'Horizontal'), { expand: true });
    },
  });

  P.push({
    id: 'texture.stucci', label: 'Stucci', poll: isType('STUCCI'),
    draw: (l) => {
      l.row().prop(naEnum('Pattern', ['Plastic', 'Wall In', 'Wall Out'], 'Plastic'), { expand: true });
      l.label('Noise:');
      noiseType(l);
      noiseBasis(l);
      const row = l.row();
      row.prop(size());
      row.prop(turbulence());
    },
  });

  P.push({
    id: 'texture.voronoi', label: 'Voronoi', poll: isType('VORONOI'),
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      c1.label('Distance Metric:', { disabled: true });
      c1.prop(naEnum('Distance Metric', ['Actual Distance', 'Distance Squared', 'Manhattan', 'Chebychev', 'Minkowski 1/2', 'Minkowski 4', 'Minkowski'], 'Actual Distance'), { noLabel: true });
      c1.prop(naFloat('Exponent', 2.5));
      c1.label('Coloring:', { disabled: true });
      c1.prop(naEnum('Coloring', ['Intensity', 'Position', 'Position and Outline', 'Position, Outline, and Intensity']), { noLabel: true });
      c1.prop(naFloat('Intensity', 1));
      const c2 = sp.column(true);
      c2.label('Feature Weights:', { disabled: true });
      c2.prop(naFloat('1', 1), { slider: true });
      c2.prop(naFloat('2', 0), { slider: true });
      c2.prop(naFloat('3', 0), { slider: true });
      c2.prop(naFloat('4', 0), { slider: true });
      l.label('Noise:');
      const row = l.row();
      row.prop(size());
      row.prop(naFloat('Nabla', 0.025));
    },
  });

  P.push({
    id: 'texture.image', label: 'Image', poll: isType('IMAGE'), key: () => String(!!T()?.imageData),
    draw: (l) => {
      const t = T();
      const id = t?.id ?? '';
      const row = l.row(true);
      row.prop(naEnum('Image', [{ id: '', label: '', icon: 'IMAGE_DATA' }]), { iconOnly: true }).classList.add('fixed');
      if (t?.imageData) {
        row.prop({ kind: 'string', name: '', description: 'Image name', undo: 'Rename Image', get: () => T()?.imageName ?? '', set: (v) => { const x = T(); if (x) x.imageName = v; } });
        row.button('', () => {
          const x = app.doc.textures[id];
          if (!x) return;
          x.imageData = null;
          x.imageName = '';
          commitEdit('Unlink Image', 'data');
        }, { icon: 'X', iconOnly: true, tip: 'Unlink the image from this texture' });
        l.prop(naEnum('Source', ['Single Image', 'Image Sequence', 'Movie', 'Generated'], 'Single Image'));
        const fr = l.row(true);
        fr.prop(naString('', T()?.imageName ?? ''));
        fr.button('', () => void openImage(id), { icon: 'FILE_FOLDER', iconOnly: true, tip: 'Open an image file to replace this one' });
        l.dynLabel(() => imageInfo(T()));
      } else {
        naButton(row, 'New', 'ZOOMIN');
        row.button('Open', () => void openImage(id), { icon: 'FILE_FOLDER', tip: 'Open image' });
      }
    },
  });

  P.push({
    id: 'texture.image_sampling', label: 'Image Sampling', poll: isType('IMAGE'), defaultClosed: true,
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      c1.label('Alpha:', { disabled: true });
      c1.prop(naBool('Use', true));
      c1.prop(naBool('Calculate'));
      c1.prop(naBool('Flip X/Y Axis'));
      const c2 = sp.column();
      c2.prop(naBool('Interpolation', true));
      c2.prop(naBool('MIP Map', true));
      c2.prop(naEnum('Filter', ['Box', 'EWA', 'FELINE', 'Area'], 'EWA'), { noLabel: true });
    },
  });

  P.push({
    id: 'texture.image_mapping', label: 'Image Mapping', poll: isType('IMAGE'), key: () => T()?.extension ?? '',
    draw: (l) => {
      l.prop(eprop(T, 'extension', [
        { id: 'EXTEND', label: 'Extend', description: 'Extend by repeating edge pixels of the image' },
        { id: 'CLIP', label: 'Clip', description: 'Clip to image size and set exterior pixels as transparent' },
        { id: 'CLIP_CUBE', label: 'Clip Cube', disabled: true, description: NA },
        { id: 'REPEAT', label: 'Repeat', description: 'Cause the image to repeat horizontally and vertically' },
        { id: 'CHECKER', label: 'Checker', disabled: true, description: NA },
      ], { name: 'Extension', description: 'How the image is extrapolated past its original bounds' }));
      if (T()?.extension === 'REPEAT') {
        const sp = l.split();
        const c1 = sp.column(true);
        c1.label('Repeat:');
        c1.prop(iprop(T, 'repeatX', { name: 'X', min: 1, max: 512, description: 'Repetition multiplier in the X direction' }));
        c1.prop(iprop(T, 'repeatY', { name: 'Y', min: 1, max: 512, description: 'Repetition multiplier in the Y direction' }));
        const c2 = sp.column(true);
        c2.label('Mirror:', { disabled: true });
        c2.prop(naBool('X'), { toggle: true });
        c2.prop(naBool('Y'), { toggle: true });
        l.separator();
      }
      const sp = l.split();
      const a = sp.column(true);
      a.label('Crop Minimum:', { disabled: true });
      a.prop(naFloat('X', 0));
      a.prop(naFloat('Y', 0));
      const b = sp.column(true);
      b.label('Crop Maximum:', { disabled: true });
      b.prop(naFloat('X', 1));
      b.prop(naFloat('Y', 1));
    },
  });

  P.push({
    id: 'texture.colors', label: 'Colors', poll: () => texType() !== 'NONE' && hasTex(), defaultClosed: true,
    draw: (l) => {
      l.prop(naBool('Ramp'));
      const sp = l.split();
      const c1 = sp.column();
      c1.label('RGB Multiply:');
      const s = c1.column(true);
      for (let i = 0; i < 3; i++) {
        s.prop({
          kind: 'float', name: ['R', 'G', 'B'][i], min: 0, max: 2, step: 0.01, precision: 3, description: 'Texture RGB color multiplier',
          get: () => T()?.colorTint?.[i] ?? 1,
          set: (v) => { const t = T(); if (t) { t.colorTint = (t.colorTint ?? [1, 1, 1]).slice() as TextureData['colorTint']; t.colorTint[i] = v; } },
        });
      }
      const c2 = sp.column();
      c2.label('Adjust:');
      c2.prop(fprop(T, 'intensity', { name: 'Brightness', min: 0, max: 2, step: 0.01, precision: 3, description: 'Adjust the brightness of the texture' }));
      c2.prop(fprop(T, 'contrast', { name: 'Contrast', min: 0, max: 5, step: 0.01, precision: 3, description: 'Adjust the contrast of the texture' }));
      c2.prop(fprop(T, 'saturation', { name: 'Saturation', min: 0, max: 2, step: 0.01, precision: 3, description: 'Adjust the saturation of colors in the texture (stored; not applied by blender-web)' }));
      l.prop(naBool('Clamp', true));
    },
  });

  P.push({
    id: 'texture.mapping', label: 'Mapping', poll: hasSlotTex,
    draw: (l) => {
      const sp = l.split(0.3);
      sp.column().label('Coordinates:');
      sp.column().prop({
        kind: 'enum', name: 'Coordinates', description: 'Texture coordinates used to map the texture onto the input',
        items: [
          { id: 'GLOBAL', label: 'Global', disabled: true, description: NA },
          { id: 'OBJECT', label: 'Object', disabled: true, description: NA },
          { id: 'UV', label: 'UV', disabled: true, description: NA },
          { id: 'GENERATED', label: 'Generated', description: 'Use the original undeformed coordinates of the object' },
          { id: 'STRAND', label: 'Strand / Particle', disabled: true, description: NA },
          { id: 'WINDOW', label: 'Window', disabled: true, description: NA },
          { id: 'NORMAL', label: 'Normal', disabled: true, description: NA },
          { id: 'REFLECTION', label: 'Reflection', disabled: true, description: NA },
          { id: 'STRESS', label: 'Stress', disabled: true, description: NA },
          { id: 'TANGENT', label: 'Tangent', disabled: true, description: NA },
        ],
        // ORCO and GENERATED are the same thing ("Generated" in Blender's UI)
        get: () => { const c = S()?.textureCoords ?? 'GENERATED'; return c === 'ORCO' ? 'GENERATED' : c; },
        set: (v) => { const s = S(); if (s) s.textureCoords = v as TextureSlot['textureCoords']; },
      }, { noLabel: true });
      const sp2 = l.split(0.3);
      sp2.column().label('Projection:');
      sp2.column().prop(eprop(S, 'mapping', [
        { id: 'FLAT', label: 'Flat', description: 'Map X and Y coordinates directly' },
        { id: 'CUBE', label: 'Cube', description: 'Map using the normal vector' },
        { id: 'TUBE', label: 'Tube', description: 'Map with Z as central axis' },
        { id: 'SPHERE', label: 'Sphere', description: 'Map with Z as central axis' },
      ], { name: 'Projection', description: '' }), { noLabel: true });
      const sp3 = l.split();
      sp3.column().prop(naBool('From Dupli'));
      const r = sp3.column().row();
      for (const ax of ['X', 'Y', 'Z']) r.prop(naEnum(`Mapping ${ax}`, ['None', 'X', 'Y', 'Z'], ax), { noLabel: true });
      const row = l.row();
      row.el.style.alignItems = 'flex-start';
      for (const [key, label] of [['offset', 'Offset'], ['scale', 'Size']] as const) {
        const col = row.column(true);
        col.label(`${label}:`);
        for (let i = 0; i < 3; i++) {
          col.prop({
            kind: 'float', name: ['X', 'Y', 'Z'][i], step: 0.1, precision: 3, unit: key === 'offset' ? 'LENGTH' : 'NONE',
            description: key === 'offset' ? 'Fine tune of the texture mapping X, Y and Z locations' : 'Set scaling for the texture\'s X, Y and Z sizes',
            get: () => S()?.[key]?.[i] ?? (key === 'scale' ? 1 : 0),
            set: (v) => { const s = S(); if (s) s[key][i] = v; },
          });
        }
      }
    },
  });

  P.push({
    id: 'texture.influence', label: 'Influence', poll: hasSlotTex,
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      c1.label('Diffuse:');
      naFactor(c1, 'Intensity');
      factorBut(c1, bprop(S, 'useMapColorDiffuse', { name: 'Diffuse Color', description: 'The texture affects basic color of the material' }),
        fprop(S, 'diffuseColorFactor', { name: 'Color', min: 0, max: 1, step: 0.1, precision: 3, description: 'Amount texture affects diffuse color' }), 'Color', () => !!S()?.useMapColorDiffuse);
      factorBut(c1, bprop(S, 'useMapAlpha', { name: 'Alpha', description: 'The texture affects the alpha value' }),
        fprop(S, 'alphaFactor', { name: 'Alpha', min: -1, max: 1, step: 0.1, precision: 3, description: 'Amount texture affects alpha' }), 'Alpha', () => !!S()?.useMapAlpha);
      naFactor(c1, 'Translucency');
      c1.label('Specular:', { disabled: true });
      naFactor(c1, 'Intensity');
      naFactor(c1, 'Color');
      naFactor(c1, 'Hardness');
      const c2 = sp.column();
      c2.label('Shading:', { disabled: true });
      naFactor(c2, 'Ambient');
      naFactor(c2, 'Emit');
      naFactor(c2, 'Mirror');
      naFactor(c2, 'Ray Mirror');
      c2.label('Geometry:', { disabled: true });
      naFactor(c2, 'Normal');
      naFactor(c2, 'Warp', 0);
      naFactor(c2, 'Displace', 0.2);
      l.separator();
      const sp2 = l.split();
      const a = sp2.column();
      a.prop(eprop(S, 'blendType', [
        { id: 'MIX', label: 'Mix' }, { id: 'ADD', label: 'Add' }, { id: 'SUBTRACT', label: 'Subtract' }, { id: 'MULTIPLY', label: 'Multiply' }, { id: 'SCREEN', label: 'Screen' },
        ...['Overlay', 'Difference', 'Divide', 'Darken', 'Lighten', 'Hue', 'Saturation', 'Value', 'Color', 'Soft Light', 'Linear Light'].map((label) => ({ id: label, label, disabled: true, description: NA })),
      ], { name: 'Blend', description: 'Mode used to apply the texture' }));
      a.prop(bprop(S, 'useRgbToIntensity', { name: 'RGB to Intensity', description: 'Convert texture RGB values to intensity (gray) values' }));
      a.prop(cprop(S, 'color', { name: 'Color', description: 'Default color for textures that don\'t return RGB or when RGB to intensity is enabled' }), { text: '' });
      const b = sp2.column();
      b.prop(naBool('Negative'));
      b.prop(naBool('Stencil'));
      b.prop(naFloat('DVar', 1), { slider: true });
    },
  });

  P.push({ id: 'texture.custom_props', label: 'Custom Properties', poll: hasTex, defaultClosed: true, draw: customPropsBody });
  return P;
}

function imageInfo(t: TextureData | null): string {
  if (!t?.imageData) return '';
  const kb = Math.round((t.imageData.length * 3) / 4 / 1024);
  return `Image: ${t.imageName || 'untitled'}, ~${kb} KB`;
}
