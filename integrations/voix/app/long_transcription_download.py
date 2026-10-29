"""One native audio download; invoked as a disposable child process."""
import json
import os
from pathlib import Path
import shutil
import sys
from app.long_transcription_network import youtube_url, youtube_proxy


def download(url, directory, max_bytes, max_seconds):
    from yt_dlp import YoutubeDL
    directory = Path(directory)
    reserve = 512 * 1024 * 1024
    budget = min(max_bytes, shutil.disk_usage(directory).free - reserve)
    if budget <= 0:
        raise RuntimeError("Espace disque insuffisant.")

    def progress(row):
        if row.get("downloaded_bytes", 0) > budget:
            raise RuntimeError("Budget disque du téléchargement dépassé.")
        if shutil.disk_usage(directory).free < reserve:
            raise RuntimeError("Réserve disque atteinte.")

    deno = Path(sys.executable).parent / ('deno.exe' if os.name == 'nt' else 'deno')
    deno_path = str(deno) if deno.is_file() else shutil.which('deno')
    if not deno_path:
        raise RuntimeError('Le runtime Deno officiel est requis pour YouTube.')
    with youtube_proxy() as proxy:
        # Library API doesn't load CLI/config files, browser cookies or user plugins.
        options = {
            "proxy": proxy, "geo_verification_proxy": proxy,
            "format": "bestaudio[protocol=https]",
            "outtmpl": str(directory / "source.%(ext)s"), "noplaylist": True,
            "quiet": True, "no_warnings": True, "socket_timeout": 15,
            "retries": 0, "fragment_retries": 0, "extractor_retries": 0,
            "max_filesize": budget, "progress_hooks": [progress],
            "cachedir": False, "remote_components": [], "js_runtimes": {"deno": {"path": deno_path}},
            "allowed_extractors": ["youtube"], "overwrites": False,
        }
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(youtube_url(url), download=False)
            duration = info.get("duration")
            if info.get("_type") in ("playlist", "multi_video") or info.get("is_live"):
                raise RuntimeError("Les directs et playlists ne sont pas pris en charge.")
            if not isinstance(duration, (int, float)) or not 0 < duration <= max_seconds:
                raise RuntimeError("Durée inconnue ou supérieure au budget de décodage configuré.")
            ydl.process_info(info)
            file = Path(ydl.prepare_filename(info))
            if not file.is_file() or file.stat().st_size > budget:
                raise RuntimeError("Aucune piste audio native utilisable.")
            print(json.dumps({"path": file.name, "title": str(info.get("title") or "Vidéo YouTube")[:500],
                              "duration": duration}), flush=True)


if __name__ == "__main__":
    # Prevent environment proxy bypass through NO_PROXY and optional plugins.
    for key in list(os.environ):
        if key.lower() in ("no_proxy", "http_proxy", "https_proxy", "all_proxy"):
            os.environ.pop(key, None)
    download(sys.argv[1], sys.argv[2], int(sys.argv[3]), float(sys.argv[4]))
