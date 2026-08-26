import { builtinModules } from "node:module";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import globals from "globals";

// La liste des modules natifs vient de Node lui-même, pas d'une énumération
// écrite à la main. Une liste tenue à la main est fausse le jour où on l'écrit
// — la première version de cette règle laissait passer `dns`, `tls`, `http2` et
// `dgram` — et elle repérime à chaque version de Node. Les entrées en `_` sont
// des internes dépréciés, sans intérêt ici.
const MODULES_NATIFS = builtinModules.filter((m) => !m.startsWith("_"));

// Les globaux : ce qui atteint la plateforme sans passer par un `import`, donc
// sans que `no-restricted-imports` n'en voie jamais rien. `fetch` est un global
// depuis Node 18 ; `indexedDB` et `Worker` sont typés par le `lib: ["dom", …]`
// du projet. Aucun ne s'annonce.
//
// **Énoncé à l'envers, comme les imports.** Les quatre versions précédentes de
// cette liste étaient des listes noires, et chaque passe de review en a trouvé
// une de plus qui manquait : `fetch`, puis `globalThis`, puis `self`, puis
// `Buffer` et les temporisations, puis `indexedDB` et `Worker`. Une liste noire
// de globaux ne peut pas être complète — il y en a plus de mille.
//
// Ce qui reste autorisé est donc l'ECMAScript nu — `Math`, `JSON`, `Promise`,
// `Number`… — plus `console`, seul global de plateforme dont l'usage ne
// compromet ni la testabilité ni le résultat d'un calcul. Tout le reste de
// `browser` et de `nodeBuiltin` est refusé, y compris ce que la prochaine
// version de Node ajoutera.
const GLOBAUX_PURS = new Set([...Object.keys(globals.es2023), "console"]);
// `globalThis` est dans la liste ECMAScript, mais c'est la porte dérobée vers
// tout le reste : `globalThis.fetch(...)` ne référence pas `fetch`.
GLOBAUX_PURS.delete("globalThis");

