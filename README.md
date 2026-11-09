# Map Maker 2D — standalone HTML

A browser version of the Unity Map Maker. **Double-click `index.html`** (works from `file://`, no server, no
internet, no build step). Paint a **grid of land squares** that mesh into coastline, draw **custom rivers**, drop the 868 sprites on top as
**stickers**, then press **✓ Finish & Download PNG**.

## Workflow
1. Pick a sprite in the **Palette** (left): biome tabs with counts, ★ favourites (hover a thumbnail → ☆), Recent,
   search (`swamp`, `alp 01`, `features`…), thumbnail size, names, Random (R), "Shuffle on place".
2. Tools (top bar): **Select (S)**, **Place (P)** with a ghost preview, **Scatter brush (B)**, **Eraser (D)**.
3. **Right panel**: selected stamp (position, rotation, scale, opacity, flip, sorting layer, order,
   type, and per-stamp Auto/On/Off for shadow/foam/feather, plus duplicate/delete), brush settings, map settings
   (name, size presets or custom W×H, Ocean / Grass / Solid colour / Transparent background) and effects.
4. **Finish & Download PNG**: renders the whole map frame at full resolution (0.5×, 1× or 2×, optionally with a
   transparent background and with or without effects). It shows a preview, then downloads `map-YYYYMMDD-HHMM.png`.

Work is **autosaved** to this browser's localStorage. On first run the example map ("Sample Archipelago") is loaded.

## Mouse & keys
| | |
|---|---|
| Click / drag | place · select / move · box-select on empty space (Shift/Ctrl adds) |
| Corner squares / round knob | scale / rotate selection (Shift = snap to 15° / 0.1) |
| Wheel, + − , F, 0 | zoom · fit · 100 % |
| Space-drag, middle or right drag | pan |
| Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z | undo / redo (one step per stroke) |
| Delete, Ctrl+D, Ctrl+A | delete · duplicate · select all |
| [ ] | scale selection/brush; brush radius for Scatter/Erase (Shift+[ ] = density) |
| , . | rotate selection or brush CCW / CW (step set in Select tool card) |
| M, Shift+M | flip X / Y |
| arrows, PgUp/PgDn | nudge (Shift ×10, grid when snapping) · draw order (Shift = front/back) |
| G, R, Esc, Ctrl+S, ? | snap · random sprite · select tool/clear · save JSON · help |
| K, Enter, Esc | Smart Fill tool · apply the preview · cancel the preview / lasso |
| L | Land squares tool (Alt-drag erases, [ ] brush size) |
| V, Enter / double-click, Esc | River tool · finish the river · deselect |
| Shift+click, Ctrl+click, Del, [ ] | (River) insert a point · start a branch · delete a point · width of the selected point |

## Land squares (L) — grid terrain
The map has a square grid (cell size 0.1–2 units; default 0.32, set under **Map → Land grid**). Every square is one
type: **Deep water, Shallow water, Sand, Grass, Dirt, Forest, Swamp, Ice, Rock, Lava**. The squares are *not* drawn as
hard blocks. Neighbouring squares **mesh together**: the edges are blended and noise-warped into natural coastline. Land
next to water gets a **sandy rim and white foam**, and the shallows fade out into the textured deep ocean, as in your
reference image. Transitions between land types are blended too.

* Modes: **Paint** (square or round brush, 1–24 squares), **Rect**, **Fill** (flood), **Island** (drag a box to
  generate a natural island with peaks and forest), **Pick**. **Alt**-drag erases back to deep water.
* **Smart Fill (land)** buttons:
  * **Connect** joins separate islands with winding land bridges (bridge width and curve are adjustable).
  * **Grow** / **Erode** expand or shrink the coast with a rough edge.
  * **Smooth** removes jaggies.
  * **Beaches** adds sand on the coast.
  * **Islands** scatters new islands over the whole map or a selection.
  * **Stickers** decorates the land with your Features/Peaks sprites, picked to suit the land type (forest → trees,
    rock/ice → peaks, lava → Ashlands…). It keeps them off beaches and rivers. Re-run it for a new layout.
  * **Clear** empties the grid.
* **Coast look**: rim width, foam width and strength, edge noise, shallows, variation scale and seed.
* Preview quality is **auto**: the editor renders 256 px chunks in Web Workers and caches them. The export always
  renders at full quality.

## River maker (V) — custom rivers
Click to add points, then press **Enter** or double-click to finish. You can **drag** points, **Shift+click** a segment to
insert a point, **Ctrl+click** a river to start a **branch** from it, use **[ ]** to change the width of the selected
point, and **Del** to remove it. Every river has its own style:

