# Plan: adding the missing Blender 2.79b features

This file tracks the current round of work on blender-web. It is updated as each step finishes.

- **Request:** "add all of the missing features u can". The starting point was the "What is not implemented" list in `README.md` as of commit `228b114`.
- **Work in progress:** happens on the branch `wip/missing-features`.
  - It gets regular snapshot commits, so nothing is lost if the cloud container restarts.
  - `main` stays at the last stable commit until everything is integrated and tested.

## Work streams

Seven parallel work streams. Each owns its own new files and makes only small, additive edits to shared files.

| # | Stream | Scope | Status |
|---|---|---|---|
| 1 | Mesh tools | Bevel (Ctrl+B), Knife (K), Bisect, Monkey primitive, edge/vertex slide, rip, bridge, fill, select shortest path/similar; Bevel, Boolean, Decimate, Remesh, Shrinkwrap, Laplacian Smooth, Multires modifiers; volume snapping | In progress |
| 2 | UV & Texture Paint | UV maps and seams, Unwrap/Smart UV/projections, UV editing in the UV/Image editor, new images (UV grid), UV texture coordinates, Texture Paint mode | In progress |
| 3 | Rigging | Vertex groups, Weight Paint, armatures (edit and pose mode, bone keyframes), Armature modifier with automatic weights, lattices, Hook modifier | In progress |
| 4 | Curves & other types | Bezier/NURBS curves (edit mode, bevel/extrude), NURBS surfaces, metaballs, conversions, Curve modifier/Follow Path, custom fonts and materials for text | In progress |
| 5 | Editors | Node editor with compositing, NLA editor, Video Sequence Editor, Movie Clip editor (tracking), new screen layouts, `.blend` import | In progress |
| 6 | Physics | Rigid body (via `cannon-es`), cloth, collision, force fields, soft body, hair particles | In progress |
| 7 | Cycles | Progressive WebGL2 path tracer, Cycles render/material/world/lamp panels | In progress |

Timeline so far:

- All seven streams were started together.
- A container restart stopped them part-way.
- Their work had survived on disk, so it was backed up and they were resumed.

## Steps after all streams finish

1. [ ] Collect each stream's report: features, limits, test status.
2. [ ] Integrate: `npm run typecheck`, `npm run build`, `npm test`; fix breakage where the streams meet.
3. [ ] Headless-browser smoke test of the whole app: startup with no console errors, new object types, modes, editors, F12 with both engines.
4. [ ] Update `README.md`: the "What works" sections, and a shorter "What is not implemented" list.
5. [ ] **Squash-merge** `wip/missing-features` into `main` as one new commit, then push.
   - This keeps the WIP snapshot history (including an early snapshot that briefly contained the private preview link) out of `main`.
   - Before merging, scan for links, emails and secrets.
6. [ ] Rebuild and republish the private web preview of the app. The link is shared only in chat, never in the repo.
7. [ ] Remove Playwright from the cloud container, at the user's request because of CVEs:
   - uninstall the global `playwright` and `playwright-core` packages;
   - delete the `/opt/pw-browsers` Chromium builds;
   - check that nothing remains.
8. [ ] Run `npm audit` on the project's own dependencies and fix or report any findings.
9. [ ] Write the final summary for the user.

Playwright is not a project dependency. It only exists as a preinstalled tool in the cloud container and was used for testing. Removing it inside the container lasts only for this session. To keep it off in future sessions, the cloud environment's setup script has to remove it.

## Log

- Seven streams started. Snapshots pushed to `wip/missing-features`: `1b43aa5`, `e534c39`, `39a38f7`, `fb8ff58`, `1faf89b`, `39b6b06`.
- The container restarted mid-run. No work was lost, and all streams were resumed.
- Privacy check:
  - The GitHub repo is **public**.
  - The private preview link was removed from this file (`a9aac36`). It remains only in WIP-branch commit `abef42f`.
  - Rewriting the branch history needs the owner's permission, so it was not done. The squash-merge keeps that commit out of `main`.
  - Full-history scan: no tokens, keys, private keys or email addresses were found.
- Rule for the rest of this work: no preview links, emails or secrets go into the repo.
