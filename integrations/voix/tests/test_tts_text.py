from app.tts.text import detect_language, sanitize_for_speech


def test_markdown_emphasis_is_not_spoken():
    assert sanitize_for_speech("**Important** : c'est *vraiment* prêt.") == (
        "Important : c'est vraiment prêt."
    )


def test_visual_structure_becomes_natural_spoken_text():
    text = "## Étapes\n- ouvre [AgentX](https://example.test)\n- lance `VoiX`"
    assert sanitize_for_speech(text) == "Étapes ouvre AgentX lance VoiX"


def test_markdown_only_clause_is_silent():
    assert sanitize_for_speech("* *") == ""


def test_escaped_emphasis_does_not_leave_spoken_backslashes():
    assert sanitize_for_speech(r"\*\*Bonjour\*\* et \_salut\_.") == "Bonjour et salut ."
    assert sanitize_for_speech(r"C:\Users\Alex") == r"C:\Users\Alex"


def test_language_detection_switches_for_clear_french_and_english():
    assert detect_language("Can we switch to English?", default="fr") == "en"
    assert detect_language("But you keep your French voice so you sound weird.", default="fr") == "en"
    assert detect_language("Pour ça, il faut passer par OpenClaw.", default="en") == "fr"


def test_language_detection_keeps_short_technical_names_sticky():
    assert detect_language("OpenClaw", default="fr") == "fr"
    assert detect_language("OpenClaw", default="en") == "en"
