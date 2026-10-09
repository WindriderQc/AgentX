"""Download an existing Core recipe bundle without executing its workflow."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import uuid

PART = re.compile(r'graph\.json|output\.(?:png|jpg)|reference-[01]-(?:source\.(?:png|jpg)|worker\.png)')


def export_recipe(client, operation, output):
    operation = str(uuid.UUID(operation))
    target = Path(output).expanduser()
    if target.exists():
        raise FileExistsError('Recipe output directory already exists')
    route = '/api/images/operations/' + operation + '/export'
    raw_manifest = client.read(route)
    manifest = json.loads(raw_manifest)
    expected = {'id': operation, 'state': 'completed', 'runtimeRestored': True}
    if not isinstance(manifest, dict) or manifest.get('schemaVersion') != 1 or manifest.get('operation') != expected:
        raise ValueError('Recipe is not completed with verified runtime restoration')
    parts = manifest.get('parts')
    if not isinstance(parts, list) or not 2 <= len(parts) <= 6:
        raise ValueError('Invalid recipe parts')
    files = {'image-recipe.json': raw_manifest}
    for part in parts:
        if not isinstance(part, dict):
            raise ValueError('Invalid recipe part')
        name, size, digest = part.get('name'), part.get('size'), part.get('sha256')
        if not isinstance(name, str) or not PART.fullmatch(name) or name in files:
            raise ValueError('Invalid or duplicate recipe filename')
        limit = 1048576 if name == 'graph.json' else 50 * 1024 * 1024
        if type(size) is not int or not 0 < size <= limit or not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest):
            raise ValueError('Invalid recipe integrity receipt')
        expected_url = route + '/parts/' + name
        if part.get('url') != expected_url:
            raise ValueError('Recipe part is outside its Core export')
    names = [part['name'] for part in parts]
    if len(set(names)) != len(names):
        raise ValueError('Duplicate recipe filename')
    if 'graph.json' not in names or sum(name.startswith('output.') for name in names) != 1:
        raise ValueError('Recipe requires its recorded graph and output')
    for part in parts:
        raw = client.read(part['url'], limit=part['size'])
        if len(raw) != part['size'] or hashlib.sha256(raw).hexdigest() != part['sha256']:
            raise ValueError('Archived recipe integrity check failed')
        files[part['name']] = raw
    # Publish only after every piece verifies. mkdir is exclusive, including races.
    target.parent.mkdir(parents=True, exist_ok=True)
    target.mkdir()
    try:
        for name, raw in files.items():
            with (target / name).open('xb') as file:
                file.write(raw)
    except BaseException:
        shutil.rmtree(target)
        raise
    return {'ok': True, 'operationId': operation, 'directory': str(target.resolve()), 'files': list(files)}
