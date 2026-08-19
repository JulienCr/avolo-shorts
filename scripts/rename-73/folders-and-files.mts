/**
 * Les renommages de dossiers et de fichiers — décidés à la main, signalés à
 * part de la table des identifiants (des centaines de lignes plus loin) pour
 * qu'ils ne s'y noient pas. Rien sous `src/app/` : ce sont des routes Next et
 * les fichiers y suivent ses conventions (`page.tsx`, `route.ts`...), déjà en
 * anglais et hors de portée d'un renommage.
 *
 * Les chemins de fichiers sont donnés **après** application des
 * renommages de dossiers : apply.mts les compose dans cet ordre (dossiers
 * d'abord, fichiers ensuite) pour que ces chemins soient corrects.
 */

export const FOLDER_RENAMES: Array<{ from: string; to: string }> = [
  {
    from: "src/components/tri",
    to: "src/components/review",
    // "tri" est le tri des candidats retenus/écartés d'un projet — une
    // file de revue, pas un algorithme de tri générique.
  },
  {
    from: "src/components/parcours",
    to: "src/components/navigation",
    // Seul fichier du dossier : app-bar.tsx, qui consomme `chemin`/`Lieu`
    // de src/lib/parcours.ts (renommé ci-dessous en navigation.ts) — même
    // décision, même mot.
  },
  {
    from: "tests/components/tri",
    to: "tests/components/review",
    // tests/ reflète src/ fichier pour fichier dans tout ce dépôt (vérifié :
    // apercu-sortie.test.tsx pour apercu-sortie.tsx, etc.) — laisser ce
    // dossier-ci en "tri" aurait laissé le mot français que le renommage de
    // src/components/tri/ visait précisément à faire disparaître. Pas
    // d'équivalent pour src/components/parcours/ : son unique fichier
    // (app-bar.tsx) a son test directement sous tests/components/, jamais
    // dans un sous-dossier "parcours/".
  },
];

