"""Shared immutable identity and private durable review receipts."""
import hashlib
import json
import os


def hashed(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def durable(file, value, exclusive=False):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = file if exclusive else file.with_name(file.name + f".{os.getpid()}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | (os.O_EXCL if exclusive else os.O_TRUNC)
    descriptor = os.open(target, flags, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        json.dump(value, output, ensure_ascii=False, indent=2)
        output.flush(); os.fsync(output.fileno())
    if not exclusive:
        target.replace(file)
    if os.name != "nt":
        directory = os.open(file.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
