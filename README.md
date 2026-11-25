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
| Bucket | Scoop up a cubic metre of water | Pour it out |
| Water | Soak up water under the brush | Flood the brush's area up to the height you clicked |
| Spring, Small Spring | Remove it | Place it: water wells up from its top (100 or 25 litres a second) up to 2 m over it; bury it and it stops |

In water you wade (slower the deeper), then swim: you float with your head out, Space swims up, Shift dives, and with your head under, W swims the way you look. Currents carry you along.

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
  - **Texture blending:** each cell's vertex takes a material by vote of its crossings (most wins, a tie goes to the higher material). A natural terrain triangle carries its three vertices' materials (the `blend` attribute, packed into one float) and the shader fades between them by barycentric weight (`gl_VertexID % 3`), roughened per half-texel by noise and sharpened, so borders between grass, dirt, stone and sand dissolve over about a cell instead of stepping in sawteeth. Crafted and glass terrain never blend. On slopes, grass keeps its top texture; its dirt-edged side texture only shows on near-vertical faces.
  - **Generated ground** measures depth below the surface perpendicular to it (from the terrain function's gradient), so the grass skin holds on slopes and overhangs and dirt or stone don't show through.
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
- **Water** (`src/world/SpanSim.js`, `FluxSim.js`, `FluidSim.js`, `fluidCore.js`, `hydrology.js`, `src/mesh/spanMesh.js`, `fluidSurface.js`, `fluidMesh.js`, `src/render/waterMaterial.js`). Three systems, chosen in Settings (*Water system*; changing it reloads): spans (the default), the flux water, and the earlier cellular water. They share sources, generation, tools and look.
  - **Spans** (`SpanSim`, the default): a layered heightfield. Each 0.5 m column is a stack of spans (runs of open voxels: the air over the ground, a cave, the inside of a room), each holding a depth of water that sits on the smooth ground's exact height. A stream on a slope is one continuous sheet, and a sealed room under water is a dry span between two wet ones (it floods if breached).
    - **Flow:** shallow water between spans of neighbouring columns that share open voxels. Each link keeps a speed, which the difference in level speeds up and the bed's friction slows (Manning's law, solved implicitly: far stronger in thin water), and carries that speed times the depth of water at the face. So a river settles into steady, laminar flow at a realistic pace (about 0.5 m/s), water down a steep chute runs a few m/s and a few centimetres deep rather than racing off as a film, and nothing sloshes back and forth. Slow residual motion loses its momentum, so ripples die out and still water sleeps; water rests once it's level to half a millimetre. Spans full to their roof are under pressure (a flooded cave under an overhang, a pipe); flow into or out of them is held to a share of what would even the two sides out in a tick, so the pressure settles rather than hammering. Water is conserved exactly. The voxel fluid layer is kept as a mirror of the spans, so the player, tools, sources and the height texture read it as before.
    - **Surface** (`spanMesh.js`): one sheet with shared corners. Levels within 1.25 m join, so steep runs stay one sheet. Running water is lifted clear of the ground under it: down a steep slope the smooth ground is terraced, a 0.5 m layer per column, so each corner rises to clear the step of every column round it (and a little more at a lip over a drop). Squares that aren't level are split in four on monotone cubic curves through the corners either side, so the sheet bends smoothly without bulging into the ground or over a lip. The sheet carries on over dry shores so the ground cuts it off exactly. Water full to its roof (under an overhang) has no surface and isn't drawn, and levels only join into one sheet where the space between them is open, not across a roof. Panes are drawn where water meets glass.
    - **Waterfalls:** a falling sheet thrown from the lip as fast as the water ran over it, along a parabola that clears the lip's edge, thinning into spray. Neighbouring falls meet as one sheet, and a fall fades out at an end with nothing beside it. Glassy as it goes over, white water lower down.
    - **Over time:** each new water mesh glides from what the previous one showed (height, flow and depth) over the time between them, so the surface and its currents change smoothly rather than stepping at each update.
  - **Storage:** a fluid value per empty voxel (volume and type, 16 bits; lava has a type reserved), allocated per chunk only where there's water. A chunk entirely full of still water is kept as one value.
  - **Flux simulation** (new, `FluxSim`): the same voxel cells and volumes, but each sideways face between two cells also keeps how much flowed through it last tick. Each tick that flow is kept (damped to 88%) and pushed on by the difference in level across the face: the "virtual pipes" model of shallow water, in 3D voxels. So water has momentum (rivers run on, a breach surges, ripples cross a pond and die away within a second or two, a sea stays calm), and a real velocity for currents and ripples. Outflows are scaled so no cell gives more than it holds; falling and overfill work as in the cellular water. Sources are fixed levels with no momentum.
  - **Cellular simulation** (earlier, `FluidSim`): a cellular automaton on the voxel grid, 20 ticks a second. Water falls into room below, then flows sideways by the difference in level, then overfill goes up. Level counts how far the smooth ground pokes up into a voxel, so gentle slopes and river gradients work. A full cell under more water takes its column's surface as its level, so water finds its level through U-bends and under walls.
    - Volume is conserved exactly (whole units), and each transfer is made at once, from higher to lower and never past level, so water always comes to rest and then sleeps: only cells near a change are visited.
    - Edits wake the water around them. A voxel that becomes solid pushes its water out nearby. Deep enough water washes away grass and flowers.
    - Water farther than 48 m from the player moves only every fourth tick.
  - **Where water comes from and goes** (span water; derived from the water itself, never declared):
    - **Oceans:** any body of deep, still water big enough (its middle at least 64 tiles of 2 m, about 25 m across of water 1 m deep) is an ocean. It holds its level: take from it and it doesn't run out, rivers run into it and it doesn't rise, and breaching it floods the land below its level. Its edge water feeding a breach doesn't wear it away; filling it in or soaking it up until no part is big enough does. The water brush sets an ocean's level, so a lake built big enough becomes an ocean at its level and can be raised or lowered.
    - **Everything smaller is the water it holds:** breach a lake and it spills its actual volume down to the cut; rivers into it raise it until it spills over its rim.
    - **Springs** (`world.springs`) are where new water comes from: each gives water at a rate, slowing as the water over it nears the level it can push to, and stopping there (so a spring in a hollow fills it and rests, and in the open it runs a stream for ever). Spring blocks (the Spring and Small Spring items, building pieces of their own material) are springs: every voxel of one gives 25 litres a second into the voxel over it, up to 2 m above, so only a block's top gives water and a buried one gives none; the simulation keeps `world.springs` in step with them as they're placed and removed. The generated lake has a natural spring in its bed sized to its river (0.35 m³/s); its outlet sill is cut so the lake settles at the level it was made at.
    - **Soaking:** a stray film under 1 cm that nothing flows into (what's left after draining, round where the sponge took water) soaks into soil and sand in a second or two, and dries off rock and building pieces more slowly. Not the shallow edge of a body of water (water at its level, deeper water close by), nor a stream however thin.
  - **Infinite water for the cellular and flux water:** the middle of any large, deep, still body is a source (the body eroded 5 m inward, judged per 2 m tile from each column's depth and surface level). Sources hold their level: they give water without running out and absorb what flows in. So rivers fed by a lake never drain, a river into the sea doesn't raise it, and the sea stays asleep. Ponds and rivers are never sources. A lake you flood yourself becomes one; soak or fill it down and it stops.
  - **Generation:** a sea basin along the world's lowest edge, flooded to 17 m (caves sealed from it stay dry), a highland lake in a bowl on the mountain's flank, and a river carved from the lake to the sea along the cheapest path, with a bed that falls the whole way.
  - **Contoured surface** (new, `fluidSurface.js`, with the flux water): the boundary between air and ground-or-water, traced like the terrain on the grid of voxel centres (surface nets). Water and air in a column cross at the exact level; side by side, where the level run linearly between columns passes; ground and air at the terrain's own crossings, pushed out by the depth of water lying on it. Only faces with water at an end are kept. So lakes and seas are flat and meet the shore, a sheet running down a slope drapes over the ground, and waterfalls, flood fronts, cave water and water against glass are real 3D faces, all from one mesher. Each vertex takes the shallowest water about it, so the surface fades out over its first few centimetres toward its edges.
  - **Cellular meshing** (with the cellular water; on the workers, separately from the ground, at most 10 times a second per chunk): only the surface. Corner heights average the water around them, so the surface is continuous, with smooth normals and per-corner flow. It carries on over the smooth ground beside it and the depth test clips it there, so the shoreline follows the terrain exactly. Level stretches merge into big quads. Walls only where water drops away or meets glass. Every vertex knows how deep the water under it is, and the surface fades in from 8 to 18 cm deep. Shallower water (shallows, shores, water running down slopes and over ledges) is drawn by the ground's own shader instead, as a wet, glossy, tinted film with streaks running downhill, so it follows the smooth ground exactly and never shows the voxel grid. Water in mid-air isn't drawn at all.
  - **Look:** sky reflection by Fresnel and sun glints. Small waves are gradient noise with exact slopes, carried along the flow and drawn out along it the faster it runs (per 2.5 m tile, each turned about its own centre, so a bending current never shears the pattern into lines), faded out where they'd be finer than a pixel. Steep and falling water gets streaks pouring down it, and fast shallow water or water down anything steep turns white. Under shader lighting the water is drawn in a pass of its own over a copy of the scene and its depth: refraction (only of what's actually under the water), absorption by how far the view runs through it (clear shallows, deep blue-green), and a shore that fades out over the last few centimetres of depth, so it's one soft, exact line wherever the ground meets the water. Caustics and wet darkening on the ground under the water (`src/render/waterHeight.js`). Under water the view is tinted and fogged.
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
| `src/world/` | `World` (voxel storage: materials, shape states, terrain hermite data, plants), shapes, plants, CSG, edit rules, generation, trees, materials, noise; water: fluids, simulation, sources, sea/lake/river generation |
| `src/mesh/` | mesher (exact pieces + dual-contoured terrain, per render pass), foliage mesher, water mesher, worker |
| `src/render/` | procedural textures and their texture array, shared lighting, chunk and foliage materials, sun shadow, chunk mesh manager (BVH raycasts), water material, water height texture, splashes |
| `src/items/` | item registry (tools, plants, material × shape), interaction and in-world previews |
| `src/player/` | first-person walk/fly/swim and collision |
| `src/ui/` | hotbar, inventory, code-drawn icons |
| `legacy/` | the shelved hybrid design |

In dev builds, `window.demo` exposes the world, water (`fluid`, `core`), player, interaction, hotbar and HUD in the console.
