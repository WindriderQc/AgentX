"""Disposable CPU checks; no installed DSH, session history or native service access."""

import contextlib
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "dsh-session-compat.py"
SPEC = importlib.util.spec_from_file_location("dsh_session_compat", SCRIPT)
COMPAT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COMPAT)


def sha(data):
    return hashlib.sha256(data).hexdigest()


class BundledArtifactTest(unittest.TestCase):
    def test_reviewed_artifact_hash_metadata_and_exact_target_are_bundled(self):
        patch = COMPAT.load_patch()
        self.assertEqual(patch["beforeSha256"],
                         "1b3bff6aaf28ca62a864cf97b9aa9aa45ab76de5e459f7881ba4bc8de73490b1")
        self.assertEqual(patch["afterSha256"],
                         "0511ee9eda491247efed9a875a3c2004f3124f053fd24048dadb595aaa6020d1")
        self.assertEqual(len(patch["changes"]), 3)


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="dsh-session-compat-test-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.package = self.base / "package"
        (self.package / "lib").mkdir(parents=True)
        self.manifest = self.package / "package.json"
        self.manifest.write_text(json.dumps({"name": COMPAT.PACKAGE, "version": COMPAT.VERSION}))
        self.source = self.package / "lib/index.js"
        self.before = b"/*! Synthetic upstream license; retain verbatim. */\nfunction decode() { return 2; }\n// original tail\n"
        self.after = self.before.replace(b"return 2;", b"return strictLegacy();")
        self.source.write_bytes(self.before)
        self.source.chmod(0o640)
        self.history = self.base / "native-history/session.jsonl"
        self.history.parent.mkdir()
        self.history.write_bytes(b'{"private":"synthetic untouched history"}\n')
        self.artifact = self.base / "patch.json"
        self.patch = {"schema": "agentx.dsh-session-compat/v1", "package": COMPAT.PACKAGE,
                      "version": COMPAT.VERSION, "target": COMPAT.TARGET,
                      "beforeSha256": sha(self.before), "afterSha256": sha(self.after),
                      "changes": [{"before": "return 2;", "after": "return strictLegacy();"}]}
        self.write_artifact()
        self.artifact_override = mock.patch.object(COMPAT, "ARTIFACT", self.artifact)
        self.hash_override = mock.patch.object(COMPAT, "ARTIFACT_SHA256", sha(self.artifact.read_bytes()))
        self.artifact_override.start()
        self.hash_override.start()
        self.addCleanup(self.artifact_override.stop)
        self.addCleanup(self.hash_override.stop)

    def write_artifact(self):
        self.artifact.write_text(json.dumps(self.patch), encoding="utf-8")

    def refresh_artifact(self):
        self.write_artifact()
        COMPAT.ARTIFACT_SHA256 = sha(self.artifact.read_bytes())

    def assert_refused(self, code, apply=True):
        with self.assertRaises(COMPAT.Refusal) as raised:
            COMPAT.install(self.package, apply=apply)
        self.assertEqual(raised.exception.code, code)

    def no_staging(self):
        self.assertEqual(list((self.package / "lib").glob(".dsh-session-compat-*")), [])

    def test_check_is_read_only_and_prints_pinned_plan(self):
        metadata = self.source.stat()
        history = self.history.read_bytes()
        with mock.patch.object(COMPAT.os, "replace", side_effect=AssertionError("check wrote")), \
                mock.patch.object(COMPAT.os, "open", wraps=os.open) as opened:
            result = COMPAT.install(self.package)
        self.assertEqual((result["state"], result["action"], result["mode"]),
                         ("compatible", "replace_pinned_source", "check"))
        self.assertEqual(result["installedSha256"], sha(self.before))
        self.assertEqual(result["patchedSha256"], sha(self.after))
        self.assertFalse(any(call.args[1] & os.O_CREAT for call in opened.call_args_list))
        self.assertEqual(self.source.read_bytes(), self.before)
        self.assertEqual(self.source.stat().st_ino, metadata.st_ino)
        self.assertEqual(self.source.stat().st_mtime_ns, metadata.st_mtime_ns)
        self.assertEqual(self.history.read_bytes(), history)
        self.no_staging()

    def test_apply_publishes_complete_source_preserves_license_mode_owner_and_history(self):
        previous = self.source.stat()
        history = self.history.read_bytes()
        real_replace = os.replace

        def observe_publication(source, target, **kwargs):
            with os.fdopen(os.open(source, os.O_RDONLY, dir_fd=kwargs["src_dir_fd"]), "rb") as staged:
                self.assertEqual(staged.read(), self.after)
            self.assertEqual(self.source.read_bytes(), self.before)
            return real_replace(source, target, **kwargs)

        with mock.patch.object(COMPAT.os, "replace", side_effect=observe_publication):
            result = COMPAT.install(self.package, apply=True)
        self.assertEqual(result["state"], "applied")
        self.assertEqual(result["observedSha256"], sha(self.before))
        self.assertEqual(result["installedSha256"], sha(self.after))
        self.assertEqual(self.source.read_bytes(), self.after)
        self.assertEqual(self.source.read_bytes().splitlines()[0], self.before.splitlines()[0])
        self.assertEqual(self.source.read_bytes().splitlines()[-1], self.before.splitlines()[-1])
        current = self.source.stat()
        self.assertEqual(stat.S_IMODE(current.st_mode), 0o640)
        self.assertEqual((current.st_uid, current.st_gid), (previous.st_uid, previous.st_gid))
        self.assertEqual(self.history.read_bytes(), history)
        self.no_staging()

    def test_already_applied_is_idempotent_in_both_modes(self):
        COMPAT.install(self.package, apply=True)
        previous = self.source.stat()
        with mock.patch.object(COMPAT.os, "replace", side_effect=AssertionError("replaced twice")):
            for apply in (False, True):
                result = COMPAT.install(self.package, apply=apply)
                self.assertEqual(result["state"], "already_applied")
                self.assertEqual(result["action"], "none")
        self.assertEqual(self.source.stat().st_ino, previous.st_ino)
        self.assertEqual(self.source.stat().st_mtime_ns, previous.st_mtime_ns)

    def test_unexpected_source_drift_refuses_check_and_apply(self):
        unrelated = self.before + b"// upstream changed\n"
        self.source.write_bytes(unrelated)
        for apply in (False, True):
            with self.subTest(apply=apply):
                self.assert_refused("SOURCE_DRIFT", apply=apply)
        self.assertEqual(self.source.read_bytes(), unrelated)
        self.no_staging()

    def test_name_and_version_are_both_exact(self):
        for field, value in (("version", "0.2.0-rc.3"), ("name", "other-package")):
            with self.subTest(field=field):
                manifest = {"name": COMPAT.PACKAGE, "version": COMPAT.VERSION}
                manifest[field] = value
                self.manifest.write_text(json.dumps(manifest))
                self.assert_refused("PACKAGE_MISMATCH")
        self.assertEqual(self.source.read_bytes(), self.before)

    def test_manifest_invalid_or_missing_refuses(self):
        self.manifest.write_bytes(b"not json")
        self.assert_refused("PACKAGE_INVALID")
        self.manifest.unlink()
        self.assert_refused("PATH_UNAVAILABLE")

    def test_artifact_drift_cannot_supply_unreviewed_patch(self):
        self.artifact.write_bytes(self.artifact.read_bytes() + b" ")
        self.assert_refused("ARTIFACT_DRIFT")
        self.assertEqual(self.source.read_bytes(), self.before)

    def test_artifact_has_closed_metadata_and_replacements(self):
        for key, value in (("target", "../history.jsonl"), ("version", "any"),
                           ("unexpected", True), ("changes", []),
                           ("changes", [{"before": "x", "after": "y", "count": 1}])):
            with self.subTest(key=key, value=value):
                original = dict(self.patch)
                self.patch[key] = value
                self.refresh_artifact()
                self.assert_refused("ARTIFACT_INVALID")
                self.patch = original
        self.assertEqual(self.source.read_bytes(), self.before)

    def test_each_hunk_matches_exactly_once_and_result_hash_is_verified(self):
        for changes in ([{"before": "missing", "after": "replacement"}],
                        [{"before": " ", "after": "replacement"}],
                        [{"before": "return 2;", "after": "return unreviewed();"}]):
            with self.subTest(changes=changes):
                self.patch["changes"] = changes
                self.refresh_artifact()
                self.assert_refused("ARTIFACT_INVALID")
        self.assertEqual(self.source.read_bytes(), self.before)

    def test_symlink_source_and_manifest_refuse_even_with_matching_bytes(self):
        for target in (self.source, self.manifest):
            with self.subTest(target=target.name):
                original = target.read_bytes()
                real = self.base / (target.name + ".real")
                real.write_bytes(original)
                target.unlink()
                target.symlink_to(real)
                self.assert_refused("PATH_UNAVAILABLE")
                self.assertEqual(real.read_bytes(), original)
                target.unlink()
                target.write_bytes(original)

    def test_symlink_lib_refuses_and_explicit_pnpm_root_link_works(self):
        real_lib = self.base / "real-lib"
        (self.package / "lib").rename(real_lib)
        (self.package / "lib").symlink_to(real_lib, target_is_directory=True)
        self.assert_refused("PATH_UNSAFE")
        (self.package / "lib").unlink()
        real_lib.rename(self.package / "lib")
        root_link = self.base / "pnpm-package-link"
        root_link.symlink_to(self.package, target_is_directory=True)
        self.assertEqual(COMPAT.install(root_link)["state"], "compatible")

    def test_nonregular_source_refuses_without_fifo_blocking(self):
        self.source.unlink()
        os.mkfifo(self.source)
        self.assert_refused("PATH_UNSAFE")

    def test_another_installer_lock_refuses_without_staging(self):
        with self.source.open("rb") as held:
            fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assert_refused("INSTALLER_BUSY")
        self.assertEqual(self.source.read_bytes(), self.before)
        self.no_staging()

    def run_during_staging(self, mutation):
        real_fsync = os.fsync
        called = False

        def during_fsync(descriptor):
            nonlocal called
            result = real_fsync(descriptor)
            if not called:
                called = True
                mutation()
            return result

        with mock.patch.object(COMPAT.os, "fsync", side_effect=during_fsync):
            self.assert_refused("CONCURRENT_CHANGE")

    def test_concurrent_source_edit_is_never_overwritten(self):
        changed = self.before + b"// concurrent edit\n"
        self.run_during_staging(lambda: self.source.write_bytes(changed))
        self.assertEqual(self.source.read_bytes(), changed)
        self.no_staging()

    def test_concurrent_source_inode_replacement_is_never_overwritten(self):
        replacement = self.base / "other-index.js"
        replacement.write_bytes(self.before)
        self.run_during_staging(lambda: os.replace(replacement, self.source))
        self.assertEqual(self.source.read_bytes(), self.before)
        self.no_staging()

    def test_concurrent_manifest_edit_refuses_even_if_version_still_matches(self):
        changed = self.manifest.read_bytes() + b"\n"
        self.run_during_staging(lambda: self.manifest.write_bytes(changed))
        self.assertEqual(self.source.read_bytes(), self.before)
        self.assertEqual(self.manifest.read_bytes(), changed)
        self.no_staging()

    def test_parent_directory_replacement_is_refused_and_does_not_follow_symlink(self):
        original_lib = self.base / "moved-lib"
        other_lib = self.base / "other-lib"
        other_lib.mkdir()
        other_source = other_lib / "index.js"
        other_source.write_bytes(self.before)

        def replace_lib():
            (self.package / "lib").rename(original_lib)
            (self.package / "lib").symlink_to(other_lib, target_is_directory=True)

        self.run_during_staging(replace_lib)
        self.assertEqual((original_lib / "index.js").read_bytes(), self.before)
        self.assertEqual(other_source.read_bytes(), self.before)
        self.assertEqual(list(original_lib.glob(".dsh-session-compat-*")), [])

    def test_failed_atomic_publication_keeps_original_and_cleans_staging(self):
        with mock.patch.object(COMPAT.os, "replace", side_effect=OSError("synthetic failure")):
            self.assert_refused("APPLY_FAILED")
        self.assertEqual(self.source.read_bytes(), self.before)
        self.no_staging()

    def test_staging_collision_never_overwrites_or_removes_unowned_file(self):
        collision = self.package / "lib/.dsh-session-compat-existing"
        collision.write_bytes(b"unrelated preexisting file")
        with mock.patch.object(COMPAT.secrets, "token_hex", return_value="existing"):
            self.assert_refused("APPLY_FAILED")
        self.assertEqual(collision.read_bytes(), b"unrelated preexisting file")
        self.assertEqual(self.source.read_bytes(), self.before)

    def test_lost_durability_receipt_is_unknown_and_check_reconciles_without_reapply(self):
        real_fsync = os.fsync

        def fail_directory_sync(descriptor):
            if stat.S_ISDIR(os.fstat(descriptor).st_mode):
                raise OSError("synthetic directory sync failure")
            return real_fsync(descriptor)

        with mock.patch.object(COMPAT.os, "fsync", side_effect=fail_directory_sync):
            self.assert_refused("APPLY_OUTCOME_UNKNOWN")
        self.assertEqual(self.source.read_bytes(), self.after)
        with mock.patch.object(COMPAT.os, "replace", side_effect=AssertionError("reapplied")):
            self.assertEqual(COMPAT.install(self.package)["state"], "already_applied")
        self.no_staging()

    def test_oversized_source_refuses_before_mutation(self):
        self.source.write_bytes(b"x" * (COMPAT.MAX_SOURCE_BYTES + 1))
        self.assert_refused("SOURCE_TOO_LARGE")
        self.no_staging()

    def test_cli_has_no_implicit_apply_or_external_artifact_argument(self):
        for args in (["--package-root", str(self.package)],
                     ["--package-root", str(self.package), "--check", "--apply"],
                     ["--package-root", str(self.package), "--check", "--artifact", str(self.artifact)]):
            with self.subTest(args=args), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    COMPAT.main(args)
                self.assertEqual(raised.exception.code, 2)

    def test_cli_machine_readable_plan_and_refusal(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(COMPAT.main(["--package-root", str(self.package), "--check"]), 0)
        self.assertEqual(json.loads(output.getvalue())["state"], "compatible")
        self.source.write_bytes(b"unrelated")
        error = io.StringIO()
        with contextlib.redirect_stderr(error):
            self.assertEqual(COMPAT.main(["--package-root", str(self.package), "--apply"]), 1)
        self.assertEqual(json.loads(error.getvalue())["error"], "SOURCE_DRIFT")


if __name__ == "__main__":
    unittest.main()
