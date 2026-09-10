"""Actual-write boundaries for calibration PDF serializers."""

from __future__ import annotations

from typing import BinaryIO


class OutputLimitExceeded(ValueError):
    """Raised before a serializer write would grow an output beyond its limit."""

    def __init__(self, max_bytes: int) -> None:
        super().__init__(f"PDF output exceeds the configured {max_bytes}-byte limit.")
        self.max_bytes = max_bytes


def validate_max_output_bytes(max_bytes: int | None) -> int | None:
    """Validate an optional output cap without changing uncapped callers."""
    if max_bytes is None:
        return None
    if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or max_bytes < 1:
        raise ValueError("max_output_bytes must be a positive integer when provided")
    return max_bytes


class BoundedBinaryWriter:
    """A seek-aware binary stream that rejects growth before delegating writes.

    PDF serializers commonly use ``tell`` and ``seek`` while constructing xref
    tables. The tracked extent is therefore the greatest byte position actually
    written, rather than the current stream position.
    """

    def __init__(self, stream: BinaryIO, *, max_bytes: int) -> None:
        self._stream = stream
        validated_max_bytes = validate_max_output_bytes(max_bytes)
        if validated_max_bytes is None:
            raise ValueError("max_bytes is required for a bounded writer")
        self._max_bytes = validated_max_bytes
        current_position = stream.tell()
        stream.seek(0, 2)
        self._extent = stream.tell()
        stream.seek(current_position)

    def write(self, data: bytes | bytearray | memoryview) -> int:
        byte_count = memoryview(data).nbytes
        position = self._stream.tell()
        next_extent = max(self._extent, position + byte_count)
        if next_extent > self._max_bytes:
            raise OutputLimitExceeded(self._max_bytes)
        written = self._stream.write(data)
        self._extent = max(self._extent, self._stream.tell())
        return written

    def tell(self) -> int:
        return self._stream.tell()

    def seek(self, offset: int, whence: int = 0) -> int:
        return self._stream.seek(offset, whence)

    def truncate(self, size: int | None = None) -> int:
        """Reject truncation that would expand the stream beyond the cap."""
        target_size = self._stream.tell() if size is None else size
        if target_size > self._max_bytes:
            raise OutputLimitExceeded(self._max_bytes)
        truncated_to = self._stream.truncate(size)
        self._extent = truncated_to
        return truncated_to

    def flush(self) -> None:
        self._stream.flush()

    def __getattr__(self, name: str) -> object:
        return getattr(self._stream, name)
