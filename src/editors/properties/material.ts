// Material context (properties_material.py of Blender 2.79, Blender Internal).

import { app } from '../../app';
import { renameData } from '../../core/scene';
import type { MaterialData } from '../../core/types';
import { bprop, cprop, eprop, fprop, iprop, type EnumItem, type PanelDef } from '../../ui/layout';
import {
  activeMaterial, activeSlotIndex, activeWhen, callOp, customPropsBody, flatPanel, meshData, NA, naBool, naEnum, naFloat,
  naInt, naString, ob, richList, usersOf, type PropsCtx,
} from './common';
import { drawMaterialPreview, materialPreviewKey, previewCanvas } from './preview';

const MA = activeMaterial;
const hasMat = () => !!activeMaterial();
const shadeless = () => !!activeMaterial()?.useShadeless;
const geom = () => app.tagGeometry(meshData()?.id);

const PREVIEW_TYPES: EnumItem[] = [
  { id: 'FLAT', label: 'Flat', icon: 'MESH_PLANE', description: 'Flat XY plane' },
  { id: 'SPHERE', label: 'Sphere', icon: 'MESH_UVSPHERE', description: 'Sphere' },
  { id: 'CUBE', label: 'Cube', icon: 'MESH_CUBE', description: 'Cube' },
  { id: 'MONKEY', label: 'Monkey', icon: 'MONKEY', description: `Monkey: ${NA}`, disabled: true },
  { id: 'HAIR', label: 'Hair', icon: 'PARTICLES', description: `Hair strands: ${NA}`, disabled: true },
  { id: 'SPHERE_A', label: 'World Sphere', icon: 'WORLD', description: 'Large sphere with sky' },
];

/** `template_preview`: the image plus a column of preview-type buttons on the right. */
export function materialPreview(l: import('../../ui/layout').Layout, get: () => MaterialData | null): void {
  const row = l.row();
  row.el.style.alignItems = 'flex-start';
  previewCanvas(row, () => materialPreviewKey(get()), (c) => { const ma = get(); if (ma) drawMaterialPreview(c, ma); });
  const col = row.column(true);
  col.el.style.flex = '0 0 24px';
  for (const it of PREVIEW_TYPES) {
    col.prop(eprop(get, 'previewType', [it], { name: 'Preview Render Type', description: 'Type of preview render', undo: false }), { expand: true, iconOnly: true });
  }
}

