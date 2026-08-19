/**
 * CLI fine autour de collect.mts : imprime le JSON brut des candidats sur
 * stdout. Utile pour inspecter le balayage sans repasser par table.mts.
 *
 *     pnpm tsx scripts/rename-73/scan.mts > /tmp/candidates.json
 */
import { collectCandidates } from "./collect.mts";

const candidates = collectCandidates();
process.stdout.write(JSON.stringify(candidates, null, 2));
process.stderr.write(
  `\n${candidates.length} identifiants déclarés collectés (dédupliqués par symbole).\n`
);
