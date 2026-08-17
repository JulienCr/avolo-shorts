import { builtinModules } from "node:module";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// La liste des modules natifs vient de Node lui-même, pas d'une énumération
// écrite à la main. Une liste tenue à la main est fausse le jour où on l'écrit
// — la première version de cette règle laissait passer `dns`, `tls`, `http2` et
// `dgram` — et elle repérime à chaque version de Node. Les entrées en `_` sont
// des internes dépréciés, sans intérêt ici.
const MODULES_NATIFS = builtinModules.filter((m) => !m.startsWith("_"));

// Ce qui atteint le réseau ou le navigateur sans passer par un `import`, donc
// sans que `no-restricted-imports` n'en voie jamais rien. `fetch` est un global
// depuis Node 18 : sans cette liste, `src/core` peut faire des requêtes tout en
// passant un lint qui se présente comme une garantie de pureté.
const GLOBAUX_INTERDITS = [
  { name: "fetch", message: "src/core ne fait pas de réseau : l'appel vit dans src/server." },
  { name: "XMLHttpRequest", message: "src/core ne fait pas de réseau." },
  { name: "WebSocket", message: "src/core ne fait pas de réseau." },
  { name: "EventSource", message: "src/core ne fait pas de réseau." },
  {
    name: "process",
    message: "src/core ignore l'environnement : passer la valeur en argument depuis src/server.",
  },
  { name: "window", message: "src/core n'est pas de l'interface." },
  { name: "document", message: "src/core n'est pas de l'interface." },
  { name: "navigator", message: "src/core n'est pas de l'interface." },
  { name: "localStorage", message: "src/core ne stocke rien lui-même." },
  { name: "sessionStorage", message: "src/core ne stocke rien lui-même." },
  // Des globaux de Node que la liste blanche des imports ne peut pas voir,
  // puisqu'ils n'en passent par aucun. `Buffer` est un objet de plateforme ; une
  // temporisation dans du calcul pur signale toujours que le code s'est trompé
  // d'étage.
  { name: "Buffer", message: "src/core manipule des données, pas des tampons Node." },
  ...["setTimeout", "setInterval", "setImmediate", "queueMicrotask"].map((name) => ({
    name,
    message: "src/core est du calcul : rien à y différer. L'ordonnancement vit dans src/server.",
  })),
  // Les trois portes dérobées vers tout ce qui précède : `no-restricted-globals`
  // ne contrôle que l'identifiant nu, donc `globalThis.fetch(...)`,
  // `global.fetch(...)` et `self.fetch(...)` passaient la liste entière.
  // `src/core` étant du calcul, il n'a aucune raison de nommer l'objet global —
  // l'interdire ferme la porte plutôt que de la surveiller.
  ...["globalThis", "global", "self"].map((name) => ({
    name,
    message: "src/core n'a rien à demander à l'objet global : passer la valeur en argument.",
  })),
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  // La frontière de pureté de `src/core/`.
  //
  // Tout ce qui décide quelque chose vit dans `src/core/` et doit rester
  // testable sans GPU, sans ffmpeg, sans vidéo et sans réseau. C'est la leçon
  // d'OpenShorts, dont le `main.py` importe `torch` au chargement : tout ce
  // qu'il contient est devenu intestable, et son CI n'a jamais tourné une seule
  // fois. La règle est en `error`, pas en `warn` — un avertissement qu'on peut
  // ignorer n'est pas une frontière.
  //
  // Un motif de `group` couvre déjà ses sous-chemins — vérifié en le mesurant :
  // `node:*` attrape `node:fs/promises` et `fs` attrape `fs/promises`. Inutile
  // donc de doubler chaque entrée en `x` et `x/*` ; la liste tient à plat.
  //
  // `tests/core/purete.test.ts` vérifie tout ce qui suit, cas par cas, avec ses
  // contrôles négatifs. Modifier une règle ici sans y passer, c'est la défaire.
  {
    // Toutes les extensions qu'ESLint sait lire, pas seulement `.ts`/`.tsx` :
    // `tsconfig.json` inclut déjà les `.mts`, ce dépôt en utilise un pour
    // Vitest, et un `src/core/x.mts` échappait donc entièrement à la frontière.
    files: ["src/core/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                // Le préfixe `node:` couvre tous les modules natifs d'un coup.
                "node:*",
                // Leurs formes nues restent légales, et sont donc listées une à
                // une — mais par Node, pas par nous.
                ...MODULES_NATIFS,
              ],
              message:
                "src/core doit rester pur : pas d'accès au système. Mettre ça dans src/server.",
            },
            {
              // La liste blanche, et le cœur de la règle.
              //
              // Énumérer les paquets interdits était perdu d'avance : la
              // version précédente nommait `react` et `react-dom` et laissait
              // donc entrer `@base-ui/react`, `@tanstack/react-query`,
              // `@tanstack/react-virtual`, `lucide-react` et `zustand`, tous
              // installés, tous adossés à React. La liste aurait par ailleurs
              // repérimé à chaque dépendance ajoutée.
              //
              // Retourné : `src/core` n'importe que `./` — un fichier de son
              // propre dossier ou dessous —, `@/core/` et `zod`. Tout le reste
              // échoue, y compris ce qui n'existe pas encore. Ouvrir une
              // exception se fait ici, en une ligne, et c'est très bien : cela
              // doit être une décision, pas un réflexe.
              //
              // **`../` est refusé sans exception**, et c'est le seul énoncé qui
              // tienne tout seul. Une liste de dossiers interdits après `../`
              // laissait passer tout ce qu'elle ne nommait pas — dont
              // `../../package.json`, qui sort bel et bien de `src/core`. Et la
              // profondeur à laquelle un `../` quitte `src/core` dépend du
              // fichier qui l'écrit, donc aucune regex ne peut la deviner.
              // D'où la convention : `./voisin` à l'intérieur d'un dossier,
              // `@/core/...` pour tout le reste de `src/core`.
              regex: "^(?!\\./|@/core/|zod(?:/|$))",
              message:
                "src/core n'importe que ./ (son propre dossier), @/core/ et zod. Pas de `../` : utiliser @/core/. Next, React, les SDK, l'UI et le stockage vivent dans src/server.",
            },
            {
              // Les chemins non normalisés, qui rendaient les deux motifs
              // précédents contournables : ils lisent le spécificateur brut, pas
              // la cible résolue. `@/core/../server/db` commence par `@/core/`
              // et `./../server/db` ne commence pas par `../` — les deux
              // désignent pourtant `src/server/db`.
              //
              // Le motif : un segment qui n'est pas `..`, suivi de `/..`.
              //
              // `[^/]*` et non `[^/]+`, et `/+` et non `/` : le segment peut
              // être **vide**. `@/core//../server/db` garde le préfixe autorisé,
              // TypeScript normalise le double séparateur, et la cible est bien
              // `src/server/db` — un `[^/]+` exigeait un segment nommé et
              // laissait donc passer exactement cette forme.
              regex: "(^|/)(?!\\.\\.(?:/|$))[^/]*/+\\.\\.(?:/|$)",
              message:
                "Chemin non normalisé : un `..` après un segment nommé masque la cible réelle. Écrire le chemin direct.",
            },
          ],
        },
      ],

      // `no-restricted-imports` ne voit pas les imports dynamiques : un
      // `await import('node:fs')` glissé au fond d'une fonction passe la liste
      // ci-dessus sans un mot. Or c'est précisément par là que la frontière
      // s'érode. `src/core` étant du calcul, il n'a aucune raison de charger
      // quoi que ce soit tardivement : on interdit la forme entière.
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message:
            "src/core ne charge rien dynamiquement : un import différé est un import quand même.",
        },
        {
          selector: "CallExpression[callee.name='require']",
          message: "src/core ne charge rien dynamiquement. Utiliser un import statique.",
        },
        // `require` ne se nomme pas toujours tout seul. Les `.cjs` sont couverts
        // par cette frontière, et `module.require('node:fs')` comme
        // `require.call(null, 'node:fs')` chargent réellement le module en
        // passant le sélecteur ci-dessus. On vise donc le nom partout où il
        // apparaît, en objet comme en propriété.
        {
          selector: "MemberExpression[object.name=/^(require|module)$/]",
          message: "src/core ne charge rien dynamiquement. Utiliser un import statique.",
        },
        {
          selector: "MemberExpression[property.name='require']",
          message: "src/core ne charge rien dynamiquement. Utiliser un import statique.",
        },
      ],

      // Les globaux. Un import n'est pas la seule porte : `fetch` sort sur le
      // réseau et `process.env` fait dépendre un calcul de l'environnement qui
      // l'exécute — donc le rend irreproductible en test. Ni l'un ni l'autre
      // n'apparaît dans une liste d'imports.
      "no-restricted-globals": ["error", ...GLOBAUX_INTERDITS],
    },
  },

  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
