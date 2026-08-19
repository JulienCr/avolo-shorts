/**
 * Découpage d'un identifiant en mots, pour la classification français/anglais
 * et pour reconstruire un nom traduit dans le même style de casse.
 */

export type CaseStyle = "camel" | "pascal" | "upperSnake" | "lowerSnake" | "other";

/**
 * Unicode-aware comme `splitWords` — `\p{Lu}`/`\p{Ll}` plutôt que `[A-Z]`.
 * Sans ça, un nom qui commence par une majuscule accentuée (`Écran`) ou une
 * minuscule accentuée (`àAdopter`) tombe dans "other", et `joinWords` ne
 * capitalise plus rien entre les mots : "àAdopter" → "to"+"adopt" recomposés
 * en "toadopt" au lieu de "toAdopt".
 */
export function detectCaseStyle(name: string): CaseStyle {
  if (/^\p{Lu}[\p{Lu}0-9_]*$/u.test(name) && name.includes("_")) return "upperSnake";
  if (/^\p{Lu}[\p{Lu}0-9]*$/u.test(name)) return "upperSnake";
  if (/^\p{Ll}[\p{Ll}0-9]*(_[\p{Ll}0-9]+)+$/u.test(name)) return "lowerSnake";
  if (/^\p{Lu}/u.test(name)) return "pascal";
  if (/^[\p{Ll}_$]/u.test(name)) return "camel";
  return "other";
}

/**
 * Un `_`/`$` de tête (paramètre volontairement inutilisé, convention
 * jQuery/RxJS...) porte un sens et doit survivre à la traduction : `_cas` doit
 * rendre `_case`, pas `case`. Extrait ce préfixe pour que l'appelant le
 * recolle après `joinWords` — `splitWords` et `detectCaseStyle` travaillent
 * tous les deux sur le nom une fois ce préfixe ôté.
 */
export function splitLeadingUnderscorePrefix(name: string): { prefix: string; rest: string } {
  const m = /^[_$]+/.exec(name);
  return m ? { prefix: m[0], rest: name.slice(m[0].length) } : { prefix: "", rest: name };
}

/**
 * Découpe camelCase/PascalCase/UPPER_SNAKE/snake_case en mots minuscules.
 *
 * Unicode-aware (`\p{Ll}`/`\p{Lu}`) : un identifiant comme `livraisonÀJour`
 * a sa majuscule accentuée en `À`, que `[A-Z]` ne voit pas. Une frontière de
 * casse manquée fusionne deux mots (`àjour` au lieu de `à` + `jour`) et casse
 * la reconstruction du nom traduit.
 */
export function splitWords(name: string): string[] {
  const stripped = name.replace(/^[_$]+/, "");
  const withBoundaries = stripped
    .replace(/([\p{Ll}0-9])(\p{Lu})/gu, "$1_$2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1_$2")
    .replace(/(\p{L})([0-9])/gu, "$1_$2")
    .replace(/([0-9])(\p{L})/gu, "$1_$2");
  return withBoundaries
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function hasAccent(name: string): boolean {
  return name.normalize("NFC") !== stripAccents(name.normalize("NFC"));
}

/** Reconstruit un identifiant à partir de mots anglais, dans le style donné. */
export function joinWords(words: string[], style: CaseStyle): string {
  const clean = words.filter(Boolean);
  switch (style) {
    case "camel":
      return clean
        .map((w, i) => (i === 0 ? w : capitalize(w)))
        .join("");
    case "pascal":
      return clean.map(capitalize).join("");
    case "upperSnake":
      // Une entrée du dictionnaire peut être elle-même composée
      // ("giveUp", "notFound") : en camelCase/PascalCase la casse interne
      // suffit à la lire, mais en *_SNAKE* il faut le séparateur, sinon
      // "renoncement" → "giveUp" rend "GIVEUP" au lieu de "GIVE_UP".
      return clean
        .flatMap((w) => splitWords(w))
        .map((w) => w.toUpperCase())
        .join("_");
    case "lowerSnake":
      return clean
        .flatMap((w) => splitWords(w))
        .map((w) => w.toLowerCase())
        .join("_");
    default:
      return clean.join("");
  }
}

function capitalize(w: string): string {
  if (w.length === 0) return w;
  // Garder les sigles déjà tout en majuscules (ex. "id", "url", "ffmpeg" -> non,
  // mais "id" -> "Id" est la forme voulue en camelCase interne).
  return w[0].toUpperCase() + w.slice(1);
}
