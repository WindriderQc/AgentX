import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("profile_alias", Path(__file__).parents[1]/"host/profile_alias.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ProfileAliasTest(unittest.TestCase):
    def test_explicit_named_alias_keeps_its_identity_without_moving_history(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)/"runtime"
            profiles = root/"profiles"
            profiles.mkdir(parents=True)
            independent = Path(d)/"independent"
            independent.mkdir()
            (independent/"state.db").write_text("existing history")
            alias = profiles/"primary"
            alias.symlink_to(independent, target_is_directory=True)
            self.assertEqual(module.resolve_active_profile_name(alias, root, profiles), "primary")
            self.assertEqual(module.resolve_active_profile_name(independent, root, profiles), "custom")
            self.assertEqual((alias/"state.db").read_text(), "existing history")
            self.assertEqual(module.resolve_active_profile_name(root, root, profiles), "default")

if __name__ == "__main__":
    unittest.main()
