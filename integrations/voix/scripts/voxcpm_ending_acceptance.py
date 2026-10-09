"""Synthetic, audio-ephemeral round-trip check for VoxCPM2 sentence endings.

The ASR comparison only selects clips for human review. It cannot prove that a
word was spoken or omitted. No waveform is written to disk.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
from io import BytesIO
import json
from pathlib import Path
import re
import sys
import time
import unicodedata
import wave

import numpy as np
import requests


SENTENCES = (
    "Non, pas encore.",
    "C'est fait !",
    "Oui, exactement.",
    "Je reviens bientôt.",
    "Attends une seconde.",
    "La porte est fermée.",
    "Le café est prêt.",
    "On peut commencer ?",
    "Tu as bien reçu le message ?",
    "Il reste encore trois places.",
    "Le colis arrivera demain matin.",
    "La réunion commence à neuf heures.",
    "J'ai rangé les clés dans le tiroir.",
    "Nous irons marcher après le souper.",
    "Ce livre est posé sur la table.",
    "Le prochain arrêt se trouve près du parc.",
    "Il faudra vérifier le numéro du dossier.",
    "Je préfère attendre la réponse officielle.",
    "La lampe du salon reste allumée.",
    "Peux-tu fermer la fenêtre avant de partir ?",
    "Le rapport sera disponible en fin de journée.",
    "Nous avons choisi la route la plus courte.",
    "La petite équipe a terminé son travail.",
    "Le billet porte la date du quinze octobre.",
    "J'ai laissé une note près de l'ordinateur.",
    "Cette fois, la réponse est vraiment complète.",
    "Le train ralentit avant d'entrer dans la gare.",
    "Est-ce que la batterie tiendra jusqu'à ce soir ?",
    "J'ai rendez-vous chez le dentiste de la rue Principale.",
    "Le solde du compte courant est suffisant.",
    "Le chat préfère rester à la maison aujourd'hui.",
    "Je vais préparer les documents, puis fermer le classeur.",
    "Quand la pluie cessera, nous sortirons prendre l'air.",
    "Le dernier paragraphe explique clairement la procédure.",
    "Même si la réponse tarde, nous garderons le rendez-vous.",
    "Je te remercie pour ton aide et pour ta patience.",
    "Avant de confirmer, relis attentivement la dernière ligne.",
    "Si le voyant devient rouge, arrête la machine immédiatement.",
    "La nouvelle version fonctionne mieux avec cette configuration.",
    "La commande contient deux articles, mais un seul reçu.",
    "Est-ce que tu peux répéter la dernière partie de la phrase ?",
    "Après la pause, nous reprendrons exactement au même endroit.",
    "Je lui ai proposé de le garder à la maison.",
    "Après avoir vérifié les horaires et confirmé mon rendez-vous, je passerai chez le dentiste de la rue Principale.",
    "Même si le paiement prévu pour septembre arrive plus tard que prévu, le solde du compte courant est suffisant.",
    "Comme il pleut encore et que la route est glissante, j'ai décidé de le garder à la maison.",
    "Peux-tu vérifier une dernière fois les trois adresses avant d'envoyer le document au bureau demain matin ?",
    "Le technicien a terminé les vérifications, rangé ses outils et laissé une note près de la fenêtre du salon.",
    "Nous avons confirmé l'heure, le lieu et le nombre de participants avant de finaliser la réservation.",
    "Si la lumière rouge reste allumée après le redémarrage, arrête la machine et préviens le responsable immédiatement.",
    "Le calendrier indique que la prochaine réunion aura lieu le premier lundi du mois de novembre.",
    "Il faut lire la dernière page avec attention, car elle explique les conditions de la garantie prolongée.",
    "Après plusieurs essais et une courte pause, toute l'équipe a convenu que la réparation était terminée.",
)


def words(value: str) -> list[str]:
    plain = unicodedata.normalize("NFKD", value.casefold())
    plain = "".join(char for char in plain if not unicodedata.combining(char))
    return re.findall(r"[a-z0-9]+", plain)


def review_hint(expected: str, heard: str) -> str:
    target, actual = words(expected), words(heard)
    if target == actual:
        return "asr_exact"
    if not actual:
        return "review_empty_asr"
    if actual[:len(target)] == target:
        return "review_possible_added_tail"
    if actual == target[:len(actual)]:
        return "review_possible_dropped_tail"
    return "review_mismatch"


def collect_stream(session: requests.Session, base_url: str, text: str, voice: str) -> dict:
    started = time.perf_counter()
    chunks = []
    frames = samples = 0
    rate = None
    first_signal_ms = None
    done = None
    with session.post(f"{base_url}/api/tts/stream", json={
        "text": text, "tts_provider": "voxcpm", "voice": voice, "language": "fr",
    }, stream=True, timeout=(5, 120)) as response:
        response.raise_for_status()
        for line in response.iter_lines(chunk_size=4096):
            if not line:
                continue
            event = json.loads(line)
            kind = event.get("type")
            if done is not None:
                raise ValueError("Audio event after completion")
            if kind == "meta":
                if rate is not None or event.get("protocol") != "voix-pcm-v1" or event.get("voice") != voice:
                    raise ValueError("Unexpected stream metadata")
                if event.get("encoding") != "f32le" or event.get("channels") != 1 or event.get("sample_rate") != 48000:
                    raise ValueError("Unexpected audio format")
                rate = 48000
            elif kind == "audio":
                if rate is None or event.get("sequence") != frames + 1:
                    raise ValueError("Missing or reordered audio frame")
                raw = base64.b64decode(event["pcm"], validate=True)
                if not raw or len(raw) % 4:
                    raise ValueError("Invalid PCM frame")
                audio = np.frombuffer(raw, dtype="<f4")
                if event.get("samples") != audio.size or not np.isfinite(audio).all():
                    raise ValueError("Invalid audio samples")
                if first_signal_ms is None and np.any(np.abs(audio) > 0.001):
                    first_signal_ms = round((time.perf_counter() - started) * 1000)
                chunks.append(audio)
                frames += 1
                samples += audio.size
            elif kind == "done":
                if not frames or event.get("frames") != frames or event.get("samples") != samples:
                    raise ValueError("Incomplete PCM stream")
                done = event
            elif kind == "error":
                raise RuntimeError("Speech worker reported an error")
            else:
                raise ValueError("Unknown PCM event")
    if done is None:
        raise ValueError("PCM stream ended without completion")
    return {
        "audio": np.concatenate(chunks),
        "sample_rate": rate,
        "duration_ms": round(samples / rate * 1000),
        "first_signal_ms": first_signal_ms,
        "generation_ms": done.get("generation_ms"),
    }


def wav_bytes(audio: np.ndarray, sample_rate: int) -> bytes:
    pcm = np.rint(np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
    buffer = BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(pcm.tobytes())
    return buffer.getvalue()


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8091")
    parser.add_argument("--voice", required=True, help="served VoxCPM voice id")
    parser.add_argument("--label", required=True, help="configuration label for this run")
    parser.add_argument("--only", help="comma-separated 1-based sentence numbers for diagnosis")
    parser.add_argument("--report", type=Path, help="optional JSON report; contains text and timing, never audio")
    args = parser.parse_args()
    indexes = list(range(len(SENTENCES)))
    if args.only:
        try:
            indexes = sorted({int(item) - 1 for item in args.only.split(",")})
        except ValueError:
            parser.error("--only must be comma-separated sentence numbers")
        if not indexes or indexes[0] < 0 or indexes[-1] >= len(SENTENCES):
            parser.error(f"--only accepts sentence numbers 1..{len(SENTENCES)}")
    if args.report and args.report.resolve().is_relative_to(Path(__file__).resolve().parents[1]):
        parser.error("--report must be outside the repository")

    report = {"label": args.label, "voice": args.voice, "created_utc": datetime.now(timezone.utc).isoformat(),
              "total_sentences": len(SENTENCES), "cases": []}
    failed = 0
    with requests.Session() as session:
        session.trust_env = False
        for index in indexes:
            expected = SENTENCES[index]
            row = {"number": index + 1, "expected": expected}
            try:
                clip = collect_stream(session, args.base_url.rstrip("/"), expected, args.voice)
                response = session.post(f"{args.base_url.rstrip('/')}/v1/audio/transcriptions",
                                        files={"file": ("synthetic.wav", wav_bytes(clip["audio"], clip["sample_rate"]),
                                                        "audio/wav")},
                                        data={"language": "fr"}, timeout=(5, 120))
                response.raise_for_status()
                heard = str(response.json().get("text") or "")
                row.update(heard=heard, hint=review_hint(expected, heard),
                           duration_ms=clip["duration_ms"], first_signal_ms=clip["first_signal_ms"],
                           generation_ms=clip["generation_ms"])
                print(f"{index + 1:02d} {row['hint']}: {expected} -> {heard}"
                      f" [{row['duration_ms']} ms audio; {row['first_signal_ms']} ms first signal]", flush=True)
            except (requests.RequestException, ValueError, RuntimeError, KeyError) as exc:
                failed += 1
                row.update(hint="transport_error", error=type(exc).__name__)
                print(f"{index + 1:02d} transport_error: {type(exc).__name__}", flush=True)
            report["cases"].append(row)
    report["transport_errors"] = failed
    report["asr_review"] = sum(row["hint"] != "asr_exact" for row in report["cases"] if row["hint"] != "transport_error")
    if args.report:
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{len(report['cases'])} phrases; {failed} transport errors; "
          f"{report['asr_review']} ASR mismatches to review by listening. No audio was saved.")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
