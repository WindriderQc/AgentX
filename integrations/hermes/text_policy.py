"""Text preparation evidence for Hermes. Rendering and lettering remain in Core."""
import re

STRATEGIES = ('auto', 'single-pass', 'two-pass')
TRIM = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'


def validate(value):
    if not isinstance(value, dict) or set(value) != {'version', 'enabled', 'strategy', 'labels'}:
        raise ValueError('Invalid image text policy')
    if type(value['version']) is not int or value['version'] != 1 or type(value['enabled']) is not bool or value['strategy'] not in STRATEGIES:
        raise ValueError('Invalid image text policy')
    items, identifiers, total = value['labels'], set(), 0
    if not isinstance(items, list) or len(items) > 20:
        raise ValueError('Invalid image text labels')
    for item in items:
        if not isinstance(item, dict) or set(item) != {'id', 'text', 'placement'}:
            raise ValueError('Invalid image text label')
        identifier = item['id']
        if not isinstance(identifier, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}', identifier) or identifier in identifiers:
            raise ValueError('Invalid image text label identity')
        identifiers.add(identifier)
        for key, limit, required in [('text', 300, True), ('placement', 240, False)]:
            text = item[key]
            if not isinstance(text, str) or len(text) > limit or (required and not text.strip(TRIM)):
                raise ValueError('Invalid image text label content')
            if any((ord(c) < 32 and c not in '\t\n\r') or 0xD800 <= ord(c) <= 0xDFFF or ord(c) in (0xFFFE, 0xFFFF) for c in text):
                raise ValueError('Invalid Unicode image text label')
            total += len(text)
        if total > 4000:
            raise ValueError('Image text labels exceed their budget')
    return value


def planning_instruction(value, constraints=None):
    policy = validate(value)
    exact = [item for item in (constraints or {}).get('items', []) if item['kind'] == 'exact-text']
    if not policy['enabled']:
        if exact:
            raise ValueError('Exact text constraints conflict with disabled image text')
        return (' Text in the image is disabled. Refine the visual scene without visible letters, numbers, labels or textual logos. '
                'Do not return textPlan. Core appends the no-text rendering instruction without changing the saved original brief.')
    known = list(policy['labels'])
    for item in exact:
        if not any(label['text'] == item['text'] for label in known):
            known.append({'id': 'constraint.' + item['id'], 'text': item['text'], 'placement': ''})
    validate({**policy, 'labels': known})
    return (' Text in the final image is enabled. Also return textPlan with exactly version (1), strategy '
            '(single-pass or two-pass), reason (French, at most 1000 characters), and labels. Each label has '
            'exactly id, text (at most 300 characters), and placement (at most 240 characters). At most 20 labels, '
            '4000 characters total including placements. Preserve every supplied label id, exact spelling, accents, '
            'punctuation and nonempty requested placement. Exact-text constraints use the id constraint.<constraint-id>; '
            'do not duplicate an existing label with identical text. If the list is empty, extract and propose the '
            'essential requested texts from the brief for human review. Never return an empty label plan. '
            'Negotiate priorities in your reason: propose fewer labels or shorter alternatives without silently '
            'changing or dropping supplied exact texts. Judge count, length, exact spelling requirements, font size '
            'and perspective; do not use a universal count threshold or claim measured model accuracy. '
            'With strategy auto, recommend one or two passes and explain the tradeoff. With an explicit strategy, '
            'preserve it unchanged. Single-pass means the model attempts the text during generation, followed by '
            'human spelling review. Two-pass means one text-free image render with calm, blank, front-facing '
            'label areas, followed by editable Canvas/SVG text layers in Atelier; it is not a second model render. '
            'In two-pass prompt, describe the visual scene and blank areas, not instructions to draw the words. '
            'Placement descriptions are proposals, not coordinates verified against a rendered image. The user '
            'applies your proposal and reviews placement before export. Do not create images or text exports yourself.')
