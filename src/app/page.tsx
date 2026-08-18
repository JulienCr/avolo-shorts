// Page d'attente. L'écran de tri et l'éditeur de clip arrivent plus tard dans
// l'itération 0 (spec §13) ; ce fichier n'existe ici que pour que le squelette
// se lance et que la CI ait quelque chose à construire.
export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-2xl flex-col gap-6 px-8 py-24">
        <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
          avolo-shorts
        </h1>
        <p className="text-lg leading-8 text-zinc-600 dark:text-zinc-400">
          Extraits courts des replays de <strong>LA SCÈNE AVOLO</strong>. Un clip est une liste de
          segments : on raccourcit une vanne trop longue en retirant son milieu, jamais en tronquant
          sa chute.
        </p>
        <p className="text-base leading-7 text-zinc-500 dark:text-zinc-500">
          L’interface arrive avec la suite de l’itération 0. En attendant, tout ce qui décide quelque
          chose vit dans <code className="font-mono text-[0.9em]">src/core/</code> et se vérifie par{' '}
          <code className="font-mono text-[0.9em]">pnpm test</code>.
        </p>
      </main>
    </div>
  )
}