export function materialPanels(ctx: PropsCtx): PanelDef[] {
  const P: PanelDef[] = [];

  P.push({
    id: 'material.context', label: '', noHeader: true,
    key: () => `${meshData()?.materials.length ?? 0}|${app.mode}`,
    draw: (l) => {
      flatPanel(l);
      const n = meshData()?.materials.length ?? 0;
      const sortable = n > 1;
      richList(l, {
        rows: sortable ? 4 : 1,
        items: () => (meshData()?.materials ?? []).map((id) => {
          const m = id ? app.doc.materials[id] : null;
          return { label: m?.name ?? '', icon: 'MATERIAL', dim: !m };
        }),
        active: () => activeSlotIndex(),
        setActive: (i) => { const o = ob(); if (o) o.activeMaterialIndex = i; },
        rename: (i, name) => { const id = meshData()?.materials[i]; if (id) renameData(app.doc, 'materials', id, name); },
        side: [
          { icon: 'ZOOMIN', tip: 'Add Material Slot', action: () => callOp(ctx, 'object.material_slot_add'), disabled: () => !app.pollOperator('object.material_slot_add', ctx.area) },
          { icon: 'ZOOMOUT', tip: 'Remove Material Slot', action: () => callOp(ctx, 'object.material_slot_remove'), disabled: () => !app.pollOperator('object.material_slot_remove', ctx.area) },
          {
            icon: 'DOWNARROW_HLT', tip: 'Material Specials', menu: () => [
              { label: 'Copy Material', disabled: true, description: NA },
              { label: 'Paste Material', disabled: true, description: NA },
              { label: 'Copy Material to Others', disabled: true, description: NA },
            ],
          },
          ...(sortable ? [
            { icon: 'TRIA_UP', tip: 'Move the active material up (not available in blender-web)', disabled: () => true, gap: true },
            { icon: 'TRIA_DOWN', tip: 'Move the active material down (not available in blender-web)', disabled: () => true },
          ] : []),
        ],
      });
      if (app.mode === 'EDIT') {
        const r = l.row(true);
        r.operator('object.material_slot_assign', { text: 'Assign' });
        r.operator('object.material_slot_select', { text: 'Select' });
        r.operator('object.material_slot_deselect', { text: 'Deselect' });
      }
      const sp = l.split(0.65);
      sp.column().idTemplate({
        icon: 'MATERIAL', title: 'Material',
        items: () => Object.values(app.doc.materials).map((m) => ({ id: m.id, name: m.name, icon: 'MATERIAL' })),
        get: () => MA()?.id ?? null,
        set: (id) => {
          const o = ob(); const md = meshData();
          if (!o || !md || !id) return;
          if (!md.materials.length) { md.materials.push(id); o.activeMaterialIndex = 0; }
          else md.materials[activeSlotIndex()] = id;
          geom();
        },
        name: () => MA()?.name ?? '',
        rename: (name) => { const m = MA(); if (m) renameData(app.doc, 'materials', m.id, name); },
        users: () => usersOf('materials', MA()?.id),
        fakeUser: { get: () => !!MA()?.fakeUser, set: (v) => { const m = MA(); if (m) m.fakeUser = v; } },
        newLabel: 'New',
        onNew: () => callOp(ctx, 'material.new'),
        unlink: () => { const md = meshData(); const i = activeSlotIndex(); if (md && i >= 0) { md.materials[i] = null; geom(); } },
      });
      const lr = sp.column();
      if (n) lr.prop(naEnum('Link', [{ id: 'DATA', label: 'Data' }, { id: 'OBJECT', label: 'Object' }], 'DATA'), { noLabel: true });
      if (MA()) {
        l.row().prop(eprop(MA, 'type', [
          { id: 'SURFACE', label: 'Surface', description: 'Render object as a surface' },
          { id: 'WIRE', label: 'Wire', description: 'Render the edges of faces as wires (not supported in ray tracing)' },
          { id: 'VOLUME', label: 'Volume', disabled: true, description: NA },
          { id: 'HALO', label: 'Halo', disabled: true, description: NA },
        ], { name: 'Type', description: 'Material type defining how the object is rendered', notify: ['data'] }), { expand: true });
      }
    },
  });

  P.push({ id: 'material.preview', label: 'Preview', poll: hasMat, draw: (l) => materialPreview(l, MA) });

  P.push({
    id: 'material.diffuse', label: 'Diffuse', poll: hasMat, key: () => MA()?.diffuseShader ?? '',
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      c1.prop(cprop(MA, 'diffuseColor', { name: 'Diffuse Color', description: 'Diffuse color of the material', notify: ['data'] }), { text: '' });
      const s = c1.column();
      activeWhen(s, () => !shadeless());
      s.prop(fprop(MA, 'diffuseIntensity', { name: 'Intensity', min: 0, max: 1, precision: 3, step: 0.1, description: 'Amount of diffuse reflection', notify: ['data'] }), { slider: true });
      const c2 = sp.column();
      activeWhen(c2, () => !shadeless());
      c2.prop(eprop(MA, 'diffuseShader', [
        { id: 'LAMBERT', label: 'Lambert', description: 'Use a Lambertian shader' },
        { id: 'OREN_NAYAR', label: 'Oren-Nayar', description: 'Use an Oren-Nayar shader' },
        { id: 'TOON', label: 'Toon', description: 'Use a toon shader' },
        { id: 'MINNAERT', label: 'Minnaert', description: 'Use a Minnaert shader' },
        { id: 'FRESNEL', label: 'Fresnel', description: 'Use a Fresnel shader' },
      ], { name: 'Diffuse Shader Model', description: 'Diffuse shader model (stored; the viewport always shades Lambert-like)' }), { noLabel: true });
      c2.prop(naBool('Ramp'));
      const col = l.column();
      activeWhen(col, () => !shadeless());
      switch (MA()?.diffuseShader) {
        case 'OREN_NAYAR': col.prop(naFloat('Roughness', 0.5)); break;
        case 'MINNAERT': col.prop(naFloat('Darkness', 1)); break;
        case 'TOON': { const r = col.row(); r.prop(naFloat('Size', 0.5)); r.prop(naFloat('Smooth', 0.1)); break; }
        case 'FRESNEL': { const r = col.row(); r.prop(naFloat('Fresnel', 0.1)); r.prop(naFloat('Factor', 0.5)); break; }
      }
    },
  });

  P.push({
    id: 'material.specular', label: 'Specular', poll: hasMat, key: () => MA()?.specularShader ?? '',
    draw: (l) => {
      activeWhen(l, () => !shadeless());
      const sp = l.split();
      const c1 = sp.column();
      c1.prop(cprop(MA, 'specularColor', { name: 'Specular Color', description: 'Specular color of the material', notify: ['data'] }), { text: '' });
      c1.prop(fprop(MA, 'specularIntensity', { name: 'Intensity', min: 0, max: 1, precision: 3, step: 0.1, description: 'How intense (bright) the specular reflection is', notify: ['data'] }), { slider: true });
      const c2 = sp.column();
      c2.prop(eprop(MA, 'specularShader', [
        { id: 'COOKTORR', label: 'CookTorr', description: 'Use a Cook-Torrance shader' },
        { id: 'PHONG', label: 'Phong', description: 'Use a Phong shader' },
        { id: 'BLINN', label: 'Blinn', description: 'Use a Blinn shader' },
        { id: 'TOON', label: 'Toon', description: 'Use a toon shader' },
        { id: 'WARDISO', label: 'WardIso', description: 'Use a Ward anisotropic shader' },
      ], { name: 'Specular Shader Model', description: 'Specular shader model (stored; the viewport always shades Phong-like)' }), { noLabel: true });
      c2.prop(naBool('Ramp'));
      const col = l.column();
      const hard = () => iprop(MA, 'specularHardness', { name: 'Hardness', min: 1, max: 511, description: 'How hard (sharp) the specular reflection is', notify: ['data'] });
      switch (MA()?.specularShader) {
        case 'BLINN': { const r = col.row(); r.prop(hard()); r.prop(naFloat('IOR', 4)); break; }
        case 'WARDISO': col.prop(naFloat('Slope', 0.1)); break;
        case 'TOON': { const r = col.row(); r.prop(naFloat('Size', 0.5)); r.prop(naFloat('Smooth', 0.1)); break; }
        default: col.prop(hard());
      }
    },
  });

  P.push({
    id: 'material.shading', label: 'Shading', poll: hasMat,
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      const s = c1.column();
      activeWhen(s, () => !shadeless());
      s.prop(fprop(MA, 'emit', { name: 'Emit', min: 0, max: 100, softMax: 2, precision: 2, step: 0.1, description: 'Amount of light to emit', notify: ['data'] }));
      s.prop(fprop(MA, 'ambient', { name: 'Ambient', min: 0, max: 1, precision: 3, step: 0.1, description: 'Amount of global ambient color the material receives' }), { slider: true });
      c1.prop(fprop(MA, 'translucency', { name: 'Translucency', min: 0, max: 1, precision: 3, step: 0.1, description: 'Amount of diffuse shading on the back side' }), { slider: true });
      const c2 = sp.column();
      c2.prop(bprop(MA, 'useShadeless', { name: 'Shadeless', description: 'Make this material insensitive to light or shadow', notify: ['data'] }));
      const s2 = c2.column();
      activeWhen(s2, () => !shadeless());
      s2.prop(naBool('Tangent Shading'));
      s2.prop(naBool('Cubic Interpolation'));
    },
  });

  P.push({
    id: 'material.transp', label: 'Transparency', poll: hasMat, key: () => MA()?.transparencyMethod ?? '',
    drawHeader: (hl) => { hl.prop(bprop(MA, 'useTransparency', { name: '', description: 'Render material as transparent', notify: ['data'] }), { text: '' }); },
    draw: (l) => {
      const useT = () => !!MA()?.useTransparency;
      const row = l.row();
      activeWhen(row, useT);
      row.prop(eprop(MA, 'transparencyMethod', [
        { id: 'MASK', label: 'Mask', description: 'Mask the background' },
        { id: 'Z_TRANSPARENCY', label: 'Z Transparency', description: 'Use alpha buffer for transparent faces' },
        { id: 'RAYTRACE', label: 'Raytrace', description: 'Use raytracing for transparent refraction rendering' },
      ], { name: 'Transparency Method', description: 'Method to use for rendering transparency', notify: ['data'] }), { expand: true });
      const sp = l.split();
      activeWhen(sp, useT);
      const c1 = sp.column();
      c1.prop(fprop(MA, 'alpha', { name: 'Alpha', min: 0, max: 1, precision: 3, step: 0.1, description: 'Alpha transparency of the material', notify: ['data'] }), { slider: true });
      const r = c1.row();
      activeWhen(r, () => MA()?.transparencyMethod !== 'MASK' && !shadeless());
      r.prop(fprop(MA, 'specularAlpha', { name: 'Specular', min: 0, max: 1, precision: 3, step: 0.1, description: 'Alpha transparency for specular areas' }), { slider: true });
      const c2 = sp.column();
      c2.prop(naFloat('Fresnel', 0));
      c2.prop(naFloat('Blend', 1.25));
      if (MA()?.transparencyMethod === 'RAYTRACE') {
        l.separator();
        const sp2 = l.split();
        const a = sp2.column();
        a.prop(naFloat('IOR', 1));
        a.prop(naFloat('Filter', 0));
        a.prop(naFloat('Falloff', 1));
        a.prop(naFloat('Limit', 0));
        a.prop(naInt('Depth', 2));
        const b = sp2.column();
        b.label('Gloss:', { disabled: true });
        b.prop(naFloat('Amount', 1));
        b.prop(naFloat('Threshold', 0.005));
        b.prop(naInt('Samples', 18));
      }
    },
  });

  P.push({
    id: 'material.mirror', label: 'Mirror', poll: hasMat, defaultClosed: true,
    drawHeader: (hl) => { hl.prop(bprop(MA, 'useMirror', { name: '', description: 'Enable raytraced reflections' }), { text: '' }); },
    draw: (l) => {
      activeWhen(l, () => !!MA()?.useMirror);
      const sp = l.split();
      const c1 = sp.column();
      c1.prop(fprop(MA, 'rayMirror', { name: 'Reflectivity', min: 0, max: 1, precision: 3, step: 0.1, description: 'Amount of mirror reflection for raytrace' }), { slider: true });
      c1.prop({ kind: 'color', name: 'Mirror Color', get: () => [1, 1, 1], set: () => {}, disabled: () => true, undo: false, description: NA }, { text: '' });
      const c2 = sp.column();
      c2.prop(naFloat('Fresnel', 0));
      c2.prop(naFloat('Blend', 1.25));
      const sp2 = l.split();
      const a = sp2.column();
      a.separator();
      a.prop(naInt('Depth', 2));
      a.prop(naFloat('Max Dist', 0));
      const fr = a.split(0.4);
      fr.column().label('Fade To:', { disabled: true });
      fr.column().prop(naEnum('Fade To', ['Sky', 'Material']), { noLabel: true });
      const b = sp2.column();
      b.label('Gloss:', { disabled: true });
      b.prop(naFloat('Amount', 1));
      b.prop(naFloat('Threshold', 0.005));
      b.prop(naInt('Samples', 18));
      b.prop(naFloat('Anisotropic', 0));
    },
  });

  P.push({
    id: 'material.sss', label: 'Subsurface Scattering', poll: hasMat, defaultClosed: true,
    drawHeader: (hl) => { hl.prop(naBool(''), { text: '' }); },
    draw: (l) => {
      const row = l.row(true);
      row.prop(naEnum('Presets', ['Skin 1', 'Skin 2', 'Marble', 'Ketchup', 'Apple', 'Chicken', 'Cream', 'Potato', 'Skim Milk', 'Whole Milk'], 'Skin 1'), { noLabel: true });
      const sp = l.split();
      const c1 = sp.column();
      c1.prop(naFloat('IOR', 1.3));
      c1.prop(naFloat('Scale', 0.1));
      c1.prop({ kind: 'color', name: 'Color', get: () => [1, 1, 1], set: () => {}, disabled: () => true, undo: false }, { text: '' });
      c1.prop(naFloat('Color', 1));
      const c2 = sp.column();
      c2.label('RGB Radius:', { disabled: true });
      const r = c2.column(true);
      r.prop(naFloat('', 1));
      r.prop(naFloat('', 1));
      r.prop(naFloat('', 1));
    },
  });

  P.push({
    id: 'material.strand', label: 'Strand', poll: hasMat, defaultClosed: true,
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      const sub = c1.column(true);
      sub.label('Size:', { disabled: true });
      sub.prop(naFloat('Root', 1));
      sub.prop(naFloat('Tip', 1));
      sub.prop(naFloat('Minimum', 1));
      c1.prop(naBool('Blender Units'));
      c1.prop(naBool('Tangent Shading', true));
      const c2 = sp.column();
      c2.label('Shading:', { disabled: true });
      c2.prop(naFloat('Shape', 0));
      c2.prop(naFloat('Width Fade', 0));
      c2.prop(naString('UV Map'));
      c2.prop(naFloat('Surface Diffuse', 0));
    },
  });

  P.push({
    id: 'material.options', label: 'Options', poll: hasMat,
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      c1.prop(naBool('Traceable', true));
      c1.prop(naBool('Full Oversampling'));
      c1.prop(naBool('Sky'));
      c1.prop(naBool('Use Mist', true));
      c1.prop(naBool('Invert Z Depth'));
      c1.prop(naFloat('Z Offset', 0));
      const lg = c1.column(true);
      lg.label('Light Group:', { disabled: true });
      lg.prop(naString(''));
      const lr = lg.row(true);
      lr.prop(naBool('Exclusive'), { toggle: true });
      lr.prop(naBool('Local'), { toggle: true });
      const c2 = sp.column();
      c2.prop(naBool('Face Textures'));
      c2.prop(naBool('Face Textures Alpha'));
      c2.separator();
      c2.prop(naBool('Vertex Color Paint'));
      c2.prop(naBool('Vertex Color Light'));
      c2.prop(naBool('Object Color'));
      c2.prop(naBool('UV Project'));
    },
  });

  P.push({
    id: 'material.shadow', label: 'Shadow', poll: hasMat,
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      c1.prop(bprop(MA, 'receiveShadows', { name: 'Receive', description: 'Allow this material to receive shadows', notify: ['data'] }));
      c1.prop(naBool('Receive Transparent'));
      c1.prop(naBool('Shadows Only'));
      c1.prop(naEnum('Shadow Type', ['Shadow and Distance', 'Shadow Only', 'Shadow and Shading'], 'Shadow and Distance'), { noLabel: true });
      const c2 = sp.column();
      c2.prop(bprop(MA, 'castShadows', { name: 'Cast', description: 'Allow this material to cast shadows', notify: ['data'] }));
      c2.prop(naBool('Cast Only'));
      c2.prop(naBool('Cast Approximate', true));
      c2.prop(naBool('Cast Buffer Shadows', true));
      c2.prop(naFloat('Buffer Bias', 0));
      c2.prop(naBool('Auto Ray Bias', true));
      c2.prop(naFloat('Ray Bias', 0));
    },
  });

  P.push({ id: 'material.custom_props', label: 'Custom Properties', poll: hasMat, defaultClosed: true, draw: customPropsBody });
  return P;
}