const GLOBAUX_INTERDITS = [
  ...new Set([
    ...Object.keys(globals.browser),
    ...Object.keys(globals.nodeBuiltin),
    // Les alias de l'objet global et les noms CommonJS, que ni `browser` ni
    // `nodeBuiltin` ne déclarent tous.
    "globalThis",
    "global",
    "self",
    "require",
    "module",
    "exports",
    "__dirname",
    "__filename",
  ]),
]
  .filter((name) => !GLOBAUX_PURS.has(name))
  .map((name) => ({
    name,
    message:
      "src/core n'utilise que l'ECMAScript nu : ni réseau, ni stockage, ni environnement, ni interface. Ce global vit dans src/server.",
  }));

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
        // Et le nom lui-même, parce qu'on peut le recopier avant de s'en servir :
        // `const load = require; load('node:fs')` ne présente ni `callee.name`
        // ni membre. Un `.cjs` de `src/core` n'est pas non plus contrôlé par
        // `tsc`, donc le lint est le seul filet.
        {
          selector: "Identifier[name=/^(require|module|exports)$/]",
          message:
            "src/core est du module ES : ni `require`, ni `module`, ni `exports`, même recopiés.",
        },
        // JSX. Les extensions `.tsx`/`.jsx` doivent rester couvertes par la
        // frontière — sinon un fichier y échappe entièrement — mais avec
        // `jsx: "react-jsx"`, `export const C = () => <div />` ne contient ni
        // import ni global interdit : TypeScript injecte `react/jsx-runtime`
        // après le lint. De l'interface entrerait dans src/core sans un mot.
        {
          selector: "JSXElement, JSXFragment",
          message:
            "src/core n'est pas de l'interface : un composant vit dans src/components ou src/app.",
        },
      ],

      // Les globaux. Un import n'est pas la seule porte : `fetch` sort sur le
      // réseau et `process.env` fait dépendre un calcul de l'environnement qui
      // l'exécute — donc le rend irreproductible en test. Ni l'un ni l'autre
      // n'apparaît dans une liste d'imports.
      "no-restricted-globals": ["error", ...GLOBAUX_INTERDITS],
    },
  },

  // Le tamis (issue #191 lot 5) construit son déterminisme sur un hachage par
  // élément — `Math.random()` y romprait la reproductibilité que l'issue
  // exige (deux planches à trois semaines d'écart doivent être comparables),
  // et une graine seedée qui marche la liste la romprait tout autant au
  // premier plan ajouté au corpus. Interdit ici, mécaniquement.
  {
    files: ["scripts/framing/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message:
            "Math.random() est interdit dans scripts/framing/** : utiliser le hachage par élément (voir sieve.ts).",
        },
      ],
    },
  },

  // Le garde-fou de l'issue #73 : aucun identifiant accentué neuf.
  //
  // `id-match` sur un motif ASCII attrape mécaniquement toute la classe des
  // identifiants qui portent un accent — `é`, `à`, `ç`… — au moment où ils
  // sont déclarés, pas seulement au moment où quelqu'un les relit.
  //
  // Cadrée pour ne mordre que sur ce que le dépôt contrôle :
  //
  //   - `onlyDeclarations: true` — ne vérifie que les déclarations
  //     (variables, fonctions) et, indépendamment de cette option, les
  //     noms locaux d'import et les noms liés par déstructuration. Elle ne
  //     touche donc jamais un accès de propriété (`obj.prop`) ni le nom
  //     d'une propriété d'un objet littéral ou d'une interface — la forme
  //     qu'emprunterait une clé de réponse d'API externe ou un champ imposé
  //     par une dépendance, sur lesquels ce dépôt n'a pas la main.
  //   - `properties: false` — même chose du côté des accès et des clés
  //     d'objet littéral : un champ nommé par une API tierce (JSON, une
  //     lib UI) ne doit pas faire échouer le lint parce que ce dépôt ne
  //     choisit pas ce nom-là.
  //
  // **Ce que la règle ne couvre PAS**, pour que ça ne se lise pas comme
  // « le linter s'en occupe désormais » : recompté depuis
  // `scripts/rename-73/renames-identifiers.tsv` (paires (old_name,
  // new_name) distinctes, en excluant les entrées où old_name === new_name —
  // un identifiant déjà anglais avant le balayage, jamais réellement
  // renommé), sur les **1 574 identifiants renommés par le balayage #73,
  // 467 seulement portaient un accent** — les 1 107 autres étaient du
  // français **sans** accent (`enregistrement`, `parcours`, `montage`…),
  // qu'un motif ASCII ne détecte pas puisqu'ils s'écrivent déjà en ASCII.
  // Cette règle attrape donc mécaniquement **29,7 %** du problème, pas
  // 100 % : le reste demande une lecture, humaine ou outillée (voir
  // `scripts/rename-73/`), pas un motif.
  {
    files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    rules: {
      "id-match": [
        "error",
        "^[A-Za-z_$][A-Za-z0-9_$]*$",
        { onlyDeclarations: true, properties: false },
      ],
    },
  },

  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Le venv de la détection, monté par setup.sh. ESLint n'ignore par défaut
    // que `node_modules`, et matplotlib comme torch livrent du JavaScript dans
    // leurs paquets — six erreurs `no-this-alias` dans du code que personne ici
    // n'a écrit, sur une machine où setup.sh a tourné. La CI ne les voyait pas,
    // faute de venv ; le développeur, si.
    "worker/venv/**",
    // Les worktrees de la flotte d'agents, montés sous `.claude/worktrees/`.
    // Même famille que le venv ci-dessus, et même piège : `.next/**` est ancré
    // à la racine, donc il ne couvre pas un `.next` imbriqué. Un worktree où
    // quelqu'un a lancé `pnpm dev` fait alors remonter des milliers
    // d'avertissements sur du JavaScript généré, et `pnpm lint` sort en échec
    // dans le dépôt principal alors qu'il est vert dans chaque worktree — où
    // les worktrees frères sont hors de la racine. La CI ne le voit jamais,
    // elle part d'un clone propre.
    ".claude/worktrees/**",
  ]),
]);

export default eslintConfig;
