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
5. [ ] **Squash-merge** `wip/missing-features` into `main` as one commit, push, then delete the WIP branch.
   - Before merging, scan for links, emails and secrets.
6. [ ] Rebuild and republish the private web preview of the app. The link is shared only in chat, never in the repo.
7. [ ] Remove Playwright from the cloud container (user request because of CVEs):
   - uninstall the global `playwright` / `playwright-core` packages;
   - delete the `/opt/pw-browsers` browsers;
   - verify that nothing remains.
8. [ ] Run `npm audit` on the project's dependencies.
9. [ ] Final summary for the user.

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
- The private preview link was briefly committed to the WIP branch. That history was rewritten (force-push, approved by the user), so no branch contains it.
- Full-history scans found no tokens, keys, private keys or email addresses.
- Rule: no preview links, emails or secrets go into the repo.