* Taper at start and end, meander amount and wavelength
* Bank type and width (sand, rock, grass…)
* Water colour: match the ocean, lighter, or a **custom colour** (lava, toxic…)
* Foam, ripples, and a **lake** at the start or end
* Seed

Built-in presets: **Lowland river, Mountain stream, Jungle river, Desert wadi, Lake chain, Lava flow, Canal (straight)**.
**Save as preset…** stores your own presets in the browser. They are also stored in the map JSON. **▦ Carve into land** turns
the rivers into shallow-water squares if you want to edit them as squares. Rivers that reach the sea fade into the
ocean.

Stickers are the old "stamps" (any sprite placed freely on top, with Select/Place/Scatter/Erase and sprite Smart Fill).
In **Finish & Download PNG** the layers are drawn in this order: land squares → rivers → stickers. That order is kept at
0.5×, 1× and 2×, and with a transparent background too.

`examples/land_islands.json` is a sample land + rivers + stickers map that you can open with **Open**.

## Smart Fill for stickers (offline, uses only your sprites)
Smart Fill (**K**) creates connecting terrain out of the sprites you already have. It runs fully offline: no AI service,
no network, no cost. It uses plain geometry with a **seed**, so the same seed and settings always give the same result.
It reads each sprite's shape (main angle, length, width, coverage) and its colour/tags, so **sprites you add are used
automatically**.

* **Connect**: pick 2+ anchor stamps (click them, or box-drag; if none are picked, every Ground/Land/Peaks stamp is used).
  The anchors are linked by a minimum spanning tree (plus optional *Extra links*), and each link becomes a wavy noise
  spline. Elongated pieces are laid along it, turned to follow the curve. Styles:
  * **Land**: a land bridge.
  * **Ridge**: land with mountain/ridge pieces on top.
  * **River**: water pieces over land.
  * **Coast**: land with a coastline edge on one side.
  * Options: *Width*, *Density*, *Jitter*, *Curve* and *Features*, which adds small details such as trees, rocks and ponds.
* **Grow**: rings land around the selected stamps, out to a *Radius*, with a ragged noise edge.
* **Fill region**: drag a lasso. The inside fills with Poisson-spaced pieces, big ones in the middle and small ones at the edge.
* **Biome**:
  * *Match* blends from anchor A's biome to anchor B's. A missing piece type is borrowed from another biome.
  * *Pick* uses only the chosen biome, for example your own imported sprites.
* **Preview**: a ghost preview updates live. **Enter**/Apply commits it as one undo step. 🎲 / *Regenerate* re-rolls
  the seed (after applying, this replaces the last generated group in place). *Clear generated* removes every generated stamp.
* Generated stamps carry `genGroup` (`"g1"`, `"g2"`, …) in the JSON. Hand-placed stamps have `""`.
* **Tags**: sprite tags come from `assets/meta.js`, built by `tools/build_assets.py` with `tools/sprite_meta.py`.
  You can override the tags of any sprite in the Selection card (*Fill tags*). In Unity, use `Sprites/_sprite_meta_overrides.json`.

## Plug & play fill — stickers that fit together

Press **✦ Auto-fill** (top bar, or the *Plug & play fill* card) — it works with nothing selected
(everything on the map) or on the selection:

1. **Ocean keying** – the ocean painted inside coast/island stickers is cut out (transparent), so
   no blue rectangles are left; inland ponds and lagoons stay. Masks for the bundled sprites are
   precomputed in `assets/masks.js`; imported sprites get a JS fallback analysis.
2. **Merge into the land grid** – each sticker's land is rasterised into the land squares, so all
   stickers + painted squares share **one coastline** with a single foam line and feathered edges.
   Per sticker: *Merge land* Auto / On / Off. Move or delete a sticker and the land follows;
   squares you painted yourself are never lost.
3. **Bridging** – small gaps between pieces close automatically (Bridge gap slider); Auto-fill
   also joins separate islands with land bridges (written into painted squares, undoable).
4. **Fit to neighbours** – while dragging, a sticker snaps when its coastline lines up (green
   dashed box “snap: coastline fits”; hold **Alt** to place freely). **T** / *Fit to neighbours*
   searches rotation, flip and offset. The *Warp* slider bends the art's edges to meet the land.
5. **Variety** – every placement gets a small random hue / saturation / brightness, flip, scale
   and warp (*Variation* slider, *Re-roll*). Land squares have 8 tile variants per type and soft
   borders between land types. **Remix** (selection panel) applies a sticker's shape to another
   texture (grass, sand, forest, 2nd selected sticker…) and saves it to *My Sprites*.

