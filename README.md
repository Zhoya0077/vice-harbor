# Vice Harbor

A top-down open-world city crime game in plain canvas 2D. No libraries, no build step, no network:
`game/index.html` loads `game/src/main.js` as an ES module and everything else is static files.

You get one five-minute shift in a city that does not care whether you finish it. Take phone jobs,
steal what you need to take them, and keep the cash — the police will have opinions.

## Play it

```
node serve.ts                 # serves game/ on http://localhost:8080
```

Open <http://localhost:8080>. Sound needs a click or a key press first; `M` mutes it.

## Controls

| Key | Action |
| --- | --- |
| `WASD` / arrows | walk, and drive (throttle + steering) |
| `Shift` | sprint on foot |
| `E` | enter or leave a car |
| `Space` | handbrake — hold it through a corner to drift |
| `P` / `Esc` | pause |
| `R` | restart the shift |
| `M` | mute |

## What is in it

- A 3200×2400 city: an eight-by-five road grid with lane markings, kerbs and crossings, blocks
  filled with extruded buildings that cast shadows and light their windows after dark, a beach and
  open water along the south edge, palms, crates, barriers, lamps and a pier.
- Four named districts that announce themselves when you cross into them: Palm Heights, Neon Mile,
  Old Market, Harbor Docks.
- Cars you can drive: compact, sports and truck archetypes with their own top speed, acceleration
  and handling. Parked cars, traffic that follows the grid and brakes for obstacles, and a real
  handbrake drift. Cars take damage, smoke, and end up as wrecks.
- A five-star wanted system. Grand theft, ramming cruisers, wrecking cars, hitting pedestrians and
  pulling jobs all raise it. Police spawn at the map edges, chase, ram, and set roadblocks at four
  stars. They lose you when buildings break line of sight; the meter drains, faster if you swap
  cars while unseen. Get cornered on foot and the BUSTED meter fills; lose all your health and the
  shift ends WASTED.
- Three job types on a phone feed: a timed delivery across town, a checkpoint circuit, and a
  scattered cash-drop collection. Each pays on completion, and each one bumps your wanted level.
- A day/night arc: the shift starts at 17:40, runs through sunset into full neon night, with lit
  windows, sodium lamp pools, headlight cones and strobing police lights.
- Synthesised audio only: a WebAudio engine whose pitch tracks your speed, a two-tone siren that
  gets louder as a unit closes in, and stingers for pickups, crashes, completed jobs and the bust.

## Screenshot scenes

The game reads `?shot=start|play|chase|end&seed=N`. Each one builds the world from the seed, plays
the real rules forward under a fixed autopilot, and freezes with `window.__shotReady` set. The same
seed always renders the same frame, which is what `shots.json` and `tools/shots.mjs` rely on.

## Build the entry

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

That copies `game/` and `screenshots/` into the output directory and writes `dossier.json` with the
vendored `buildDossier`, under the same caps the scorer uses.

## Retake the screenshots

```
node tools/shots.mjs
```

Serves the game on port 8901, drives each scene with playwright-core against the Chromium in
`~/workspace/makefun/shot-tools`, writes the four JPEGs into `screenshots/`, and fails the run on
any page error.

## Layout

```
game/index.html        the page: canvas + module script
game/src/main.js       boot, the loop, screens, audio wiring
game/src/config.js     every tuning number and colour
game/src/city.js       the seeded city generator and its collision grid
game/src/car.js        car physics, damage and traffic AI
game/src/world.js      the simulation: player, police, jobs, shift
game/src/render.js     all drawing, HUD and screens
game/src/shots.js      the frozen screenshot scenes
game/src/audio.js      the WebAudio synth
game/src/input.js      keyboard and pointer state
game/src/util.js       geometry and maths
main.ts                stages the entry and writes dossier.json
serve.ts               a static server for game/
tools/shots.mjs        captures shots.json with playwright-core
```
