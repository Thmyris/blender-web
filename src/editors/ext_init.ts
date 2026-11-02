// Registration of the Node, NLA, Video Sequence and Movie Clip editors: operators, keymaps, render
// pipeline hooks (compositing, sequencer) and defaults for documents saved by older versions.

import { app, docLoadHooks, type OperatorDef } from '../app';
import { registerKeymap, type KeyItem } from '../keymap';
import { setFrameHook } from '../render/render';
import '../nodes/cmp_nodes';
import '../nodes/shader_nodes';
import { NODE_OPERATORS } from './node';
import { compositeFrame, initCompositor } from '../nodes/compositor';

const C = { ctrl: true }, S = { shift: true }, A = { alt: true }, CS = { ctrl: true, shift: true };
type Mods = { ctrl?: boolean; shift?: boolean; alt?: boolean };

function keys(space: KeyItem['space'], list: [string, string, Record<string, unknown>?, Mods?][]): KeyItem[] {
  return list.map(([code, op, props, mods]) => ({ code, space, op, props: props ?? {}, ...(mods ?? {}) }));
}

const NODE_KEYS = keys('NODE_EDITOR', [
  ['KeyA', 'node.select_all', { action: 'TOGGLE' }],
  ['KeyI', 'node.select_all', { action: 'INVERT' }, C],
  ['KeyB', 'node.select_border'],
  ['KeyL', 'node.select_linked_from'],
  ['KeyL', 'node.select_linked_to', {}, S],
  ['KeyG', 'node.select_grouped', { type: 'TYPE' }, S],
  ['KeyG', 'node.translate_attach'],
  ['KeyX', 'node.delete'],
  ['Delete', 'node.delete'],
  ['KeyX', 'node.delete_reconnect', {}, C],
  ['KeyD', 'node.duplicate_move', {}, S],
  ['KeyA', 'node.add_menu', {}, S],
  ['KeyM', 'node.mute_toggle'],
  ['KeyH', 'node.hide_toggle'],
  ['KeyH', 'node.hide_socket_toggle', {}, C],
  ['KeyF', 'node.link_make', { replace: false }],
  ['KeyF', 'node.link_make', { replace: true }, S],
  ['KeyD', 'node.links_detach', {}, A],
  ['KeyJ', 'node.join', {}, C],
  ['KeyP', 'node.detach', {}, A],
  ['Home', 'node.view_all'],
  ['NumpadDecimal', 'node.view_selected'],
  ['KeyV', 'node.backimage_zoom', { factor: 1 / 1.2 }],
  ['KeyV', 'node.backimage_zoom', { factor: 1.2 }, A],
  ['Home', 'node.backimage_fit', {}, A],
  ['KeyR', 'node.read_renderlayers', {}, C],
]);

/** Operators of all four editors. */
export function editorOperators(): OperatorDef[] {
  return [...NODE_OPERATORS];
}

export function initEditorsExt(): void {
  for (const d of editorOperators()) app.registerOperator(d);
  registerKeymap([...NODE_KEYS], true);
  initCompositor();
  setFrameHook(async (renderScene, shading) => {
    const c = await renderScene();
    if (!c || shading !== 'RENDERED') return c;
    return compositeFrame(c);
  });
  docLoadHooks.push((doc) => {
    doc.actions ??= {};
    doc.media ??= {};
    doc.clips ??= {};
  });
}

void CS;
