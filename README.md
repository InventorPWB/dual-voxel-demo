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
| Material + shape (e.g. *Brick Slope*) | Break the piece you aim at (see below) | Place it (Shift + right mouse repaints what left mouse would break) |
| Pickaxe | Dig | |
| Shovel | Dig | Raise ground (in the last natural material you used) |
| Trowel | Smooth | Smooth |
| Level | Flatten to the height you clicked (snapped to whole metres, so pads line up with the build grid) | Same |
| Leaves | Break the metre of leaves you aim at | Place a 1 m block of leaves |
| Grass | Pull up grass under the brush | Plant grass under the brush (on grass or dirt only) |

Grass and flowers are looked through; leaves can be aimed at.

- **Inventory:** press **E**. Click an item to put it in the selected hotbar slot, or drag it onto a slot.
- **Hotbar:** **1–9** or the mouse wheel selects a slot. **Alt + wheel** resizes the held tool's brush.
- **Placement, Minecraft-style, always on the world's build grid** (1 m for 1 m pieces; 0.5 m steps for slabs and small blocks):
  - **Where:** the grid cell just beyond the face you aim at. If a piece already takes part of that cell (a block on top of a half-height slab, say), it moves one more step out.
  - **On natural ground:** pieces go to the nearest whole metre, so neighbours share a height. Nothing is filled in underneath.
  - **Orientation:** slopes and stairs rise away from you, and flip upside down against a ceiling.
- **Breaking, on the 1 m grid, whatever you hold:**
  - **A building piece:** the whole piece within the metre cell you aim at. A 1 m block, slope or pillar goes whole; two slabs sharing a metre, or eight small blocks, go one at a time. Each building voxel remembers its offset within its piece, which is how its piece is found.
  - **Ground:** the terrain in that metre cell.
  - **Leaves:** in the shape of the held item, on its grid: a 1 m item clears a metre of leaves, a small block one voxel. The pickaxe and shovel clear leaves within their brush.
- **In-world indicators:** the only ones are a ghost of the piece you're about to place or break (red while breaking, grey if it would overlap you or another piece) and a ring for brushes. There are no on-screen tool panels.

## How it works

- **One grid, two kinds of voxel** (`src/world/World.js`, `Chunk.js`). Every 0.5 m voxel has a material, where 0 means empty, and a shape state.
  - **Shape state 0 is smooth terrain**, stored as hermite data: on every voxel edge where terrain ends, the exact crossing point and surface normal.
  - **Any other state is a building piece:** a cube, a 45° wedge, a quarter-round or a sphere octant, in some orientation (`src/world/shapes.js`).
- **Why building pieces aren't part of the smooth surface:** an earlier version stamped shapes into the terrain as a single surface. Every shape on its own came out exact. But wherever pieces met, such as two slopes at right angles, several sharp edges fell inside one cell, and a dual-contouring mesher can give each cell only one vertex. So joints were bent by up to 18 cm. Drawing pieces as exact polygons removes that limit.
- **The plant layer** (`src/world/plants.js`): a third value per voxel, only in empty voxels, for grass, flowers and leaves. Plants are never solid: no collision, and anything that becomes solid overwrites them. Plants that need ground (grass, flowers) go when it does: after every edit, `settlePlants` removes those left without terrain or a flat-topped piece under them.
- **Materials and passes** (`src/world/materials.js`): each material is drawn in one render pass: *opaque*, *cutout* (alpha-tested, e.g. Glass) or *translucent* (blended, e.g. Stained Glass). A piece's face is only hidden by an opaque neighbour or one of the same material, so stone behind glass is still drawn and glass-to-glass faces merge. 
- **Texture mapping:** most materials tile one texture per metre of world space (triplanar), so brick and planks line up across pieces. Log, Glass and Stained Glass building pieces are mapped per piece instead: the mesher gives each piece vertex its position within the whole piece and the kind of shape, so a log's rings centre on it and bark wraps round a pillar. Glass draws its frame along each piece's outline: a square on blocks, a circle on pillar caps. Glass is drawn from the front only, like Minecraft. Smooth Log terrain (tree trunks) is bark everywhere, except where it has been cut. When an edit removes a voxel next to wood (breaking, digging), the edges between them are marked cut (`Chunk.cut`). The mesher draws the surface across a cut edge as Cut Log, a hidden end-grain material. So a cut shows end grain in any orientation, a stump's top out to the bark, and each bit of surface is one texture or the other, never a blend.
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
  - **Placing** writes the piece's voxel states, and its offset within the piece.
  - **Breaking** (`breakCells`, `clearCells`) clears the voxels of one piece or one metre of ground. Terrain left around the hole gets flat faces.
- **Safety:** nothing ever becomes solid inside the player, and tiny floating bits of terrain left by edits are dissolved.
- **Foliage** (`src/mesh/foliage.js`), meshed on the workers with each chunk:
  - **Grass and flowers** are clumps of crossed cards standing on the ground under their voxel. On smooth terrain, the exact height and slope come from the hermite crossing on the vertical edge below, so tufts sit on the surface you see. Positions are hashed from world coordinates, so re-meshing puts every tuft back where it was. They sway in the wind and fade out between 40 and 60 m.
  - **Leaves** are drawn as a whole crown, as stylised games do: a solid, slightly inset core around the leaf voxels (surface nets over a softened occupancy field, with rounded normals, textured triplanar in the shader), so you never see into a hollow, plus swaying leaf cards on about half its vertices for a ragged outline. Both textures are sprays of small leaves.
  - **Cutouts are plain alpha tests** (glass, grass, leaves): each pixel is either fully drawn or not. Alpha-to-coverage was dropped because many drivers (NVIDIA and D3D, which Chrome uses on Windows) dither partial coverage, which showed up as dots of sky all over foliage.
  - **Mipmaps made for cutouts** (`src/render/textureArray.js`): the texture array's smaller levels are built on the CPU, with colour averaged weighted by alpha and alpha scaled per level to keep each texture's cutout coverage. So distant grass and leaves neither pick up the colour of their holes (pale or grey specks) nor thin out. Grass also takes on the colour of the grass ground under it from 10 to 38 m, since blades thinner than a pixel shimmer against the ground, and thins out a whole clump at a time from 40 to 60 m.
- **Generation** (`src/world/generate.js`, `trees.js`): after the terrain, trees, then grass and flower patches on grass ground.
  - **Trees** are proportioned like broad oaks, built the way stylised games build them. The crown spreads 11-15 m, as wide as the tree is tall or wider, and about 13-15 times the trunk's width.
    - **Wood:** the trunk flares at the foot, tapers to a fork at 3-4.5 m and splits into 4-5 spreading limbs, each forking once more, plus a leader up the middle.
    - **Crown:** dense leaf clusters in two tiers (along and at the end of every limb, then a ring above and inward of those) and on top, so it builds up into a tall dome.
    - **Built as smooth Log terrain:** an exact CSG union of tapered capsules, joined with rounded fillets so there are no creases where parts meet. So each tree leans, forks and spreads differently, and can be dug or chopped like ground.
    - **Thickness limit:** wood stays at least about 1.5 voxels thick, the least the terrain mesher draws reliably; that sets the trunk's minimum width, so the crowns are scaled up to match. Floor plants only grow on soil (grass and dirt).
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
