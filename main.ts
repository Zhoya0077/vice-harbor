// Vice Harbor — the entry program (Node 22+, standard library only, no build step).
//
// The deliverable is game/: plain static files that a desktop browser loads offline, with
// game/index.html pulling game/src/main.js as an ES module and no library, no bundler and no
// network request involved. This program stages that folder for the judge:
//
//   1. copy game/ beside the output, so the playable build ships with the entry;
//   2. copy screenshots/ beside it, the four JPEG stills the dossier points at;
//   3. write dossier.json with vendor/makefun-game.ts buildDossier(), passing the same caps the
//      scorer's gate.json uses, so an entry the scorer would reject fails here first instead.
//
// Play it locally with `node serve.ts` and open http://localhost:8080.
// Outside the grading container, MAKEFUN_OUTPUT_DIR stands in for /output:
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

/** The entry's own directory; everything below is resolved from here, never from the cwd. */
const home = fileURLToPath(new URL('.', import.meta.url));

/** The grader's /output, or a local stand-in for a dry run. */
const output = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The gate's limits (reference/gate.json). Only text_max_bytes trims bytes; the rest refuse. */
const CAPS = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
};

function stage(source: string, target: string): boolean {
  if (!existsSync(source)) return false;
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true });
  return true;
}

mkdirSync(output, { recursive: true });

// game/ is the whole game; screenshots/ is optional so a dry run without stills still works.
stage(join(home, 'game'), join(output, 'game'));
stage(join(home, 'screenshots'), join(output, 'screenshots'));

const dossier = buildDossier(output, CAPS);
writeFileSync(join(output, 'dossier.json'), dossier);
console.log(`Vice Harbor staged in ${output} (${dossier.length} bytes of dossier)`);
