"""Bounded, request-local multipart audio; accepted files never roll to disk."""
from contextlib import asynccontextmanager

from fastapi import HTTPException, Request
from starlette.formparsers import MultiPartException, MultiPartParser

# Match Household's existing 32 MiB request ceiling, including multipart framing.
MAX_UPLOAD_BYTES = 32 * 1024 * 1024


class AudioMultipartParser(MultiPartParser):
    spool_max_size = MAX_UPLOAD_BYTES


@asynccontextmanager
async def audio_form(request: Request):
    if not request.headers.get("content-type", "").lower().startswith("multipart/form-data"):
        raise HTTPException(422, "audio file is required")

    async def bounded_stream():
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                raise HTTPException(413, "Audio request exceeds 32 MiB")
            yield chunk

    parser = AudioMultipartParser(request.headers, bounded_stream(), max_files=1)
    try:
        yield await parser.parse()
    except MultiPartException as exc:
        raise HTTPException(400, exc.message) from exc
    finally:
        # Also close a partial upload on disconnect/cancellation, for which the
        # base parser's MultiPartException cleanup does not run. These are the
        # same file objects handed to FormData, so success closes them too.
        for file in parser._files_to_close_on_error:
            file.close()
