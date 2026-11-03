# Plan: adding the missing Blender 2.79b features

This file tracked the work on the request "add all of the missing features u can". The starting point was the "What is not implemented" list in `README.md` as of commit `228b114`.

## How the work was done

1. Seven parallel work streams, each owning its own files: mesh tools, UV & texture paint, rigging, curves & other object types, new editors, physics, and Cycles.
2. Snapshots were committed to the branch `wip/missing-features` along the way, so container restarts lost nothing. There were two restarts.
3. The streams were stopped by the user before they finished. The lead then integrated what existed:
   - fixed the type errors left behind;
   - wrote the missing glue code:
     - registering the curve, surface and metaball operators and keymaps, and their edit modes;
     - the Add-menu entries and Alt+C Convert menu;
     - operators for 11 mesh tools whose algorithms existed but were never registered;
     - hooking the new particle, hair and force-field drawing into the viewport and renders;
   - wrote the unfinished modules (`core/curvedeform.ts`: Follow Path and Clamp To; `paint/texpaint.ts`: image painting);
   - fixed Symmetrize so it cuts faces crossing the mirror plane.
4. Everything was tested in a headless browser.
5. `README.md` was updated, listing what works and what is still missing.

## Steps

1. [x] Collect each stream's work.
2. [x] Integrate: `npm run typecheck` (0 errors), `npm run build`, `npm test` (90 passed, 0 failed).
3. [x] Headless-browser checks:
   - startup with no console errors;
   - Monkey, Bevel, Bisect, Subdivide / Un-Subdivide, Symmetrize, Edge Split, Beautify;
   - curves (add, edit, subdivide), NURBS surface, metaball, Convert (metaball→mesh, text→curve);
   - armature (add, edit, pose), lattice, force fields, Weight Paint mode;
   - UV Smart Project, image Paint mode (mouse stroke);
   - rigid body falling, Follow Path moving an empty;
   - Quick Fur hair and emitter particles in the viewport and F12;
   - Node editor compositing;
   - F12 render with Blender Render and with Cycles.
4. [x] Update `README.md`.
5. [x] Squash-merged into `main` as one commit (`e8d2ffd`) and pushed; the merge diff was scanned and contained no links, emails or secrets.
   - Deleting the `wip/missing-features` branch on GitHub was refused by the cloud environment's GitHub proxy (branch deletion is not permitted from these sessions).
   - The local copy was deleted. The remote branch has to be deleted by the owner on GitHub. It no longer contains the preview link.
6. [x] Rebuilt and republished the web preview at the same link (shared only in chat).
   - Note: its sharing setting is "Anyone with the link"; the owner can change it in the page's Share menu.
7. [x] Removed Playwright from this cloud container:
   - global link and `/opt/node-tools` packages (`playwright`, `playwright-core`) uninstalled;
   - `/opt/pw-browsers` (Chromium builds and ffmpeg) deleted;
   - verified that no command, module, folder or process remains.
   - Playwright was never a project dependency.
   - A new cloud session starts from a fresh image, which has Playwright again unless the environment's setup script removes it.
8. [x] `npm audit`: 0 vulnerabilities (three, cannon-es, vite, typescript).
9. [x] Final summary given to the user in chat.

## Not finished by the work streams

Listed in `README.md` under "What is not implemented":
- the Bevel, Boolean, Decimate, Remesh, Shrinkwrap, Laplacian Smooth, Multiresolution, Skin and Curve modifiers;
- Rip and Edge/Vertex Slide;
- UV-mapped textures in the viewport and renders;
- texture painting in the 3D View;
- the NLA, Video Sequence and Movie Clip editors;
- `.blend` import.

## Privacy

- The GitHub repo is public.
- The preview link was briefly committed to the WIP branch. That history was rewritten (force-push, approved by the user), so no branch contains it.
- Full-history scans found no tokens, keys, private keys or email addresses.
- Rule: no preview links, emails or secrets go into the repo.
