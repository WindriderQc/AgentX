import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "coding-dispatcher.py"
SPEC = importlib.util.spec_from_file_location("coding_dispatcher", MODULE_PATH)
dispatcher = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = dispatcher
SPEC.loader.exec_module(dispatcher)


def automation(**overrides):
    raw = {
        "schema": dispatcher.AUTOMATION_SCHEMA,
        "mode": "review_only",
        "policyRef": "agentx.reviewed-code/v1",
        "dataClassification": "internal",
        "operations": ["create", "update"],
        "scope": ["integrations/coding/coding-dispatcher.py", "integrations/coding/tests/test_coding_dispatcher.py"],
        "lockKeys": ["repo:agentx:dispatcher"],
        "executionProfile": "clawdx-file-tools/v1",
        "verificationProfile": "agentx-dispatcher-tests/v1",
        "budgets": {
            "maxDurationMs": 900000,
            "maxAttempts": 2,
            "maxCostNanodollars": 0,
        },
        "humanGates": ["review", "merge", "deploy"],
        "sourceFiles": ["integrations/coding/coding-dispatcher.py"],
    }
    raw.update(overrides)
    return dispatcher.normalize_automation(raw)


def config(*, enabled=False):
    return {
        "schema": dispatcher.CONFIG_SCHEMA,
        "enabled": enabled,
        "defaultMode": "shadow",
        "maxConcurrent": 1,
        "maxCandidates": 200,
        "apiBase": "https://agentx.example",
        "policies": {
            "agentx.reviewed-code/v1": {
                "repository": "agentx",
                "requireAuthoritySources": True,
                "allowedPathPrefixes": ["integrations/coding/", "scripts/", "docs/"],
                "protectedPathPrefixes": ["scripts/deploy-main.ps1", "LEAD.md"],
                "allowedDataClassifications": ["public", "internal"],
                "allowedOperations": ["create", "update"],
                "executionProfiles": ["clawdx-file-tools/v1"],
                "verificationProfiles": ["agentx-dispatcher-tests/v1"],
                "ceilings": {
                    "maxScopeFiles": 8,
                    "maxSourceFiles": 12,
                    "maxDurationMs": 900000,
                    "maxAttempts": 2,
                    "maxCostNanodollars": 0,
                },
            }
        },
        "executionProfiles": {
            "clawdx-file-tools/v1": {
                "adapter": "clawdx-guarded",
                "pipelineApiBase": "http://agentx:3080",
                "host": "worker",
                "remoteRepo": "/home/operator/.openclaw/workspace-clawdx-coder/repo",
                "agent": "clawdx-coder",
                "workerHelper": "/srv/openclaw_pipeline_worker.py",
                "model": "ollama/agentx-pipeline",
                "costEvidenceMode": "local-zero",
                "attestAttribution": True,
                "localEnergyEvidence": {
                    "measurementScope": "gpu-incremental-lower-bound",
                    "meterHost": "meter",
                    "gpuIndices": [0, 1],
                    "baselineSeconds": 10,
                    "sampleIntervalSeconds": 1,
                    "tariffCurrency": None,
                    "tariffRateNanoCurrencyUnitsPerKwh": None,
                },
                "telegramNotifications": {
                    "enabled": False,
                    "uiBase": "https://agentx.example/pipeline",
                },
            }
        },
        "verificationProfiles": {
            "agentx-dispatcher-tests/v1": {
                "command": "python -m unittest scripts.tests.test_coding_dispatcher",
                "timeoutSeconds": 900,
                "maxChangedFiles": 8,
                "maxChangedBytes": 100000,
            }
        },
    }


def task(task_id="0700", **overrides):
    value = {
        "pipelineId": task_id,
        "title": "Low-risk dispatcher change",
        "status": "queued",
        "assignee": None,
        "risk": "low",
        "priority": 2,
        "dependsOn": [],
        "automationAttemptCount": 0,
        "automation": automation(),
    }
    value.update(overrides)
    return value


