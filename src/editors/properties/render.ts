// Render context (properties_render.py of Blender 2.79, Blender Internal engine).

import { app } from '../../app';
import { bprop, eprop, fprop, iprop, sprop, type EnumItem, type Layout, type PanelDef } from '../../ui/layout';
import {
  activeWhen, naBool, naButton, naColor, naEnum, naFloat, naInt, NA, pctProp, scene, type PropsCtx,
} from './common';

const R = () => app.scene?.render ?? null;

// ------------------------------------------------------------------ frame rate presets

const FPS_PRESETS: [string, number, number][] = [
  ['23.98', 24, 1.001], ['24', 24, 1], ['25', 25, 1], ['29.97', 30, 1.001], ['30', 30, 1],
  ['50', 50, 1], ['59.94', 60, 1.001], ['60', 60, 1], ['120', 120, 1], ['240', 240, 1],
];

/** Set when the user picked "Custom" from the frame rate menu (shows the FPS / Base fields). */
let customFpsChosen = false;

function fpsPreset(): string {
  const sc = app.scene;
  if (!sc || customFpsChosen) return 'CUSTOM';
  const p = FPS_PRESETS.find(([, f, b]) => f === sc.fps && Math.abs(b - sc.fpsBase) < 1e-6);
  return p ? p[0] : 'CUSTOM';
}

function drawFramerate(l: Layout): void {
  const items: EnumItem[] = [
    ...FPS_PRESETS.map(([label]) => ({ id: label, label: `${label} fps` })),
    { id: 'CUSTOM', label: 'Custom' },
  ];
  l.prop({
    kind: 'enum', name: 'Frame Rate', items, notify: ['scene'], undo: 'Change Frame Rate',
    description: 'Framerate, expressed in frames per second', python: 'bpy.context.scene.render.fps',
    get: () => fpsPreset(),
    set: (v) => {
      const sc = app.scene;
      if (!sc) return;
      if (v === 'CUSTOM') { customFpsChosen = true; return; }
      customFpsChosen = false;
      const p = FPS_PRESETS.find(([label]) => label === v);
      if (p) { sc.fps = p[1]; sc.fpsBase = p[2]; }
    },
  }, { noLabel: true });
  if (fpsPreset() === 'CUSTOM') {
    const c = l.column(true);
    c.prop(iprop(scene, 'fps', { name: 'FPS', min: 1, max: 120, description: 'Framerate, expressed in frames per second', notify: ['scene'] }));
    c.prop(fprop(scene, 'fpsBase', { name: 'Base', min: 0.1, max: 120, step: 0.1, precision: 3, description: 'Framerate base', notify: ['scene'] }));
  }
}

// ------------------------------------------------------------------ panels

const FILE_FORMATS: (EnumItem | null)[] = [
  { id: 'BMP', label: 'BMP', icon: 'IMAGE_DATA' },
  { id: 'IRIS', label: 'Iris', icon: 'IMAGE_DATA', disabled: true, description: NA },
  { id: 'PNG', label: 'PNG', icon: 'IMAGE_DATA' },
  { id: 'JPEG', label: 'JPEG', icon: 'IMAGE_DATA' },
  { id: 'JPEG2000', label: 'JPEG 2000', icon: 'IMAGE_DATA', disabled: true, description: NA },
  { id: 'TARGA', label: 'Targa', icon: 'IMAGE_DATA', disabled: true, description: NA },
  { id: 'TARGA_RAW', label: 'Targa Raw', icon: 'IMAGE_DATA', disabled: true, description: NA },
  { id: 'WEBP', label: 'WebP', icon: 'IMAGE_DATA', description: 'WebP image (blender-web)' },
  null,
  { id: 'CINEON', label: 'Cineon', icon: 'IMAGE_DATA', disabled: true, description: NA },
  { id: 'DPX', label: 'DPX', icon: 'IMAGE_DATA', disabled: true, description: NA },
  { id: 'OPEN_EXR_MULTILAYER', label: 'OpenEXR MultiLayer', icon: 'IMAGE_DATA', disabled: true, description: NA },
  { id: 'OPEN_EXR', label: 'OpenEXR', icon: 'IMAGE_DATA', disabled: true, description: NA },
  { id: 'HDR', label: 'Radiance HDR', icon: 'IMAGE_DATA', disabled: true, description: NA },
  { id: 'TIFF', label: 'TIFF', icon: 'IMAGE_DATA', disabled: true, description: NA },
  null,
  { id: 'AVI_JPEG', label: 'AVI JPEG', icon: 'FILE', disabled: true, description: NA },
  { id: 'AVI_RAW', label: 'AVI Raw', icon: 'FILE', disabled: true, description: NA },
  { id: 'FFMPEG', label: 'FFmpeg video', icon: 'FILE', disabled: true, description: NA },
];

