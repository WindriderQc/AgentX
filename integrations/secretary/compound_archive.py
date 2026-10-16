"""Bounded, inert archive readers. No member is executed or extracted by name."""
from __future__ import annotations

import ctypes as C
import ctypes.util
import io
import stat
import struct
import zipfile


class CompoundError(ValueError):
    pass


def _read_chunks(read, maximum):
    chunks, size = [], 0
    while True:
        value = read(min(65536, maximum - size + 1))
        if not value:
            return b"".join(chunks)
        size += len(value)
        if size > maximum:
            raise CompoundError("member_size_limit")
        chunks.append(value)


def _zip_directory(data, maximum):
    """Count central records before ZipFile allocates every ZipInfo object."""
    end = data.rfind(b"PK\x05\x06", max(0, len(data) - 65557))
    if end < 0 or end + 22 > len(data):
        raise CompoundError("zip_directory_unavailable")
    _, disk, first, disk_count, count, size, start, comment = struct.unpack_from("<4s4H2LH", data, end)
    if disk or first or disk_count != count or count == 65535 or size == 0xffffffff \
            or start == 0xffffffff or count > maximum or start + size != end or end + 22 + comment != len(data):
        raise CompoundError("zip_directory_unsupported_or_limit")
    position, actual = start, 0
    while position < end:
        if data[position:position + 4] != b"PK\x01\x02" or position + 46 > end:
            raise CompoundError("zip_directory_invalid")
        names, extra, comments = struct.unpack_from("<3H", data, position + 28)
        actual += 1
        if actual > maximum or names > 2048:
            raise CompoundError("entry_count_or_name_limit")
        position += 46 + names + extra + comments
    if position != end or actual != count:
        raise CompoundError("zip_directory_count_mismatch")


def zip_members(data):
    _zip_directory(data, 256)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if archive.comment:
            yield {"name": "(ZIP archive comment)", "kind": "file", "bytes": len(archive.comment),
                   "read": lambda maximum: archive.comment, "role": "archive_comment"}
        for ordinal, info in enumerate(archive.infolist()):
            mode = info.external_attr >> 16
            kind = "directory" if info.is_dir() else "file"
            if stat.S_IFMT(mode) and not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                kind = "special"

            def read(maximum, info=info):
                with archive.open(info) as stream:
                    return _read_chunks(stream.read, maximum)

            yield {"name": info.filename, "bytes": info.file_size, "kind": kind,
                   "encrypted": bool(info.flag_bits & 1), "read": read,
                   "metadata": {"modifiedAsDecoded": list(info.date_time), "timezoneSpecified": False,
                                "crc32": f"{info.CRC:08x}", "compressionMethod": info.compress_type,
                                "timestampIsNotAnEventOrCaptureDate": True}}
            if info.comment:
                comment = info.comment
                yield {"name": f"(ZIP entry {ordinal} comment)", "kind": "file", "bytes": len(comment),
                       "read": lambda maximum, value=comment: value, "role": "member_comment",
                       "metadata": {"memberNameAsWritten": info.filename}}


def libarchive_members(data):
    """Optional installed libarchive supports RAR/7z/tar; absence is a hold."""
    library = ctypes.util.find_library("archive")
    if not library:
        raise CompoundError("archive_decoder_unavailable")
    lib = C.CDLL(library)
    declarations = (
        ("archive_read_new", [], C.c_void_p),
        ("archive_read_support_filter_all", [C.c_void_p], C.c_int),
        ("archive_read_support_format_all", [C.c_void_p], C.c_int),
        ("archive_read_open_memory", [C.c_void_p, C.c_void_p, C.c_size_t], C.c_int),
        ("archive_read_next_header", [C.c_void_p, C.POINTER(C.c_void_p)], C.c_int),
        ("archive_entry_pathname_utf8", [C.c_void_p], C.c_char_p),
        ("archive_entry_size", [C.c_void_p], C.c_longlong),
        ("archive_entry_filetype", [C.c_void_p], C.c_uint),
        ("archive_entry_mtime", [C.c_void_p], C.c_longlong),
        ("archive_entry_mtime_nsec", [C.c_void_p], C.c_long),
        ("archive_read_data", [C.c_void_p, C.c_void_p, C.c_size_t], C.c_ssize_t),
        ("archive_read_free", [C.c_void_p], C.c_int),
    )
    for name, args, result in declarations:
        function = getattr(lib, name)
        function.argtypes, function.restype = args, result
    encrypted = getattr(lib, "archive_entry_is_encrypted", None)
    if encrypted:
        encrypted.argtypes, encrypted.restype = [C.c_void_p], C.c_int
    handle = lib.archive_read_new()
    if not handle:
        raise CompoundError("archive_decoder_unavailable")
    buffer = C.create_string_buffer(data)
    try:
        lib.archive_read_support_filter_all(handle)
        lib.archive_read_support_format_all(handle)
        if lib.archive_read_open_memory(handle, buffer, len(data)) != 0:
            raise CompoundError("archive_open_failed_or_encrypted")
        entry = C.c_void_p()
        while True:
            result = lib.archive_read_next_header(handle, C.byref(entry))
            if result == 1:  # ARCHIVE_EOF
                return
            if result != 0:
                raise CompoundError("archive_header_failed_or_encrypted")
            pathname = lib.archive_entry_pathname_utf8(entry)
            if pathname is None:
                raise CompoundError("archive_member_name_unreadable")
            name = pathname.decode("utf-8", errors="strict")
            mode = lib.archive_entry_filetype(entry)

            def read(maximum):
                def chunk(count):
                    piece = C.create_string_buffer(count)
                    size = lib.archive_read_data(handle, piece, count)
                    if size < 0:
                        raise CompoundError("archive_member_failed_or_encrypted")
                    return piece.raw[:size]
                return _read_chunks(chunk, maximum)

            yield {"name": name, "bytes": lib.archive_entry_size(entry),
                   "kind": "file" if stat.S_ISREG(mode) else "directory" if stat.S_ISDIR(mode) else "special",
                   "encrypted": bool(encrypted and encrypted(entry) > 0), "read": read,
                   "metadata": {"modifiedEpochAsDecoded": lib.archive_entry_mtime(entry),
                                "modifiedNanosecondsAsDecoded": lib.archive_entry_mtime_nsec(entry),
                                "timestampIsNotAnEventOrCaptureDate": True,
                                "decoderDoesNotExposeAllContainerHeadersOrComments": True}}
    finally:
        lib.archive_read_free(handle)


def members(data, kind):
    yield from (zip_members(data) if kind == "zip" else libarchive_members(data))
