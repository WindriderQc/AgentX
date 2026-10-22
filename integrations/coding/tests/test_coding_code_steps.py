import importlib.util
from pathlib import Path
import unittest


HERE = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


steps = load("coding_code_steps")


def proposed_plan():
    return {
        "schema": steps.PLAN_SCHEMA,
        "summary": "Implement parsing, then connect the endpoint.",
        "steps": [
            {"id": "step-01", "title": "Parse requests", "objective": "Add bounded request parsing.",
             "paths": ["core/src/parser.js"], "testTargets": ["core/tests/parser.test.js"], "dependsOn": []},
            {"id": "step-02", "title": "Connect route", "objective": "Use the parser from the route.",
             "paths": ["core/routes/example.js"], "testTargets": ["core/tests/example.test.js"],
             "dependsOn": ["step-01"]},
        ],
    }


class StepBudgetTest(unittest.TestCase):
    def test_uses_only_the_contract_budget_sources_and_clamps_context(self):
        self.assertEqual(steps.step_budget()["source"], "default")
        self.assertEqual(steps.step_budget({"context": {"knee": 32768}})["source"], "speed_knee")
        large = steps.step_budget({"agent": {"recommendedStepContext": 200000}})
        self.assertEqual((large["source"], large["stepContext"], large["maxFilesPerStep"]),
                         ("agent_workload", 65536, 8))
        small = steps.step_budget({"recommendedStepContext": 2000})
        self.assertEqual((small["source"], small["stepContext"]), ("agent_workload", 8192))

    def test_lane_limits_can_only_tighten_runner_bounds(self):
        budget = steps.step_budget({"agent": {"recommendedStepContext": 65536, "codeStepLimits": {
            "maxSteps": 3, "maxFilesPerStep": 2, "maxTestsPerStep": 1, "maxObjectiveChars": 400}}})
        self.assertEqual({key: budget[key] for key in
                          ("maxSteps", "maxFilesPerStep", "maxTestsPerStep", "maxObjectiveChars")},
                         {"maxSteps": 3, "maxFilesPerStep": 2, "maxTestsPerStep": 1, "maxObjectiveChars": 400})
        self.assertEqual(steps.step_budget({"agent": {"codeStepLimits": {"maxSteps": 99}}})["maxSteps"], 16)


class PlanValidationTest(unittest.TestCase):
    def setUp(self):
        self.scope = ["core/src/parser.js", "core/routes/example.js", "unused.js"]

    def test_returns_a_canonical_bounded_plan_and_accepts_a_json_fence(self):
        plan = proposed_plan()
        text = "```json\n" + __import__("json").dumps(plan) + "\n```"
        self.assertEqual(steps.validate_plan(text, self.scope), plan)

    def test_rejects_scope_escape_noncanonical_paths_and_unknown_fields(self):
        mutations = [
            lambda plan: plan["steps"][0]["paths"].__setitem__(0, "outside.js"),
            lambda plan: plan["steps"][0]["paths"].__setitem__(0, "core/../secret"),
            lambda plan: plan["steps"][0]["testTargets"].__setitem__(0, "/tmp/test.py"),
            lambda plan: plan.update(extra=True),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                plan = proposed_plan()
                mutation(plan)
                with self.assertRaises(steps.CodePlanError):
                    steps.validate_plan(plan, self.scope)

    def test_requires_sequential_ids_and_backward_dependencies(self):
        plan = proposed_plan()
        plan["steps"][1]["dependsOn"] = ["step-02"]
        with self.assertRaisesRegex(steps.CodePlanError, "earlier step ids"):
            steps.validate_plan(plan, self.scope)
        plan = proposed_plan()
        plan["steps"][1]["id"] = "route"
        with self.assertRaisesRegex(steps.CodePlanError, "step-02"):
            steps.validate_plan(plan, self.scope)

    def test_reused_path_requires_an_explicit_dependency_on_its_prior_owner(self):
        plan = proposed_plan()
        plan["steps"][1]["paths"] = ["core/src/parser.js"]
        plan["steps"][1]["dependsOn"] = []
        with self.assertRaisesRegex(steps.CodePlanError, "same paths"):
            steps.validate_plan(plan, self.scope)
        plan["steps"][1]["dependsOn"] = ["step-01"]
        self.assertEqual(steps.validate_plan(plan, self.scope)["steps"][1]["paths"], ["core/src/parser.js"])

    def test_enforces_lane_file_test_and_step_bounds(self):
        plan = proposed_plan()
        capability = {"agent": {"codeStepLimits": {"maxSteps": 1, "maxFilesPerStep": 1, "maxTestsPerStep": 1}}}
        with self.assertRaisesRegex(steps.CodePlanError, "steps must contain 1-1"):
            steps.validate_plan(plan, self.scope, capability)
        plan["steps"] = [plan["steps"][0]]
        plan["steps"][0]["paths"].append("core/routes/example.js")
        with self.assertRaisesRegex(steps.CodePlanError, "paths must contain 1-1"):
            steps.validate_plan(plan, self.scope, capability)

    def test_plan_and_step_prompts_preserve_runner_ownership(self):
        budget = steps.step_budget()
        prompt = steps.plan_prompt({"title": "Bound work"}, {"scope": self.scope}, "/private/plan.json", budget)
        self.assertIn("Do not edit source files", prompt)
        self.assertIn("/private/plan.json", prompt)
        self.assertIn("core/src/parser.js", prompt)
        self.assertNotIn("focused test command", prompt)
        turn = steps.step_prompt({"title": "Bound work"}, proposed_plan()["steps"][0],
                                 [{"id": "step-00", "state": "verified"}],
                                 {"profile": "agentx-core-runner-tests/v1"})
        self.assertIn("Do not commit, push, publish", turn)
        self.assertIn("core/tests/parser.test.js", turn)


if __name__ == "__main__":
    unittest.main()
