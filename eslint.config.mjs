import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

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
  // Les motifs sont doublés (`x` et `x/*`) parce que la correspondance ne
  // traverse pas les `/` : sans `node:*/*`, `node:fs/promises` passerait.
  {
    files: ["src/core/**/*.ts", "src/core/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "node:*",
                "node:*/*",
                "fs",
                "fs/*",
                "path",
                "path/*",
                "child_process",
                "os",
                "crypto",
                "worker_threads",
                "stream",
                "stream/*",
                "http",
                "https",
                "net",
                "url",
                "util",
              ],
              message:
                "src/core doit rester pur : pas d'accès au système. Mettre ça dans src/server.",
            },
            {
              group: [
                "next",
                "next/*",
                "next/**",
                "react",
                "react/*",
                "react-dom",
                "react-dom/*",
                "@/server",
                "@/server/*",
                "@/server/**",
                "@/app",
                "@/app/*",
                "@/app/**",
                "@/components",
                "@/components/*",
                "@/components/**",
                "better-sqlite3",
                "@google/genai",
                "@google/genai/*",
              ],
              message:
                "src/core ne dépend ni de Next, ni de React, ni du serveur, ni d'un SDK réseau.",
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

      // Lire `process.env` depuis `src/core` rendrait un calcul dépendant de
      // l'environnement qui l'exécute — donc non reproductible en test. La
      // configuration se résout dans `src/server` et se passe en argument.
      "no-restricted-globals": [
        "error",
        {
          name: "process",
          message:
            "src/core ignore l'environnement : passer la valeur en argument depuis src/server.",
        },
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
  ]),
]);

export default eslintConfig;
