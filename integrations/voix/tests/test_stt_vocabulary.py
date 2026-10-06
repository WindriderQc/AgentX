import json

from app.stt import vocabulary
from app.stt.vocabulary import load_corrections, normalize_transcript


def test_greeting_repairs_nestor_without_rewriting_real_blinds():
    assert normalize_transcript("Salut les stores, c'est moi.") == "Salut Nestor, c'est moi."
    assert normalize_transcript("Ferme les stores du salon.") == "Ferme les stores du salon."


def test_product_list_repairs_known_names_contextually():
    assert normalize_transcript("agent x, Open Cloud et Voi") == (
        "AgentX, OpenClaw et VoiX"
    )


def test_leading_product_voix_is_repaired_without_rewriting_ordinary_voice():
    assert normalize_transcript("Voix doit comprendre mon français québécois.") == (
        "VoiX doit comprendre mon français québécois."
    )
    assert normalize_transcript("Ma voix doit porter davantage.") == (
        "Ma voix doit porter davantage."
    )


def test_no_household_name_is_corrected_without_an_instance_file(monkeypatch):
    monkeypatch.setattr(vocabulary, "_instance_corrections", lambda: ())
    assert normalize_transcript("Salut Nestor, c'est camille.") == "Salut Nestor, c'est camille."


def test_instance_file_adds_its_own_names(tmp_path):
    path = tmp_path / "corrections.json"
    path.write_text(json.dumps([
        {"pattern": r"\bcam+il+e?\b", "replacement": "Camille"},
        {"pattern": r"\bmont[\s-]*bleu\b", "replacement": "Mont-Bleu"},
    ]), encoding="utf-8")
    corrections = load_corrections(path)
    assert normalize_transcript("salut les stores, c'est camil au mont bleu.", corrections) == (
        "salut Nestor, c'est Camille au Mont-Bleu."
    )


def test_setting_names_the_instance_file(tmp_path, monkeypatch):
    from dataclasses import replace

    path = tmp_path / "corrections.json"
    path.write_text(json.dumps([{"pattern": r"\bcamil\b", "replacement": "Camille"}]), encoding="utf-8")
    monkeypatch.setattr(vocabulary, "settings", replace(vocabulary.settings, stt_corrections_path=str(path)))
    vocabulary._instance_corrections.cache_clear()
    try:
        assert normalize_transcript("c'est camil") == "c'est Camille"
    finally:
        vocabulary._instance_corrections.cache_clear()


def test_missing_or_invalid_instance_file_keeps_the_built_in_rules(tmp_path, monkeypatch):
    warnings = []
    monkeypatch.setattr(vocabulary._LOG, "warning", lambda *args: warnings.append(args))
    assert load_corrections("") == ()
    assert load_corrections(tmp_path / "absent.json") == ()
    broken = tmp_path / "broken.json"
    for content in ("not json", '{"pattern": "x"}', '[{"pattern": "(", "replacement": "x"}]', '[{"pattern": "x"}]'):
        broken.write_text(content, encoding="utf-8")
        assert load_corrections(broken) == ()
    assert len(warnings) == 5
