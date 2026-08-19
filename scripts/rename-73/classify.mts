/**
 * Classe chaque candidat de collect.mts : a-t-il besoin d'être renommé, et
 * vers quoi ? Un mot se traduit via ACCENT_SENSITIVE_OVERRIDES (sur sa forme
 * accentuée) puis FR_TO_EN (sur sa forme sans accent). Un mot d'une seule
 * lettre n'est jamais un candidat à la traduction — abréviation ou variable
 * de boucle, jamais un mot français porteur de sens.
 *
 * Ne modifie rien : produit, par candidat, soit un nom proposé soit un motif
 * de non-résolution (au moins un mot n'est ni glue, ni dans le dictionnaire,
 * ni anglais reconnu). table.mts consomme cette classification et arbitre le
 * résidu identifiant par identifiant.
 */
import { collectCandidates, type Candidate } from "./collect.mts";
import {
  detectCaseStyle,
  hasAccent,
  joinWords,
  splitLeadingUnderscorePrefix,
  stripAccents,
} from "./words.mts";
import { ACCENT_SENSITIVE_OVERRIDES, FR_TO_EN } from "./dictionary.mts";

export type WordVerdict =
  | { kind: "kept"; word: string } // mot anglais/neutre, inchangé
  | { kind: "translated"; word: string; to: string }
  | { kind: "dropped"; word: string } // mot-outil, disparaît à la recomposition
  | { kind: "unresolved"; word: string };

export interface Classified extends Candidate {
  needsRename: boolean;
  proposedName: string | null;
  verdicts: WordVerdict[];
  unresolvedWords: string[];
}

/** Un mot d'une lettre n'est jamais traduit : abréviation, pas un mot. */
function isTooShortToJudge(word: string): boolean {
  return word.length <= 1 || /^[0-9]+$/.test(word);
}

function classifyWord(word: string): WordVerdict {
  // Un mot d'une lettre est jamais jugé français — SAUF s'il porte un
  // accent : l'anglais de ce dépôt n'accentue rien, donc un « à » ou un « é »
  // isolé est déjà, à lui seul, la preuve qu'il faut le traduire. Sans ce
  // garde-fou, un identifiant réduit à ce seul caractère (un paramètre nommé
  // juste "à") se voit classé "kept" par défaut de longueur et échappe donc
  // entièrement au renommage malgré son accent.
  if (isTooShortToJudge(word) && !hasAccent(word)) return { kind: "kept", word };

  const accentOverride = ACCENT_SENSITIVE_OVERRIDES[word.toLowerCase()];
  if (accentOverride !== undefined) {
    return accentOverride === ""
      ? { kind: "dropped", word }
      : { kind: "translated", word, to: accentOverride };
  }

  const stripped = stripAccents(word).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(FR_TO_EN, stripped)) {
    const to = FR_TO_EN[stripped];
    if (to === "") return { kind: "dropped", word };
    // Un mot du dictionnaire qui se traduit vers lui-même (mots cognats :
    // "video", "schema"...) : gardé tel quel, mais reconnu comme statué —
    // pas un résidu. Sinon, la traduction s'applique réellement.
    if (to.toLowerCase() === word.toLowerCase()) return { kind: "kept", word };
    return { kind: "translated", word, to };
  }

  // Le mot porte un accent mais n'est dans aucun des deux dictionnaires :
  // c'est un résidu à traiter à la main dans table.mts, jamais un mot
  // anglais — l'anglais de ce dépôt n'accentue rien.
  if (hasAccent(word)) return { kind: "unresolved", word };

  // Sans accent et hors dictionnaire : on suppose l'anglais par défaut.
  // C'est la moitié fragile du balayage (issue #73) — table.mts la corrige
  // à la main sur la base d'une lecture, pas d'une règle mécanique.
  return { kind: "kept", word };
}

function wordTranslation(v: WordVerdict): string | null {
  switch (v.kind) {
    case "kept":
      return v.word;
    case "translated":
      return v.to;
    case "dropped":
      return null;
    case "unresolved":
      return null;
  }
}

/** Le mot original d'un verdict "dropped", en minuscules — pour distinguer
 * quel mot-outil a disparu (seuls "de"/"du"/"des" déclenchent le
 * réordonnancement ci-dessous ; "sans", "avec", "sur"... gardent l'ordre). */
function droppedGlueWord(v: WordVerdict): string | null {
  return v.kind === "dropped" ? stripAccents(v.word).toLowerCase() : null;
}