class CodingDispatcherTests(unittest.TestCase):
    def test_legacy_repository_policy_requires_explicit_task_retargeting(self):
        settings = config()
        settings["policies"]["agentx.reviewed-code/v1"]["repository"] = "aiops"
        decision = dispatcher.evaluate_task(task(), config=settings, statuses={}, active_count=0,
                                            active_locks=set(), now=dispatcher.parse_timestamp("2026-09-01T00:00:00Z"))
        self.assertFalse(decision["admissible"])
        self.assertIn("repository_not_canonical", [row["code"] for row in decision["reasons"]])

    def test_canonical_profile_passes_one_repository_to_the_existing_worker(self):
        deployed = dispatcher.load_config(MODULE_PATH.parent / "config.example.json")
        selected = automation(scope=["docs/ARCHITECTURE.md"], sourceFiles=["docs/ARCHITECTURE.md"])
        command = dispatcher.build_adapter(config=deployed, automation=selected).command(task(), selected)
        self.assertEqual(command[command.index("--repository") + 1], "agentx")
        self.assertIn("integrations/coding/tests", command[command.index("--independent-verification-command") + 1])
        self.assertEqual(command[command.index("--remote-repo") + 1], deployed["executionProfiles"]["clawdx-file-tools/v1"]["remoteRepo"])


    def test_example_requires_explicit_native_instance_configuration(self):
        deployed = dispatcher.load_config(MODULE_PATH.parent / "config.example.json")
        self.assertFalse(deployed["enabled"])
        self.assertFalse(deployed["promotion"]["enabled"])
        self.assertEqual(deployed["defaultMode"], "shadow")
        self.assertEqual(deployed["maxConcurrent"], 1)
        execution = deployed["executionProfiles"]["clawdx-file-tools/v1"]
        self.assertEqual(execution["repository"], "agentx")
        self.assertEqual(execution["costEvidenceMode"], "local-zero")
        self.assertFalse(execution["telegramNotifications"]["enabled"])
        self.assertNotEqual(dispatcher.DEFAULT_CONFIG, MODULE_PATH.parent / "config.example.json")


    def test_product_fingerprint_is_recomputed_and_drift_fails_closed(self):
        normalized = automation()
        self.assertRegex(normalized["fingerprint"], r"^[a-f0-9]{64}$")
        self.assertEqual(dispatcher.normalize_automation(normalized), normalized)

        normalized["scope"] = ["scripts/other.py"]
        with self.assertRaisesRegex(dispatcher.DispatcherError, "fingerprint"):
            dispatcher.normalize_automation(normalized)

    def test_fingerprint_matches_the_product_canonical_fixture(self):
        normalized = dispatcher.normalize_automation(
            {
                "schema": dispatcher.AUTOMATION_SCHEMA,
                "mode": "review_only",
                "policyRef": "aiops.low-risk-code/v1",
                "dataClassification": "internal",
                "operations": ["update", "create"],
                "scope": [
                    "scripts/coding-dispatcher.py",
                    "docs/operations/CODING_DISPATCHER_V1.md",
                ],
                "lockKeys": ["repo:aiops:dispatcher"],
                "executionProfile": "clawdx-file-tools/v1",
                "verificationProfile": "aiops-dispatcher-tests/v1",
                "budgets": {
                    "maxDurationMs": 900000,
                    "maxAttempts": 2,
                    "maxCostNanodollars": 0,
                },
                "humanGates": ["review", "merge", "deploy"],
            }
        )
        self.assertEqual(
            normalized["fingerprint"],
            "ddb06a9a4ea23df1f31972a5ac004b14a7ae1cfa10ef3f1af815eb0523a62d04",
        )


    def test_shadow_report_is_read_only_and_surfaces_admission_reasons(self):
        tasks = [
            {"pipelineId": "0699", "title": "dependency", "status": "done"},
            task("0700"),
            task("0701", risk="medium"),
            task("0702", automation=None),
        ]
        report = dispatcher.build_report(
            tasks,
            config=config(),
            mode="shadow",
            now=dispatcher.parse_timestamp("2026-09-01T00:00:00Z"),
        )

        self.assertFalse(report["mutationAuthorized"])
        self.assertEqual(report["dispatch"], {"attempted": False, "reason": "shadow_mode"})
        self.assertEqual(report["summary"]["admissibleTasks"], 1)
        by_id = {decision["pipelineId"]: decision for decision in report["decisions"]}
        self.assertTrue(by_id["0700"]["admissible"])
        self.assertIn("risk_not_low", [item["code"] for item in by_id["0701"]["reasons"]])
        self.assertIn("automation_invalid", [item["code"] for item in by_id["0702"]["reasons"]])

    def test_shadow_report_excludes_private_personal_family_household_and_idea_titles(self):
        personal = task("0710", title="private household title", service="personal")
        idea = task("0711", title="private idea title", source="idea-drop")
        family = task("0712", title="private family title", service="family")
        household = task("0713", title="private household-source title", source="household-parent")
        report = dispatcher.build_report(
            [task("0700"), personal, idea, family, household],
            config=config(),
            mode="shadow",
            now=dispatcher.parse_timestamp("2026-09-01T00:00:00Z"),
        )

        serialized = json.dumps(report)
        self.assertNotIn("private household title", serialized)
        self.assertNotIn("private idea title", serialized)
        self.assertNotIn("private family title", serialized)
        self.assertNotIn("private household-source title", serialized)
        self.assertEqual(report["summary"]["excludedPrivateTasks"], 4)
        self.assertEqual([item["pipelineId"] for item in report["decisions"]], ["0700"])

    def test_live_reader_requests_summary_only_and_rejects_truncated_evidence(self):
        client = dispatcher.PipelineClient("https://agentx.example")
        payload = {
            "ok": True,
            "data": {
                "tasks": [task()],
                "evidence": {"rows": {"truncated": False}},
            },
        }
        with patch.object(client, "request_json", return_value=payload) as request_json:
            self.assertEqual(client.list_tasks(1000)[0]["pipelineId"], "0700")
        requested_path = request_json.call_args.args[0]
        self.assertIn("view=summary", requested_path)
        self.assertIn("includeDone=true", requested_path)

        payload["data"]["evidence"]["rows"]["truncated"] = True
        with patch.object(client, "request_json", return_value=payload):
            with self.assertRaisesRegex(dispatcher.DispatcherError, "truncated"):
                client.list_tasks(1000)

    def test_protected_delete_dependency_lock_and_attempt_gates_are_machine_readable(self):
        guarded = automation(
            operations=["delete"],
            scope=["scripts/deploy-main.ps1"],
            lockKeys=["repo:agentx:busy"],
        )
        candidate = task(
            "0703",
            dependsOn=["0698"],
            automationAttemptCount=2,
            automation=guarded,
        )
        reasons = dispatcher.evaluate_task(
            candidate,
            config=config(),
            statuses={"0698": "review"},
            active_count=0,
            active_locks={"repo:agentx:busy"},
            now=dispatcher.parse_timestamp("2026-09-01T00:00:00Z"),
        )["reasons"]
        codes = [item["code"] for item in reasons]
        self.assertIn("dependencies_incomplete", codes)
        self.assertIn("operation_denied", codes)
        self.assertIn("protected_scope", codes)
        self.assertIn("attempt_budget_exhausted", codes)
        self.assertIn("resource_lock_conflict", codes)

    def test_authority_sources_are_required_and_bounded_by_policy(self):
        missing = automation()
        missing.pop("sourceFiles")
        missing["fingerprint"] = dispatcher.stable_fingerprint({
            key: value for key, value in missing.items() if key != "fingerprint"
        })
        decision = dispatcher.evaluate_task(
            task(automation=missing),
            config=config(),
            statuses={},
            active_count=0,
            active_locks=set(),
            now=dispatcher.parse_timestamp("2026-09-01T00:00:00Z"),
        )
        self.assertIn("authority_sources_missing", [item["code"] for item in decision["reasons"]])

    def test_active_autonomous_task_occupies_the_single_v1_slot(self):
        active = task("0704", status="in_progress", assignee="worker-a")
        report = dispatcher.build_report(
            [active, task("0705")],
            config=config(),
            mode="shadow",
            now=dispatcher.parse_timestamp("2026-09-01T00:00:00Z"),
        )
        decision = report["decisions"][0]
        self.assertIn("resource_lock_conflict", [item["code"] for item in decision["reasons"]])
        self.assertIn("concurrency_limit", [item["code"] for item in decision["reasons"]])

    def test_clawdx_adapter_uses_direct_argv_and_requests_automated_lease(self):
        selected = automation()
        adapter = dispatcher.build_adapter(config=config(), automation=selected)
        command = adapter.command(task(), selected)
        self.assertNotIn("--repair-attempt", command)
        resumed = task()
        resumed["automationAttemptCount"] = 1
        self.assertIn("--repair-attempt", adapter.command(resumed, selected))

        self.assertIn("--automated-lease", command)
        self.assertIn("--allow-dispatch", command)
        self.assertIn("--attest-attribution", command)
        self.assertEqual(command[command.index("--cost-evidence-mode") + 1], "local-zero")
        self.assertEqual(command[command.index("--attribution-attempt") + 1], "1")
        self.assertEqual(command[command.index("--lease-duration-ms") + 1], "900000")
        self.assertEqual(command[command.index("--task-id") + 1], "0700")
        self.assertEqual(
            [command[index + 1] for index, value in enumerate(command) if value == "--allowed-path"],
            ["integrations/coding/coding-dispatcher.py", "integrations/coding/tests/test_coding_dispatcher.py"],
        )
        self.assertEqual(command[command.index("--energy-meter-host") + 1], "meter")
        self.assertEqual(
            [command[index + 1] for index, value in enumerate(command) if value == "--energy-gpu-index"],
            ["0", "1"],
        )
        self.assertNotIn("--electricity-tariff-currency", command)
        self.assertNotIn("--telegram-notifications", command)
        self.assertEqual(
            command[command.index("--telegram-ui-base") + 1],
            "https://agentx.example/pipeline",
        )

    def test_verifier_repair_turn_requires_explicit_bounded_profile_setting(self):
        deployed = config()
        profile = deployed["verificationProfiles"]["agentx-dispatcher-tests/v1"]
        adapter = dispatcher.build_adapter(config=deployed, automation=automation())
        self.assertNotIn("--verification-repair-turns", adapter.command(task(), automation()))
        profile["repairTurns"] = 1
        self.assertEqual(adapter.command(task(), automation()).count("--verification-repair-turns"), 1)
        for invalid in (-1, 2, True, "1"):
            with self.subTest(value=invalid):
                profile["repairTurns"] = invalid
                with self.assertRaisesRegex(dispatcher.DispatcherError, "repairTurns"):
                    adapter.command(task(), automation())

    def test_partial_tariff_fails_closed_instead_of_building_a_command(self):
        for field, value in (
            ("tariffCurrency", "CAD"),
            ("tariffRateNanoCurrencyUnitsPerKwh", 100_000_000),
        ):
            with self.subTest(field=field):
                deployed = config()
                energy = deployed["executionProfiles"]["clawdx-file-tools/v1"][
                    "localEnergyEvidence"
                ]
                energy[field] = value
                adapter = dispatcher.build_adapter(
                    config=deployed,
                    automation=automation(),
                )
                with self.assertRaisesRegex(
                    dispatcher.DispatcherError,
                    "tariff currency and rate",
                ):
                    adapter.command(task(), automation())

    def test_invalid_gpu_index_fails_closed_instead_of_building_a_command(self):
        for gpu_indices in ([-1, 1], ["0", 1]):
            with self.subTest(gpu_indices=gpu_indices):
                deployed = config()
                deployed["executionProfiles"]["clawdx-file-tools/v1"][
                    "localEnergyEvidence"
                ]["gpuIndices"] = gpu_indices
                adapter = dispatcher.build_adapter(
                    config=deployed,
                    automation=automation(),
                )
                with self.assertRaisesRegex(dispatcher.DispatcherError, "gpuIndices"):
                    adapter.command(task(), automation())

    def test_missing_meter_identity_fails_closed_instead_of_building_a_command(self):
        deployed = config()
        deployed["executionProfiles"]["clawdx-file-tools/v1"][
            "localEnergyEvidence"
        ]["meterHost"] = "  "
        adapter = dispatcher.build_adapter(config=deployed, automation=automation())

        with self.assertRaisesRegex(dispatcher.DispatcherError, "meterHost and gpuIndices"):
            adapter.command(task(), automation())

    def test_default_disabled_telegram_never_flags_notifications(self):
        deployed = config()
        adapter = dispatcher.build_adapter(config=deployed, automation=automation())

        command = adapter.command(task(), automation())

        self.assertNotIn("--telegram-notifications", command)
        self.assertIn("--telegram-ui-base", command)

    def test_paid_profile_is_disabled_even_with_a_positive_task_budget(self):
        selected = automation(budgets={
            "maxDurationMs": 900000,
            "maxAttempts": 2,
            "maxCostNanodollars": 10_000_000,
        })
        deployed = config()
        execution = deployed["executionProfiles"]["clawdx-file-tools/v1"]
        execution["model"] = "openrouter/z-ai/glm-5.2"
        execution["costEvidenceMode"] = "provider-billed"
        execution["attestAttribution"] = False
        decision = dispatcher.evaluate_task(
            task(automation=selected),
            config=deployed,
            statuses={},
            active_count=0,
            active_locks=set(),
            now=dispatcher.parse_timestamp("2026-09-01T00:00:00Z"),
        )
        self.assertIn("paid_execution_disabled", [item["code"] for item in decision["reasons"]])

    def test_example_shadow_execution_never_launches_a_worker(self):
        loaded = dispatcher.load_config(MODULE_PATH.parent / "config.example.json")
        report = dispatcher.build_report([task()], config=loaded, mode="shadow",
                                         now=dispatcher.parse_timestamp("2026-09-01T00:00:00Z"))
        self.assertFalse(report["mutationAuthorized"])
        self.assertFalse(report["dispatch"]["attempted"])


    def test_canary_requires_reviewed_config_gate_before_adapter_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "config.json"
            tasks_path = root / "tasks.json"
            config_path.write_text(json.dumps(config()), encoding="utf-8")
            tasks_path.write_text(json.dumps([task()]), encoding="utf-8")
            argv = [
                "coding-dispatcher.py",
                "--config",
                str(config_path),
                "--tasks-file",
                str(tasks_path),
                "--mode",
                "canary",
                "--task-id",
                "0700",
                "--allow-dispatch",
            ]
            with patch.object(dispatcher.sys, "argv", argv), patch.object(
                dispatcher.ClawdXGuardedAdapter, "run"
            ) as run:
                self.assertEqual(dispatcher.main(), 2)
                run.assert_not_called()

    def test_scheduled_canary_dispatches_only_first_admissible_task(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "config.json"
            tasks_path = root / "tasks.json"
            config_path.write_text(json.dumps(config(enabled=True)), encoding="utf-8")
            tasks_path.write_text(
                json.dumps([
                    task("0702", priority=2),
                    task("0701", priority=1),
                    task("0700", priority=0, risk="medium"),
                ]),
                encoding="utf-8",
            )
            argv = [
                "coding-dispatcher.py",
                "--config",
                str(config_path),
                "--tasks-file",
                str(tasks_path),
                "--mode",
                "canary",
                "--select-first-admissible",
                "--allow-dispatch",
            ]
            with patch.object(dispatcher.sys, "argv", argv), patch.object(
                dispatcher, "build_adapter"
            ) as build_adapter:
                build_adapter.return_value.run.return_value = dispatcher.DispatchResult(
                    adapter="test", exit_code=0
                )
                self.assertEqual(dispatcher.main(), 0)
            build_adapter.return_value.run.assert_called_once()
            self.assertEqual(build_adapter.return_value.run.call_args.args[0]["pipelineId"], "0701")

    def test_scheduled_canary_exits_cleanly_when_nothing_is_admissible(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "config.json"
            tasks_path = root / "tasks.json"
            config_path.write_text(json.dumps(config(enabled=True)), encoding="utf-8")
            tasks_path.write_text(
                json.dumps([task("0700", risk="medium")]),
                encoding="utf-8",
            )
            argv = [
                "coding-dispatcher.py",
                "--config",
                str(config_path),
                "--tasks-file",
                str(tasks_path),
                "--mode",
                "canary",
                "--select-first-admissible",
                "--allow-dispatch",
            ]
            with patch.object(dispatcher.sys, "argv", argv), patch.object(
                dispatcher, "build_adapter"
            ) as build_adapter:
                self.assertEqual(dispatcher.main(), 0)
                build_adapter.assert_not_called()

    def test_resource_preflight_deferral_is_a_clean_scheduled_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "config.json"
            tasks_path = root / "tasks.json"
            config_path.write_text(json.dumps(config(enabled=True)), encoding="utf-8")
            tasks_path.write_text(json.dumps([task()]), encoding="utf-8")
            argv = [
                "coding-dispatcher.py",
                "--config",
                str(config_path),
                "--tasks-file",
                str(tasks_path),
                "--mode",
                "canary",
                "--select-first-admissible",
                "--allow-dispatch",
            ]
            with patch.object(dispatcher.sys, "argv", argv), patch.object(
                dispatcher, "build_adapter"
            ) as build_adapter:
                build_adapter.return_value.run.return_value = dispatcher.DispatchResult(
                    adapter="test", exit_code=4
                )
                self.assertEqual(dispatcher.main(), 0)

    def test_canary_rejects_ambiguous_exact_and_scheduled_selection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "config.json"
            tasks_path = root / "tasks.json"
            config_path.write_text(json.dumps(config(enabled=True)), encoding="utf-8")
            tasks_path.write_text(json.dumps([task()]), encoding="utf-8")
            argv = [
                "coding-dispatcher.py",
                "--config",
                str(config_path),
                "--tasks-file",
                str(tasks_path),
                "--mode",
                "canary",
                "--task-id",
                "0700",
                "--select-first-admissible",
                "--allow-dispatch",
            ]
            with patch.object(dispatcher.sys, "argv", argv), patch.object(
                dispatcher, "build_adapter"
            ) as build_adapter:
                self.assertEqual(dispatcher.main(), 2)
                build_adapter.assert_not_called()


if __name__ == "__main__":
    unittest.main()