export function renderPanels(ctx: PropsCtx): PanelDef[] {
  void ctx;
  const P: PanelDef[] = [];

  P.push({
    id: 'render.render', label: 'Render',
    draw: (l) => {
      const row = l.row(true);
      row.operator('render.render', { text: 'Render', icon: 'RENDER_STILL' });
      row.operator('render.render', { text: 'Animation', icon: 'RENDER_ANIMATION', props: { animation: true } });
      naButton(row, 'Audio', 'PLAY');
      const sp = l.split(0.33);
      sp.column().label('Display:');
      const r = sp.column().row(true);
      r.prop(eprop(R, 'display', [
        { id: 'SCREEN', label: 'Full Screen', description: 'Images are rendered in full Screen' },
        { id: 'AREA', label: 'Image Editor', description: 'Images are rendered in Image Editor' },
        { id: 'WINDOW', label: 'New Window', description: 'Images are rendered in new Window' },
        { id: 'NONE', label: 'Keep UI', description: 'Images are rendered without forcing UI changes' },
      ], { name: 'Display', description: 'Select where rendered images will be displayed', undo: false }), { noLabel: true });
      r.prop(naBool('Lock Interface', false, `Lock interface during rendering: ${NA}`), { iconOnly: true, icon: 'UNLOCKED', iconOn: 'LOCKED' }).classList.add('fixed');
    },
  });

  P.push({
    id: 'render.dimensions', label: 'Dimensions', key: () => fpsPreset(),
    draw: (l) => {
      const pr = l.row(true);
      pr.prop(naEnum('Render Presets', ['Render Presets']), { noLabel: true });
      naButton(pr, '', 'ZOOMIN', true);
      naButton(pr, '', 'ZOOMOUT', true);
      const sp = l.split();
      const col = sp.column();
      const sub = col.column(true);
      sub.label('Resolution:');
      sub.prop(iprop(R, 'resolutionX', { name: 'X', min: 4, max: 65536, softMax: 10000, unit: 'PIXEL', description: 'Number of horizontal pixels in the rendered image', notify: ['render'] }));
      sub.prop(iprop(R, 'resolutionY', { name: 'Y', min: 4, max: 65536, softMax: 10000, unit: 'PIXEL', description: 'Number of vertical pixels in the rendered image', notify: ['render'] }));
      sub.prop(pctProp(R, 'resolutionPercentage', { name: '', min: 1, max: 32767, softMin: 1, softMax: 100, description: 'Percentage scale for render resolution', notify: ['render'] }), { slider: true, text: '' });
      sub.label('Aspect Ratio:');
      sub.prop(fprop(R, 'pixelAspectX', { name: 'X', min: 1, max: 200, precision: 3, description: 'Horizontal aspect ratio - for anamorphic or non-square pixel output', notify: ['render'] }));
      sub.prop(fprop(R, 'pixelAspectY', { name: 'Y', min: 1, max: 200, precision: 3, description: 'Vertical aspect ratio - for anamorphic or non-square pixel output', notify: ['render'] }));
      const row = col.row();
      row.prop(bprop(R, 'useBorder', { name: 'Border', description: 'Render a user-defined border region, within the frame size' }));
      const crop = row.row();
      activeWhen(crop, () => !!R()?.useBorder);
      crop.prop(bprop(R, 'useCropToBorder', { name: 'Crop', description: 'Crop the rendered frame to the defined border size' }));

      const col2 = sp.column();
      const s2 = col2.column(true);
      s2.label('Frame Range:');
      s2.prop(iprop(scene, 'frameStart', { name: 'Start Frame', min: 0, max: 500000, description: 'First frame of the playback/rendering range', notify: ['scene', 'frame'] }));
      s2.prop(iprop(scene, 'frameEnd', { name: 'End Frame', min: 0, max: 500000, description: 'Final frame of the playback/rendering range', notify: ['scene', 'frame'] }));
      s2.prop(iprop(scene, 'frameStep', { name: 'Frame Step', min: 1, max: 100, description: 'Number of frames to skip forward while rendering/playing back each frame', notify: ['scene'] }));
      s2.label('Frame Rate:');
      drawFramerate(s2);
      const tr = s2.row(true);
      tr.label('Time Remapping:', { disabled: true });
      const tr2 = s2.row(true);
      tr2.prop(naInt('Old', 100));
      tr2.prop(naInt('New', 100));
    },
  });

  P.push({
    id: 'render.antialiasing', label: 'Anti-Aliasing',
    drawHeader: (l) => { l.prop(bprop(R, 'useAntialiasing', { name: '', description: 'Render and combine multiple samples per pixel to prevent jagged edges' }), { text: '' }); },
    draw: (l) => {
      activeWhen(l, () => !!R()?.useAntialiasing);
      const sp = l.split();
      const col = sp.column();
      col.row().prop(eprop(R, 'antialiasingSamples', ['5', '8', '11', '16'].map((s) => ({ id: s, label: s })), { name: 'Anti-Aliasing Samples', description: 'Amount of anti-aliasing samples per pixel' }), { expand: true });
      col.prop(naBool('Full Sample'));
      const col2 = sp.column();
      col2.prop(naEnum('Filter', ['Box', 'Tent', 'Quadratic', 'Cubic', 'Catmull-Rom', 'Gaussian', 'Mitchell-Netravali'], 'Mitchell-Netravali'), { noLabel: true });
      col2.prop(fprop(R, 'filterSize', { name: 'Size', min: 0.5, max: 1.5, step: 0.1, precision: 3, unit: 'PIXEL', description: 'Width over which the reconstruction filter combines samples' }));
    },
  });

  P.push({
    id: 'render.motion_blur', label: 'Sampled Motion Blur', defaultClosed: true,
    drawHeader: (l) => { l.prop(bprop(R, 'useMotionBlur', { name: '', description: 'Use multi-sampled 3D scene motion blur (not rendered by blender-web)' }), { text: '' }); },
    draw: (l) => {
      activeWhen(l, () => !!R()?.useMotionBlur);
      const row = l.row();
      row.prop(naInt('Motion Samples', 1));
      row.prop(naFloat('Shutter', 0.5, { precision: 2 }));
    },
  });

  P.push({
    id: 'render.shading', label: 'Shading',
    draw: (l) => {
      const sp = l.split();
      const c1 = sp.column();
      c1.prop(bprop(R, 'useTextures', { name: 'Textures', description: 'Use textures to affect material properties' }));
      c1.prop(bprop(R, 'useShadows', { name: 'Shadows', description: 'Calculate shadows while rendering' }));
      c1.prop(bprop(R, 'useSSS', { name: 'Subsurface Scattering', description: 'Calculate sub-surface scattering in materials rendering' }));
      c1.prop(bprop(R, 'useEnvMaps', { name: 'Environment Map', description: 'Calculate environment maps while rendering' }));
      const c2 = sp.column();
      c2.prop(bprop(R, 'useRaytrace', { name: 'Ray Tracing', description: 'Pre-calculate the raytrace accelerator and render raytracing effects' }));
      c2.prop(eprop(R, 'alphaMode', [
        { id: 'SKY', label: 'Sky', description: 'Transparent pixels are filled with sky color' },
        { id: 'TRANSPARENT', label: 'Transparent', description: 'World background is transparent with premultiplied alpha' },
      ], { name: 'Alpha', description: 'Representation of alpha information in the RGBA pixels' }));
      c2.prop(naBool('World Space Shading'));
    },
  });

  P.push({
    id: 'render.performance', label: 'Performance', defaultClosed: true,
    draw: (l) => {
      const sp = l.split();
      const col = sp.column(true);
      col.label('Threads:');
      col.row(true).prop(eprop(R, 'threadsMode', [
        { id: 'AUTO', label: 'Auto-detect', description: 'Automatically determine the number of threads, based on CPUs' },
        { id: 'FIXED', label: 'Fixed', description: 'Manually determine the number of threads' },
      ], { name: 'Threads Mode', description: 'Determine the amount of render threads used' }), { expand: true });
      col.prop(naInt('Threads', navigator.hardwareConcurrency || 4));
      col.label('Tile Size:');
      col.prop(iprop(R, 'tileX', { name: 'X', min: 8, max: 65536, softMax: 1024, description: 'Horizontal tile size to use while rendering' }));
      col.prop(iprop(R, 'tileY', { name: 'Y', min: 8, max: 65536, softMax: 1024, description: 'Vertical tile size to use while rendering' }));
      col.separator();
      col.prop(naInt('Start Resolution', 64));
      col.prop(naEnum('Pixel Size', ['Automatic', '1x', '2x', '4x', '8x'], 'Automatic'), { noLabel: true });
      const c2 = sp.column();
      c2.label('Memory:', { disabled: true });
      c2.prop(naBool('Save Buffers'));
      c2.prop(naBool('Free Image Textures'));
      c2.label('Acceleration Structure:', { disabled: true });
      c2.prop(naEnum('Raytrace Method', ['Auto', 'Octree', 'BVH', 'SIMD SVBVH', 'SIMD QBVH'], 'Auto'), { noLabel: true });
      c2.prop(naBool('Instances', true));
      c2.prop(naBool('Local Coordinates'));
    },
  });

  P.push({
    id: 'render.post_processing', label: 'Post Processing', defaultClosed: true,
    draw: (l) => {
      const sp = l.split();
      const col = sp.column();
      col.prop(bprop(R, 'useCompositing', { name: 'Compositing', description: 'Process the render result through the compositing pipeline, if compositing nodes are enabled' }));
      col.prop(bprop(R, 'useSequencer', { name: 'Sequencer', description: 'Process the render (and composited) result through the video sequence editor pipeline, if sequencer strips exist' }));
      sp.column().prop(fprop(R, 'ditherIntensity', { name: 'Dither', min: 0, max: 2, precision: 3, description: 'Amount of dithering noise added to the rendered image to break up banding' }), { slider: true });
      l.separator();
      const sp2 = l.split();
      const c1 = sp2.column();
      c1.prop(naBool('Fields'));
      c1.row().prop(naEnum('Field Order', ['Upper First', 'Lower First']), { expand: true });
      c1.prop(naBool('Still'));
      const c2 = sp2.column();
      c2.prop(bprop(R, 'edgeEnable', { name: 'Edge', description: 'Create a toon outline around the edges of geometry' }));
      c2.prop(naInt('Threshold', 30), { slider: true });
      c2.prop(naColor('Edge Color', [0, 0, 0]), { text: '' });
    },
  });

  P.push({
    id: 'render.stamp', label: 'Metadata', defaultClosed: true,
    draw: (l) => {
      // The stamp drawn by blender-web's renderer always contains the file name, frame and camera.
      l.label('Include:');
      const row = l.row();
      const c1 = row.column();
      for (const [n, v] of [['Date', false], ['Time', false], ['Render Time', false], ['Frame', true], ['Frame Range', false], ['Memory', false], ['Hostname', false], ['Camera', true], ['Lens', false]] as [string, boolean][]) c1.prop(naBool(n, v, `Always ${v ? 'included' : 'excluded'} in blender-web`));
      const c2 = row.column();
      for (const [n, v] of [['Scene', false], ['Marker', false], ['Filename', true], ['Seq. Strip', false], ['Note', false]] as [string, boolean][]) c2.prop(naBool(n, v, `Always ${v ? 'included' : 'excluded'} in blender-web`));
      l.separator();
      const sp = l.split(0.4);
      sp.column().prop(bprop(R, 'useStamp', { name: 'Burn Into Image', description: 'Render the stamp info text in the rendered image' }));
      const sub = sp.column();
      sub.prop(naInt('Font Size', 12));
      const sp2 = l.split(0.4);
      sp2.column().label('Text Color:', { disabled: true });
      sp2.column().prop(naColor('Text Color', [1, 1, 1]), { text: '' });
      const sp3 = l.split(0.4);
      sp3.column().label('Background:', { disabled: true });
      sp3.column().prop(naColor('Background', [0, 0, 0]), { text: '' });
    },
  });

  P.push({
    id: 'render.output', label: 'Output', key: () => R()?.fileFormat ?? '',
    draw: (l) => {
      l.prop(sprop(R, 'filepath', { name: '', description: 'Directory/name to save animations, # characters defines the position and length of frame numbers' }), { icon: 'FILE_FOLDER' });
      const sp = l.split();
      const c1 = sp.column();
      c1.prop(bprop(R, 'useOverwrite', { name: 'Overwrite', description: 'Overwrite existing files while rendering' }));
      c1.prop(bprop(R, 'usePlaceholder', { name: 'Placeholders', description: 'Create empty placeholder files while rendering frames (similar to Unix \'touch\')' }));
      const c2 = sp.column();
      c2.prop(bprop(R, 'useFileExtension', { name: 'File Extensions', description: 'Add the file format extensions to the rendered file name (eg: filename + .jpg)' }));
      c2.prop(naBool('Cache Result'));
      // template_image_settings
      const fmt = R()?.fileFormat ?? 'PNG';
      const sp2 = l.split();
      sp2.column().prop(eprop(R, 'fileFormat', FILE_FORMATS, {
        name: 'File Format', description: 'File format to save the rendered images as',
        onChange: () => {
          const r = R();
          // JPEG / BMP have no alpha channel: fall back to RGB like Blender does
          if (r && (r.fileFormat === 'JPEG' || r.fileFormat === 'BMP') && r.colorMode === 'RGBA') r.colorMode = 'RGB';
        },
      }), { noLabel: true });
      const noAlpha = fmt === 'JPEG' || fmt === 'BMP';
      sp2.column().row(true).prop(eprop(R, 'colorMode', [
        { id: 'BW', label: 'BW', description: 'Images get saved in 8 bits grayscale (only PNG, JPEG, TGA, TIF)' },
        { id: 'RGB', label: 'RGB', description: 'Images are saved with RGB (color) data' },
        { id: 'RGBA', label: 'RGBA', description: 'Images are saved with RGB and Alpha data (if supported)', disabled: noAlpha },
      ], { name: 'Color', description: 'Choose BW for saving grayscale images, RGB for saving red, green and blue channels, and RGBA for saving red, green, blue and alpha channels' }), { expand: true });
      const sp3 = l.split();
      if (fmt === 'PNG') {
        const r = sp3.column().row(true);
        r.label('Color Depth:');
        r.prop(eprop(R, 'colorDepth', [{ id: '8', label: '8' }, { id: '16', label: '16' }], { name: 'Color Depth', description: 'Bit depth per channel' }), { expand: true });
        sp3.column().prop(pctProp(R, 'compression', { name: 'Compression', min: 0, max: 100, description: 'Amount of time to determine best compression: 0 = no compression with fast file output, 100 = maximum lossless compression with slow file output' }), { slider: true });
      } else if (fmt === 'JPEG' || fmt === 'WEBP') {
        sp3.column();
        sp3.column().prop(pctProp(R, 'quality', { name: 'Quality', min: 0, max: 100, description: 'Quality for image formats that support lossy compression' }), { slider: true });
      }
    },
  });

  P.push({
    id: 'render.bake', label: 'Bake', defaultClosed: true,
    draw: (l) => {
      naButton(l, 'Bake', 'RENDER_STILL');
      l.prop(naEnum('Bake Mode', ['Full Render', 'Ambient Occlusion', 'Shadow', 'Normals', 'Textures', 'Displacement', 'Derivative', 'Vertex Colors', 'Emission', 'Alpha', 'Mirror Intensity', 'Mirror Colors', 'Specular Intensity', 'Specular Colors'], 'Full Render'));
      const sp = l.split();
      const c1 = sp.column();
      c1.prop(naBool('Clear', true));
      c1.prop(naInt('Margin', 16));
      const c2 = sp.column();
      c2.prop(naBool('Selected to Active'));
      c2.prop(naFloat('Distance', 0));
      c2.prop(naFloat('Bias', 0.001));
    },
  });

  P.push({
    id: 'render.freestyle', label: 'Freestyle', defaultClosed: true,
    drawHeader: (l) => { l.prop(bprop(R, 'useFreestyle', { name: '', description: 'Draw stylized strokes using Freestyle (not rendered by blender-web)' }), { text: '' }); },
    draw: (l) => {
      activeWhen(l, () => !!R()?.useFreestyle);
      const row = l.row();
      row.label('Line Thickness Mode:', { disabled: true });
      l.row().prop(naEnum('Line Thickness Mode', ['Absolute', 'Relative']), { expand: true });
      l.prop(naFloat('Line Thickness', 1));
    },
  });

  return P;
}

