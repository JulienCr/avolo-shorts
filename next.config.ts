import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * **`@napi-rs/canvas` doit rester hors du paquet serveur.**
   *
   * Le rasteriseur du hook charge un binding natif (`.node`), et un binding
   * natif ne s'empaquette pas : Turbopack le réécrit et la résolution échoue à
   * l'exécution sur « Cannot find native binding », dont le message conseille à
   * tort de réinstaller — l'installation était correcte, le paquet
   * `@napi-rs/canvas-linux-x64-gnu` bien présent.
   *
   * `better-sqlite3` ne demande rien ici parce qu'il figure dans la liste que
   * Next externalise par défaut ; `@napi-rs/canvas` n'y est pas. Tout binding
   * natif ajouté au serveur devra donc être ajouté ici aussi.
   *
   * Ni les tests (Vitest tourne sur Node nu) ni les rendus de preuve (appels
   * ffmpeg directs) ne traversent le paquet serveur de Next : ce défaut ne
   * pouvait se voir qu'en lançant l'application.
   */
  serverExternalPackages: ["@napi-rs/canvas"],
};

export default nextConfig;
