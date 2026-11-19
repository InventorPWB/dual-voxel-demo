# Dual Voxel Demo

A small three.js prototype of a hybrid voxel sandbox. Smooth sculptable terrain and crisp Minecraft-style blocks live in **one voxel grid** and come out of **one mesher**.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # mesher tests
```

## How it works

- **One representation** (after Roblox's terrain). Every voxel is two bytes: material + occupancy (0–255, with the surface at 0.5). Edits overwrite voxels; there are no separate terrain and building layers.
  - The occupancy byte is always the **terrain field**.
  - A **block material** (planks, brick, stone brick, cobble) means the voxel is also a full unit cube. Its occupancy byte keeps carrying the terrain field through the block.
- **Meshing** (`src/mesh/surfaceNets.js`). Both passes read the same voxels:
  - **Blocks:** exact cube faces with Minecraft-style corner AO. They never deform.
  - **Terrain:** naive surface nets over the field. Terrain runs smoothly into a block and is hidden behind its faces, giving a clean intersection line. Terrain lying entirely inside blocks is dropped, and blocks get a small polygon offset so their faces always win.
  - **Terrain shading:** normals come from the gradient of the trilinear field, and AO from sampling that field along the normal. Shading doesn't depend on where a vertex sits in the grid, so slopes shade without banding.
- **Edits keep the field smooth** (`src/world/edits.js`). The field ramps over ~2.5 voxels around the surface. If edits pushed voxels straight to 0 or 255, the mesher would see hard steps and terrain would turn faceted. So every terrain edit is smooth CSG with a sphere of the same slope: union to add, subtraction to remove. Held brushes move the surface at a capped speed (3 m/s), so it can't run away toward the camera. The tests check that no edit creates a step steeper than the ramp.

| Interaction | Behaviour |
|---|---|
| Sculpt raise/dig | Smooth sphere union/subtraction the size of the brush |
| Build with a terrain material | Adds (RMB) or removes (LMB) a small smooth lump |
| Blocks vs brushes | Blocks are barriers: a brush only reaches voxels connected to where you aimed through non-block space, so it can't pass through a wall. It never changes the terrain stored inside a block |
| Raising terrain against blocks | Terrain meets the block's faces and stops there; exposed faces stay crisp |
| Brushes near the player | Terrain never becomes solid within half a voxel of the player's box; it grows around you instead |
| Leftover specks | After each edit, tiny disconnected bits of terrain (≤ 12 voxels, not touching blocks or bedrock) in the edited area are dissolved |
| Place a block on terrain | Field lifted just enough that the ground meets the block's base (no gap) |
| Remove a block resting on terrain | The lift is undone; the ground below is untouched |
| Remove a block buried in terrain | Leaves a rounded pocket where the block was |
| Paint | Block materials repaint blocks; terrain materials repaint terrain |
- **Collision** (`src/player/Player.js`) is a capsule against the rendered chunk meshes (terrain and blocks) via their BVHs.
  - You stand on the surface you see, and you slide along walls.
  - Walkable slopes (up to ~53°) push you straight up, so you don't slide while standing.
  - 1-block ledges are stepped up with a downward probe ahead of you.
  - Downhill walking snaps to the ground with a ray.
  - A safety net lifts you out if you ever end up inside the ground.
- **Chunks.** 32³ chunks, meshed on web workers from a copy padded by 4 voxels. Seams between chunks match exactly; the tests check this.

## Layout

| Path | What |
|---|---|
| `src/world/` | `World` (chunk grid, get/set, dirty tracking), generation, materials, noise |
| `src/mesh/` | mesher + worker |
| `src/render/` | procedural textures, triplanar shader, chunk mesh manager (BVH raycasts) |
| `src/player/` | first-person walk/fly, collision, step-up |
| `src/tools/` | Build, Sculpt, Smooth, Flatten, Paint + gizmos |
| `src/ui/` | HUD |

In dev builds, `window.demo` exposes the world, player and tools in the console.