export const FILE_RENAMES: Array<{ from: string; to: string }> = [
  // src/components/clip/
  { from: "src/components/clip/apercu-sortie.tsx", to: "src/components/clip/output-preview.tsx" },
  { from: "src/components/clip/champs-textes.tsx", to: "src/components/clip/text-fields.tsx" },
  // Unifie sur la convention déjà en place ailleurs (library-screen.tsx,
  // settings-screen.tsx) plutôt que sur ecran-*.tsx.
  { from: "src/components/clip/ecran-clip.tsx", to: "src/components/clip/clip-screen.tsx" },
  { from: "src/components/clip/geste-mot.ts", to: "src/components/clip/word-gesture.ts" },
  { from: "src/components/clip/lecture.ts", to: "src/components/clip/playback.ts" },
  { from: "src/components/clip/panneau-export.tsx", to: "src/components/clip/export-panel.tsx" },
  { from: "src/components/clip/raccourcis.tsx", to: "src/components/clip/shortcuts.tsx" },
  { from: "src/components/clip/recherche.ts", to: "src/components/clip/search.ts" },
  { from: "src/components/clip/textes.ts", to: "src/components/clip/texts.ts" },

  // src/components/tri/ → src/components/review/ (voir FOLDER_RENAMES)
  { from: "src/components/tri/avancement.tsx", to: "src/components/review/progress.tsx" },
  { from: "src/components/tri/ecran-projet.tsx", to: "src/components/review/project-screen.tsx" },
  { from: "src/components/tri/fil.tsx", to: "src/components/review/feed.tsx" },
  { from: "src/components/tri/fin-de-boucle.tsx", to: "src/components/review/loop-end.tsx" },
  { from: "src/components/tri/modele.ts", to: "src/components/review/template.ts" },
  { from: "src/components/tri/raccourcis.ts", to: "src/components/review/shortcuts.ts" },
  { from: "src/components/tri/relance.tsx", to: "src/components/review/retry.tsx" },
  { from: "src/components/tri/session.ts", to: "src/components/review/session.ts" },

  // src/components/sources/
  {
    from: "src/components/sources/ligne-montage.tsx",
    to: "src/components/sources/editing-line.tsx",
  },
  { from: "src/components/sources/textes.ts", to: "src/components/sources/texts.ts" },

  // src/core/
  { from: "src/core/erreurs.ts", to: "src/core/errors.ts" },
  // "la phase d'un projet, et le vocabulaire des étapes" (son propre
  // docstring) — pas le même "parcours" que src/lib/parcours.ts.
  { from: "src/core/parcours.ts", to: "src/core/phase.ts" },

  // src/lib/
  // Le protocole d'écriture différée de l'écran de clip (debounce +
  // réconciliation), jamais un enregistrement audio/vidéo — vérifié : aucun
  // identifiant déclaré de ce fichier ne porte le second sens.
  { from: "src/lib/enregistrement.ts", to: "src/lib/autosave.ts" },
  // "chemin"/"Lieu"/"settingsLink" : la navigation par fil d'Ariane de
  // l'AppBar, pas la phase d'un projet (src/core/parcours.ts, différent).
  { from: "src/lib/parcours.ts", to: "src/lib/navigation.ts" },

  // src/server/
  { from: "src/server/arret.ts", to: "src/server/shutdown.ts" },
  { from: "src/server/erreurs.ts", to: "src/server/errors.ts" },
  { from: "src/server/octets.ts", to: "src/server/bytes.ts" },
  { from: "src/server/rendus.ts", to: "src/server/renders.ts" },
  // src/server/secrets.ts n'est PAS renommé : déjà un nom anglais. Le
  // contrat de cette PR le liste parmi les 36 fichiers "au nom français" —
  // signalé dans le rapport plutôt que corrigé au passage, comme demandé.
  { from: "src/server/vignettes-sources.ts", to: "src/server/source-thumbnails.ts" },
  { from: "src/server/vues.ts", to: "src/server/views.ts" },

  // scripts/
  { from: "scripts/dev-commun.ts", to: "scripts/dev-common.ts" },
  { from: "scripts/mesure-premier-plan.ts", to: "scripts/measure-foreground.ts" },
  { from: "scripts/mesure-ratios.ts", to: "scripts/measure-ratios.ts" },
  { from: "scripts/vignettes-cadrage.ts", to: "scripts/framing-thumbnails.ts" },
  { from: "scripts/vignettes-premier-plan.ts", to: "scripts/foreground-thumbnails.ts" },

  // tests/ — miroir de src/ et scripts/, fichier pour fichier, dans tout ce
  // dépôt (vérifié). Chaque fichier renommé ci-dessus dont le test porte le
  // même radical est donc renommé pareil, ici. `session.ts`, `secrets.ts` et
  // les fichiers sans test (arret, rendus, vues, les scripts de mesure et
  // de vignettes, ligne-montage, fin-de-boucle) n'ont pas d'entrée : rien à
  // renommer côté nom, seul le dossier bouge pour ceux qui sont sous
  // tests/components/tri/ (voir FOLDER_RENAMES).
  { from: "tests/components/clip/apercu-sortie.test.tsx", to: "tests/components/clip/output-preview.test.tsx" },
  { from: "tests/components/clip/champs-textes.test.tsx", to: "tests/components/clip/text-fields.test.tsx" },
  { from: "tests/components/clip/ecran-clip.test.tsx", to: "tests/components/clip/clip-screen.test.tsx" },
  { from: "tests/components/clip/geste-mot.test.ts", to: "tests/components/clip/word-gesture.test.ts" },
  { from: "tests/components/clip/lecture.test.ts", to: "tests/components/clip/playback.test.ts" },
  { from: "tests/components/clip/panneau-export.test.tsx", to: "tests/components/clip/export-panel.test.tsx" },
  { from: "tests/components/clip/raccourcis.test.tsx", to: "tests/components/clip/shortcuts.test.tsx" },
  { from: "tests/components/clip/recherche.test.ts", to: "tests/components/clip/search.test.ts" },
  { from: "tests/components/clip/textes.test.ts", to: "tests/components/clip/texts.test.ts" },

  { from: "tests/components/tri/avancement.test.tsx", to: "tests/components/review/progress.test.tsx" },
  { from: "tests/components/tri/ecran-projet.test.tsx", to: "tests/components/review/project-screen.test.tsx" },
  { from: "tests/components/tri/fil.test.tsx", to: "tests/components/review/feed.test.tsx" },
  { from: "tests/components/tri/modele.test.ts", to: "tests/components/review/template.test.ts" },
  { from: "tests/components/tri/raccourcis.test.tsx", to: "tests/components/review/shortcuts.test.tsx" },
  { from: "tests/components/tri/relance.test.tsx", to: "tests/components/review/retry.test.tsx" },

  { from: "tests/components/sources/textes.test.ts", to: "tests/components/sources/texts.test.ts" },

  { from: "tests/core/erreurs.test.ts", to: "tests/core/errors.test.ts" },
  // "la phase d'un projet" — pas tests/lib/parcours.test.ts, ci-dessous,
  // qui teste la navigation par fil d'Ariane (deux fichiers "parcours",
  // deux sens, déjà séparés côté src/).
  { from: "tests/core/parcours.test.ts", to: "tests/core/phase.test.ts" },

  { from: "tests/lib/enregistrement.test.ts", to: "tests/lib/autosave.test.ts" },
  { from: "tests/lib/enregistrement-auto.test.tsx", to: "tests/lib/autosave-auto.test.tsx" },
  { from: "tests/lib/parcours.test.ts", to: "tests/lib/navigation.test.ts" },

  { from: "tests/server/erreurs.test.ts", to: "tests/server/errors.test.ts" },
  { from: "tests/server/octets.test.ts", to: "tests/server/bytes.test.ts" },
  { from: "tests/server/vignettes-sources.test.ts", to: "tests/server/source-thumbnails.test.ts" },

  { from: "tests/scripts/dev-commun.test.ts", to: "tests/scripts/dev-common.test.ts" },
];
