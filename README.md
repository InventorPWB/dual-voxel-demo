# Dual Voxel Demo

A three.js prototype of a voxel sandbox in the style of EverQuest Next Landmark and Enshrouded. Terrain and buildings live in **one voxel grid** of 0.5 m voxels. Each voxel is either smooth terrain or a building shape: you build Minecraft-style on a grid and reshape the ground with tools. There are no modelled assets. Shapes are generated in code, and the look comes from procedural textures.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # mesher, shape, placement and edit-rule tests
```

The first hybrid design (exact cube blocks plus a smooth field, reconciled by the mesher) is shelved in `legacy/`; see `legacy/NOTE.md`. It ran into the same problem 7 Days to Die has: wherever the two systems met, the joint was a guess, so it produced trenches, curtains and wedges. Here there is nothing to reconcile, because terrain simply ends on the faces of building pieces.

## Playing

Everything is an item in the hotbar. Left mouse breaks or digs, right mouse places or uses, whatever you hold, as in Minecraft.

| Item | Left mouse | Right mouse |
|---|---|---|
| Material + shape (e.g. *Brick Slope*) | Remove the cell you aim at | Place it (Shift + right mouse repaints the cell) |
| Pickaxe | Dig | |
| Shovel | Dig | Raise ground (in the last natural material you used) |
| Trowel | Smooth | Smooth |
| Level | Flatten to the height you clicked (snapped to whole metres, so pads line up with the build grid) | Same |
| Leaves | Remove the leaf you aim at | Place a 1 m block of leaves |
| Grass | Pull up grass under the brush | Plant grass under the brush |

Whatever you hold, left mouse on a leaf you aim at removes it; the pickaxe and shovel clear leaves within their brush. Grass and flowers are looked through.

- **Inventory:** press **E**. Click an item to put it in the selected hotbar slot, or drag it onto a slot.
- **Hotbar:** **1–9** or the mouse wheel selects a slot. **Alt + wheel** resizes the held tool's brush.
- **Placement, Minecraft-style:**
  - **Along the face you aim at:** a piece sits flush against it.
  - **Across the face:** it snaps to the build grid (1 m for 1 m pieces, 0.5 m for slabs and small blocks), lined up with the piece you aim at. Each building voxel remembers its offset within its piece.
  - **On natural ground:** pieces go to the nearest whole metre. Any gap underneath, up to 1 m, is filled with a foundation of the same material.
  - **Orientation:** slopes and stairs rise away from you, and flip upside down against a ceiling.
- **In-world indicators:** the only ones are a ghost of the piece you're about to place or remove (red while removing, grey if it would overlap you) and a ring for tool brushes. There are no on-screen tool panels.

## How it works

- **One grid, two kinds of voxel** (`src/world/World.js`, `Chunk.js`). Every 0.5 m voxel has a material, where 0 means empty, and a shape state.
  - **Shape state 0 is smooth terrain**, stored as hermite data: on every voxel edge where terrain ends, the exact crossing point and surface normal.
  - **Any other state is a building piece:** a cube, a 45° wedge, a quarter-round or a sphere octant, in some orientation (`src/world/shapes.js`).
- **Why building pieces aren't part of the smooth surface:** an earlier version stamped shapes into the terrain as a single surface. Every shape on its own came out exact. But wherever pieces met, such as two slopes at right angles, several sharp edges fell inside one cell, and a dual-contouring mesher can give each cell only one vertex. So joints were bent by up to 18 cm. Drawing pieces as exact polygons removes that limit.
- **The plant layer** (`src/world/plants.js`): a third value per voxel, only in empty voxels, for grass, flowers and leaves. Plants are never solid: no collision, and anything that becomes solid overwrites them. Plants that need ground (grass, flowers) go when it does: after every edit, `settlePlants` removes those left without terrain or a flat-topped piece under them.
- **Materials and passes** (`src/world/materials.js`): each material is drawn in one render pass: *opaque*, *cutout* (alpha-tested, e.g. Glass) or *translucent* (blended, e.g. Stained Glass). A piece's face is only hidden by an opaque neighbour or one of the same material, so stone behind glass is still drawn and glass-to-glass faces merge. Log is a natural material, so tree trunks are ordinary smooth terrain you can dig.
- **Inventory items are voxel patterns** of those states:
  - **block:** 1 m (8 cubes);
  - **small block:** 0.5 m (1 cube);
  - **slab:** 1 × 0.5 × 1 m;
  - **slope:** a wedge, a cube and a wedge per column, giving one flat 45° face. Stacked diagonally, slopes make an exactly flat roof;
  - **stairs:** 1 m with two 0.5 m steps;
  - **pillar:** four quarter-rounds;
  - **sphere:** eight octants.
- **Meshing** (`src/mesh/dualContour.js`):
  - **Building pieces:** each building voxel emits its shape's exact polygons, Minecraft-style. A face is skipped when the neighbouring piece's face covers it (each face's outline is compared). Pieces meet exactly in any combination.
  - **Terrain:** dual contouring of the hermite data. Each cell's vertex is the least-squares fit to its crossings' tangent planes. Where terrain meets a building voxel, the surface is that voxel's face, so terrain ends exactly on pieces and never overlaps them. Natural materials (grass, dirt, stone, sand) are softened slightly.
  - **Chunks:** 16 m (32 voxels), meshed on web workers from a padded copy, so seams match.
- **Terrain edits are exact CSG** (`src/world/csg.js`).
  - **Digging, raising and levelling** are booleans with a signed distance function (a sphere, or a half-space inside a circle). On each changed edge, they keep whichever surface is the real boundary.
  - **Smoothing** rebuilds a local distance field from the stored crossings, blurs it, and writes new crossings back.
  - **Building pieces are off-limits:** terrain edits never grow into them or remove them.
- **Building edits** (`src/world/edits.js`):
  - **Placing** writes the piece's voxel states (with foundations on uneven ground).
  - **Removing** clears the aimed-at cell, pieces and terrain alike. Terrain left around the hole gets flat faces.
- **Safety:** nothing ever becomes solid inside the player, and tiny floating bits of terrain left by edits are dissolved.
- **Foliage** (`src/mesh/foliage.js`), meshed on the workers with each chunk:
  - **Grass and flowers** are clumps of crossed cards standing on the ground under their voxel. On smooth terrain, the exact height and slope come from the hermite crossing on the vertical edge below, so tufts sit on the surface you see. Positions are hashed from world coordinates, so re-meshing puts every tuft back where it was. They sway in the wind and fade out between 40 and 60 m.
  - **Leaves** are drawn as a whole canopy: a smooth hull around the leaf voxels (surface nets over a softened occupancy field), with swaying leaf cards scattered over it.
- **Generation** (`src/world/generate.js`, `trees.js`): after the terrain, trees (a tapered Log trunk as an exact CSG union, plus a canopy of noisy leaf blobs), then grass and flower patches on grass ground.
- **Shadows** (`src/render/SunShadow.js`): one 4096² sun shadow map fitted to the whole world (about 4 cm per texel), sampled by every world material through the shared lighting (`src/render/lighting.js`), so blocks, shaped pieces, smooth terrain and foliage all cast and receive shadows alike.
  - Each caster draws the map with its own depth material: plain for opaque surfaces, alpha-tested for glass frames and leaves. Grass and stained glass cast none. Leaves cast without their sway, so the map stays cached.
  - It is only redrawn when a chunk mesh changes or the sun moves (about 1 ms for the whole world). Otherwise shadows cost only a 9-tap hardware PCF lookup per pixel.
  - Self-shadowing is kept off with a slope-scaled polygon offset plus a normal offset in the shader. The sun's wrap lighting fades out at the terminator, so it doesn't meet a hard shadow edge.
  - Hold **[** or **]** to swing the sun around and watch the shadows move.
- **Collision** (`src/player/Player.js`) is a capsule against the rendered solid meshes (glass included; foliage isn't, so you walk through leaves and grass).
  - Ledges up to one voxel (0.5 m) are stepped up automatically, so stairs are walkable. A 1 m block needs a jump.
  - Slopes up to 60° are walkable.

## Layout

| Path | What |
|---|---|
| `src/world/` | `World` (voxel storage: materials, shape states, terrain hermite data, plants), shapes, plants, CSG, edit rules, generation, trees, materials, noise |
| `src/mesh/` | mesher (exact pieces + dual-contoured terrain, per render pass), foliage mesher, worker |
| `src/render/` | procedural textures and their texture array, shared lighting, chunk and foliage materials, sun shadow, chunk mesh manager (BVH raycasts) |
| `src/items/` | item registry (tools, plants, material × shape), interaction and in-world previews |
| `src/player/` | first-person walk/fly and collision |
| `src/ui/` | hotbar, inventory, code-drawn icons |
| `legacy/` | the shelved hybrid design |

In dev builds, `window.demo` exposes the world, player, interaction, hotbar and HUD in the console.
