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
    files: ["src/core/**/*.ts", "src/core/**/*.tsx"],
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
              // Retourné : `src/core` n'importe que ses voisins, `@/core/` et
              // `zod`. Tout le reste échoue, y compris ce qui n'existe pas
              // encore. Ouvrir une exception se fait ici, en une ligne, et
              // c'est très bien : cela doit être une décision, pas un réflexe.
              regex: "^(?!\\.{1,2}/|@/core/|zod(?:/|$))",
              message:
                "src/core n'importe que du TypeScript pur : ses voisins, @/core/ et zod. Next, React, les SDK, l'UI et le stockage vivent dans src/server ou src/components.",
            },
            {
              // Par le chemin relatif, qui désigne les mêmes fichiers. Un motif
              // en `@/server/*` seul ne couvre que l'alias : `../server/db`
              // passait la frontière sans un mot.
              //
              // Une regex plutôt qu'un glob en `**/server/**`, qui attraperait
              // aussi les sous-chemins de vrais paquets — `zod/lib/types`,
              // `firebase/app`. Ancrer sur une remontée `../` ne peut pas
              // désigner node_modules.
              //
              // Ici la liste reste explicite, faute de mieux : la profondeur à
              // laquelle un `../` quitte `src/core` dépend du fichier qui
              // l'écrit, et une regex ne la connaît pas. `../edl` reste donc
              // permis — `captions/retime.ts` en a besoin.
              regex: "^(?:\\.\\./)+(server|app|components|hooks|lib|worker)(?:/|$)",
              message:
                "src/core ne dépend d'aucun autre étage du projet, pas même par un chemin relatif.",
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