Turn *Plug & play* off in the card to get the old plain-sticker behaviour.

## Importing your own sprites
**⇪ Import** (in the palette footer), or drop images on the page.
* **Transparent PNG/WebP**: each file becomes one sprite.
* **Sprite sheet on white (JPG/PNG)**: cut into pieces in the browser by a port of `Tools~/cut_sheets.py`.
  * The white background is removed with soft edges, and colours are un-mixed from white.
  * *Sheet: Auto* switches to the **dense** cutter when pieces touch. It splits along light shadow gaps and thin bridges.
    Raise *Split* to separate more.
  * Pieces touching the sheet edge (✂) start deselected. Click tiles to toggle them.
* **Biome**: choose an existing biome or **+ New biome…**. *Layer type Auto* guesses Water, Features or Land from the shape and colour.
* Imported sprites are analysed for Smart Fill and stored in the browser (IndexedDB). They appear in the **My Sprites** tab
  and in their biome tab.
* **Sharing**: tick *Embed my imported sprites in saved JSON* (Map card) to carry PNG copies inside the JSON, so the map
  opens on another computer. The Unity window imports the embedded sprites into `Assets/MapMaker/Sprites/<Biome>/`.

## JSON / Unity compatibility
**Save JSON** writes the Unity `MapJson` format, version 3. That is v2 (`MapMaker.MapJson.MapDto`) plus `terrain` (the land grid, run-length encoded),
`rivers` and `riverPresets`. **Open** (or drag a .json onto the page) reads v1, v2 and v3 files. Older files open with no land grid.

* Sprite keys are `Category/name`, e.g. `Coast/coast_01` (the Unity asset path under `Assets/MapMaker/Sprites`).
  `spriteGuid` is left empty; Unity resolves the sprite by key.
* **Coordinates**: positions are Unity world units, **100 px = 1 unit (PPU 100), y is up**. The exported image covers
  the background rectangle `background.size` (units) centred on `background.center`:
  `px = (x − center.x)·100 + W/2`, `py = H/2 − (y − center.y)·100`, where `W = size.x·100` and `H = size.y·100`.
  `rotation` is in degrees, counter-clockwise (it is drawn on the canvas as −rotation).
* Draw order: sorting layer (Default, Ground, Water, Land, Features, Peaks), then `order`, then list order.
  `effects.sortMode = 1` sorts by the stamp's bottom edge instead (lower = in front).
* Effects follow the same rules as Unity's `MapSorting`: per-type masks (`shadowTypes`, `foamTypes`, `featherTypes`),
  per-stamp Auto/On/Off overrides, coast categories skipped for Auto foam/feather, and Auto foam only over open water.

## Rebuilding the embedded sprites
Sprites are embedded as base64 WebP data URIs in `assets/sprites_<Biome>.js`. Each file loads lazily when its tab
(or a map that uses it) needs it. Using data URIs keeps the canvas untainted on `file://`, so PNG export works.
To rebuild them from the Unity project, with Pillow installed, run:

    python tools/build_assets.py ../MapMaker2D/Assets/MapMaker --max 512 --quality 80

The embedded images are downscaled to a maximum of 512 px, but stamps are drawn at their original size.
Smoke tests: `pip install playwright pillow`, then `python tools/test_playwright.py out/` and `python tools/test_smartfill.py out/` (Smart Fill + import).

## Limits
* Smart Fill is procedural placement, not image synthesis. It lays existing sprites edge to edge, so seams between pieces stay
  visible where the sprites' own edges show. Larger *Width*/*Density* gives more overlap and fewer gaps.
* The browser's dense-sheet cutter is lighter than the Python watershed. Counts match closely on the bundled sheets, but a few
  touching pairs may stay joined. Raise *Split*, or deselect them.
* Imported sprites live in this browser's storage. Clearing site data removes them unless they are embedded in a saved JSON.
* Shadows, foam and feather are Canvas approximations of the Unity shaders, so they look close but not pixel-identical.
* Tint RGB is kept in the JSON, but only its alpha (opacity) is rendered.
* Very large exports are capped to the browser's canvas limit (16384 px per side). The info line says when this happens.
* The 35 sprites larger than 512 px are a little softer at 1× (and every sprite is softer at 2×) because the embedded copies are downscaled.
- Plug & play: the land mask is a ~40-cell grid per sprite, so very thin spits may be dropped
  or rounded; bridges use the dominant land type nearby; warp is limited to ~16% of a sticker's
  size; foam/surf painted into the art is treated as water, rocky shallows stay part of the art.
