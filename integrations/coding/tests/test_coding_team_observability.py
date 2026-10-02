import json
import unittest
from unittest.mock import MagicMock

from integrations.coding import coding_team_observability as observed


class CodingTeamObservabilityTests(unittest.TestCase):
    def test_parses_only_the_declared_gpu_set(self):
        self.assertEqual(
            observed.parse_nvidia_smi_power("0, 24.42\n1, 25.58\n", (0, 1)),
            50_000,
        )
        with self.assertRaisesRegex(observed.ObservabilityError, "incomplete_gpu_sample"):
            observed.parse_nvidia_smi_power("0, 24.42\n", (0, 1))

    def test_integrates_baseline_subtracted_power_as_millijoules(self):
        energy, duration = observed.integrate_incremental_energy_mj(
            [(0.0, 50_000), (1.0, 150_000), (2.0, 250_000)],
            50_000,
        )
        self.assertEqual(energy, 200_000)
        self.assertEqual(duration, 2_000)

    def test_sampler_emits_fingerprinted_lower_bound_without_host_identity(self):
        readings = iter([50_000, 52_000, 51_000, 250_000])
        ticks = iter([1.0])
        sampler = observed.NvidiaSmiEnergySampler(
            "meter-host",
            (0, 1),
            baseline_seconds=2,
            interval_seconds=1,
            reader=lambda: next(readings),
            clock=lambda: next(ticks),
            sleeper=lambda _seconds: None,
        )
        self.assertEqual(sampler.collect_baseline(), 51_000)
        sampler.samples = [(0.0, 150_000)]
        sampler._thread = MagicMock()
        evidence = sampler.stop()
        self.assertEqual(evidence["measurementScope"], "gpu-incremental-lower-bound")
        self.assertEqual(evidence["energyMillijoules"], 149_000)
        self.assertEqual(evidence["sampleCount"], 2)
        self.assertRegex(evidence["evidenceFingerprint"], r"^[a-f0-9]{64}$")
        self.assertNotIn("host", evidence)

    def test_tariff_is_optional_and_uses_explicit_currency_math(self):
        energy = {
            "measurementScope": observed.ENERGY_SCOPE,
            "energyMillijoules": 3_600_000,
            "measurementDurationMs": 60_000,
            "sampleCount": 60,
            "baselineMilliwatts": 50_000,
            "source": observed.ENERGY_SOURCE,
            "evidenceFingerprint": "a" * 64,
        }
        self.assertNotIn(
            "tariff",
            observed.attach_tariff(energy, currency=None, rate_nano_currency_units_per_kwh=None),
        )
        priced = observed.attach_tariff(
            energy,
            currency="cad",
            rate_nano_currency_units_per_kwh=100_000_000,
        )
        self.assertEqual(priced["tariff"]["currency"], "CAD")
        self.assertEqual(priced["tariff"]["estimatedCostNanoCurrencyUnits"], 100_000)

    def test_malformed_multi_gpu_samples_are_rejected_or_ignored_per_rule(self):
        # Negative draw on a declared GPU is dropped, leaving the sample incomplete.
        with self.assertRaisesRegex(observed.ObservabilityError, "incomplete_gpu_sample"):
            observed.parse_nvidia_smi_power("0, 24.42\n1, -5.0\n", (0, 1))
        # Non-numeric draw on a declared GPU is ignored the same way.
        with self.assertRaisesRegex(observed.ObservabilityError, "incomplete_gpu_sample"):
            observed.parse_nvidia_smi_power("0, 24.42\n1, N/A\n", (0, 1))
        # Extra GPU lines outside the declared set are ignored; declared set is complete.
        self.assertEqual(
            observed.parse_nvidia_smi_power("0, 24.42\n1, 25.58\n2, 99.0\n", (0, 1)),
            50_000,
        )

    def test_tariff_fingerprint_is_stable_and_changes_with_input(self):
        energy = {
            "measurementScope": observed.ENERGY_SCOPE,
            "energyMillijoules": 3_600_000,
            "measurementDurationMs": 60_000,
            "sampleCount": 60,
            "baselineMilliwatts": 50_000,
            "source": observed.ENERGY_SOURCE,
            "evidenceFingerprint": "a" * 64,
        }
        first = observed.attach_tariff(
            dict(energy), currency="CAD", rate_nano_currency_units_per_kwh=100_000_000,
        )
        second = observed.attach_tariff(
            dict(energy), currency="CAD", rate_nano_currency_units_per_kwh=100_000_000,
        )
        self.assertEqual(
            first["tariff"]["evidenceFingerprint"],
            second["tariff"]["evidenceFingerprint"],
        )
        self.assertRegex(
            first["tariff"]["evidenceFingerprint"], r"^[a-f0-9]{64}$",
        )
        different = observed.attach_tariff(
            dict(energy), currency="CAD", rate_nano_currency_units_per_kwh=200_000_000,
        )
        self.assertNotEqual(
            different["tariff"]["evidenceFingerprint"],
            first["tariff"]["evidenceFingerprint"],
        )

    def test_zero_rate_tariff_is_applied_with_zero_cost(self):
        energy = {
            "measurementScope": observed.ENERGY_SCOPE,
            "energyMillijoules": 3_600_000,
            "measurementDurationMs": 60_000,
            "sampleCount": 60,
            "baselineMilliwatts": 50_000,
            "source": observed.ENERGY_SOURCE,
            "evidenceFingerprint": "a" * 64,
        }
        priced = observed.attach_tariff(
            energy,
            currency="cad",
            rate_nano_currency_units_per_kwh=0,
        )
        self.assertEqual(priced["tariff"]["currency"], "CAD")
        self.assertEqual(priced["tariff"]["rateNanoCurrencyUnitsPerKwh"], 0)
        self.assertEqual(priced["tariff"]["estimatedCostNanoCurrencyUnits"], 0)

    def test_missing_tariff_leaves_energy_evidence_unchanged(self):
        energy = {
            "measurementScope": observed.ENERGY_SCOPE,
            "energyMillijoules": 3_600_000,
            "measurementDurationMs": 60_000,
            "sampleCount": 60,
            "baselineMilliwatts": 50_000,
            "source": observed.ENERGY_SOURCE,
            "evidenceFingerprint": "a" * 64,
        }
        untouched = observed.attach_tariff(energy, currency=None, rate_nano_currency_units_per_kwh=None)
        self.assertNotIn("tariff", untouched)
        self.assertEqual(untouched, energy)

    def test_disabled_telegram_performs_no_delivery(self):
        opener = MagicMock()
        self.assertFalse(observed.send_coding_team_telegram(
            "review-ready",
            "0592",
            attempt=1,
            ui_base="https://agentx.example/pipeline",
            enabled=False,
            env={},
            opener=opener,
        ))
        opener.assert_not_called()

    def test_telegram_message_is_fixed_and_contains_no_inference_payload(self):
        message = observed.coding_team_message(
            "blocked",
            "0592",
            attempt=2,
            observed_at="2026-09-02T02:00:00Z",
            ui_base="https://agentx.example/pipeline",
        )
        self.assertEqual(message.splitlines(), [
            "AgentX Coding Team",
            "Task 0592 · attempt 2 · blocked",
            "Observed 2026-09-02T02:00:00Z",
            "Open https://agentx.example/pipeline?task=0592",
        ])
        for forbidden in ("prompt", "transcript", "tool", "code", "host", "path"):
            self.assertNotIn(forbidden, message.lower())

    def test_enabled_telegram_uses_no_parse_mode_and_accepts_only_fixed_text(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps({"ok": True}).encode("utf-8")

        opener = MagicMock(return_value=Response())
        self.assertTrue(observed.send_coding_team_telegram(
            "claimed",
            "0592",
            attempt=1,
            ui_base="https://agentx.example/pipeline",
            enabled=True,
            env={
                "CODING_TEAM_TELEGRAM_BOT_TOKEN": "1234567890:abcdefghijklmnopqrstuvwxyz",
                "CODING_TEAM_TELEGRAM_CHAT_ID": "-12345",
            },
            opener=opener,
        ))
        request = opener.call_args.args[0]
        body = request.data.decode("utf-8")
        self.assertNotIn("parse_mode", body)
        self.assertNotIn("prompt", body.lower())


if __name__ == "__main__":
    unittest.main()