const REORDER_TRIGGERS = new Set(["de", "du", "des"]);

/**
 * Le français postpose son complément de nom (« barre de recherche »),
 * l'anglais l'antépose (« search bar »). Un « de »/« du »/« des » qui relie
 * exactement deux groupes de mots est le signal mécanique de ce patron : le
 * composé traduit mot à mot dans l'ordre d'origine (« barSearch ») sonne
 * faux, l'inverser (« searchBar ») sonne juste. On ne le fait que pour un
 * lien unique et non ambigu — plusieurs « de » dans le même identifiant, ou
 * un lien en bord de mot, ne sont pas ce patron et restent dans l'ordre
 * d'origine plutôt que de risquer un réordonnancement à trois blocs, qu'aucun
 * identifiant observé ici n'appelle.
 */
function reorderAroundDeLink(verdicts: WordVerdict[]): WordVerdict[] {
  const glueIndices = verdicts
    .map((v, i) => ({ i, glue: droppedGlueWord(v) }))
    .filter((x) => x.glue !== null && REORDER_TRIGGERS.has(x.glue));
  if (glueIndices.length !== 1) return verdicts;
  const idx = glueIndices[0].i;
  if (idx === 0 || idx === verdicts.length - 1) return verdicts;
  const before = verdicts.slice(0, idx);
  const after = verdicts.slice(idx + 1);
  return [...after, ...before];
}

export function classify(candidate: Candidate): Classified {
  const verdicts = candidate.words.map(classifyWord);
  const unresolvedWords = verdicts.filter((v) => v.kind === "unresolved").map((v) => v.word);

  const anyTranslatedOrUnresolved = verdicts.some(
    (v) => v.kind === "translated" || v.kind === "unresolved" || v.kind === "dropped"
  );
  const needsRename = candidate.hasAccent || anyTranslatedOrUnresolved;

  let proposedName: string | null = null;
  let allWordsDropped = false;
  if (needsRename && unresolvedWords.length === 0) {
    // Un "_"/"$" de tête (paramètre volontairement inutilisé) porte un sens
    // et doit survivre : détecter le style et recomposer sur le nom une fois
    // ce préfixe ôté, puis le recoller — sinon "_cas" perd son "_" en route,
    // et pire, sa présence fait passer detectCaseStyle en "camel" sans que
    // joinWords ne capitalise le bon mot de départ.
    const { prefix, rest } = splitLeadingUnderscorePrefix(candidate.oldName);
    const style = detectCaseStyle(rest);
    const reordered = reorderAroundDeLink(verdicts);
    const translatedWords = reordered
      .map(wordTranslation)
      .filter((w): w is string => w !== null && w.length > 0);
    if (translatedWords.length === 0) {
      // Chaque mot de l'identifiant s'est dissous en mot-outil (ex. un
      // paramètre nommé juste "de" ou "à", où le mot-outil EST le nom en
      // entier, pas de la glu à l'intérieur d'un composé). Un nom vide n'est
      // pas un renommage valide : on le fait remonter en résidu, pour un
      // choix manuel dans table.mts plutôt qu'une identité effacée.
      allWordsDropped = true;
    } else {
      const candidateName = prefix + joinWords(translatedWords, style);
      proposedName = candidateName === candidate.oldName ? null : candidateName;
    }
  }

  const finalUnresolvedWords = allWordsDropped ? [...candidate.words] : unresolvedWords;

  return {
    ...candidate,
    needsRename:
      (needsRename && proposedName !== null) || finalUnresolvedWords.length > 0,
    proposedName,
    verdicts,
    unresolvedWords: finalUnresolvedWords,
  };
}

function main() {
  const candidates = collectCandidates();
  const classified = candidates.map(classify);

  const toRename = classified.filter((c) => c.needsRename);
  const unresolved = toRename.filter((c) => c.unresolvedWords.length > 0);
  const resolved = toRename.filter((c) => c.unresolvedWords.length === 0);

  process.stderr.write(`candidats totaux : ${candidates.length}\n`);
  process.stderr.write(`à renommer : ${toRename.length}\n`);
  process.stderr.write(`  résolus mécaniquement : ${resolved.length}\n`);
  process.stderr.write(`  non résolus (mot hors dictionnaire) : ${unresolved.length}\n`);

  process.stdout.write(JSON.stringify(classified, null, 2));
}

if (process.argv[1]?.endsWith("classify.mts")) {
  main();
}
