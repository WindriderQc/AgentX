from app.tts.chunker import ClauseChunker, chunk_all


def _tokens(text, size=3):
    for i in range(0, len(text), size):
        yield text[i:i + size]


def test_strong_boundary_flushes():
    chunks = chunk_all(_tokens("Bonjour. Comment vas-tu?"), min_chars=5)
    assert chunks[0] == "Bonjour."
    assert chunks[-1].endswith("?")


def test_min_chars_holds_short_clauses():
    # short comma clause should NOT flush before min_chars
    chunks = chunk_all(_tokens("Oui, bien."), min_chars=40)
    assert chunks == ["Oui, bien."]


def test_long_comma_flushes_past_min():
    text = "Je pense que oui parce que c'est logique, et ensuite on verra."
    chunks = chunk_all(_tokens(text), min_chars=20)
    assert len(chunks) >= 2
    assert any("," in c for c in chunks[:-1])


def test_tail_is_flushed_without_punctuation():
    chunks = chunk_all(_tokens("texte sans ponctuation finale"), min_chars=10)
    assert "".join(chunks).replace(" ", "") != ""
    assert chunks[-1].strip() != ""


def test_incremental_feed_matches_batch():
    c = ClauseChunker(min_chars=5)
    out = []
    for tok in _tokens("Salut! Ca va bien."):
        out.extend(c.feed(tok))
    tail = c.flush()
    if tail:
        out.append(tail)
    assert out[0] == "Salut!"
