#!/usr/bin/env python3
"""Transcription WhisperX, et rien d'autre.

Le diariseur de ``~/dev/rythmo-impro/diarizer`` n'est pas un service : c'est un
``main.py`` de 1893 lignes piloté en ligne de commande, qui exige ``HF_TOKEN`` et
fait tourner pyannote. **L'itération 0 n'utilise pas les locuteurs** (spec §17).
D'où ce script court, qui ne fait que transcrire et aligner — et qui **réutilise
le venv du diariseur** plutôt que d'en reconstruire 8,1 Go.

Pas de pyannote, donc **pas de ``HF_TOKEN``** : les modèles d'alignement de
WhisperX sont publics, seuls ceux de pyannote sont sous accord.

Deux variables d'environnement conditionnent le démarrage, et c'est
``src/server/steps/transcript.ts`` qui les pose (elles viennent du ``run-wsl.sh``
du diariseur) :

- ``TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1`` — PyTorch 2.6+ refuse sinon de charger
  les points de contrôle qui portent des classes de bibliothèque ;
- ``LD_LIBRARY_PATH`` pointant le ``nvidia/cudnn/lib`` du venv — CTranslate2 ne
  trouve pas cuDNN autrement, et le chargement du modèle échoue sur une
  bibliothèque introuvable.

Sortie : ``{"segments": [{"start", "end", "text", "words": [...]}]}`` — la forme
``.cli.json`` du diariseur, sans les locuteurs.
"""

import argparse
import json
import os
import sys
import time


def journal(message: str) -> None:
    """Sur stderr, jamais stdout.

    Node lit stderr pour son journal d'erreur ; stdout reste libre au cas où une
    version ultérieure y écrirait le résultat.
    """
    print(message, file=sys.stderr, flush=True)


def main() -> int:
    p = argparse.ArgumentParser(description="Transcrit un WAV avec WhisperX.")
    p.add_argument("--audio", required=True, help="le WAV 16 kHz mono")
    p.add_argument("--out", required=True, help="le JSON à écrire")
    p.add_argument("--model", default="large-v3")
    p.add_argument("--language", default="fr")
    p.add_argument("--batch-size", type=int, default=16)
    p.add_argument("--compute-type", default="float16")
    p.add_argument("--device", default="cuda")
    a = p.parse_args()

    if not os.path.isfile(a.audio):
        journal(f"Audio introuvable : {a.audio}")
        return 2

    # Importé ici et non en tête de fichier : le chargement de whisperx tire
    # torch et pèse une dizaine de secondes. Un `--help` ou un chemin d'audio
    # faux doivent répondre tout de suite.
    import whisperx  # noqa: PLC0415

    départ = time.monotonic()
    journal(f"[1/4] Chargement du modèle {a.model} sur {a.device} ({a.compute_type})…")
    # `language` dès le chargement, et pas seulement à la transcription : sans
    # lui, WhisperX annonce « language will be detected for each audio file »
    # et paie une passe de détection sur chaque extrait. Les replays sont en
    # français, et c'est le seul cas que l'itération 0 rencontre.
    model = whisperx.load_model(
        a.model, a.device, compute_type=a.compute_type, language=a.language
    )

    journal(f"[2/4] Lecture de l'audio {a.audio}…")
    audio = whisperx.load_audio(a.audio)
    journal(f"      {len(audio) / 16000:.1f} s")

    journal(f"[3/4] Transcription (batch {a.batch_size}, langue {a.language})…")
    result = model.transcribe(audio, batch_size=a.batch_size, language=a.language)
    # `or` et non le défaut de `get` : celui-ci ne joue que si la clé est
    # absente, pas si elle est présente et vaut `None`. `langue` partirait alors
    # à `None` dans `load_align_model`, qui échouerait sur un message qui ne
    # nomme pas la langue. (relevé par Aristarque)
    langue = result.get("language") or a.language

    # Rendre la VRAM du modèle de transcription avant de charger celui
    # d'alignement. `empty_cache()` ne suffit pas à tout rendre avec CTranslate2
    # — la garantie dure, c'est la sortie du processus, et c'est Node qui
    # l'attend —, mais les deux modèles n'ont aucune raison de cohabiter.
    del model
    try:
        import gc

        import torch

        gc.collect()
        torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001 — libérer est une optimisation, pas un contrat
        pass

    journal(f"[4/4] Alignement mot à mot (langue détectée : {langue})…")
    model_a, metadata = whisperx.load_align_model(language_code=langue, device=a.device)
    aligned = whisperx.align(result["segments"], model_a, metadata, audio, a.device)

    segments = [
        {
            "start": s["start"],
            "end": s["end"],
            "text": s.get("text", ""),
            # Un mot sans horodatage est un mot que l'alignement n'a pas su
            # placer — cela arrive sur les chiffres et les onomatopées. Le
            # garder sans bornes ferait apparaître un carton de sous-titres à
            # l'instant zéro : on le jette.
            "words": [
                {"word": w.get("word", ""), "start": w.get("start"), "end": w.get("end")}
                for w in s.get("words", [])
                if w.get("start") is not None and w.get("end") is not None
            ],
        }
        for s in aligned["segments"]
    ]

    dossier = os.path.dirname(a.out)
    if dossier:
        os.makedirs(dossier, exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump({"segments": segments}, f, ensure_ascii=False)

    mots = sum(len(s["words"]) for s in segments)
    journal(
        f"Écrit {a.out} : {len(segments)} segments, {mots} mots, "
        f"en {time.monotonic() - départ:.0f} s."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
