"""Rebuild benchmark/data/benchmark-prompts-hard.json.

Every expected answer is computed here: puzzles are solved by brute force and
kept only when the solution is unique and every clue is needed; arithmetic,
pipelines and Python traces are executed. Run: python build.py
"""
import json, os, re
import gen_reasoning, gen_other

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "data", "benchmark-prompts-hard.json")
prompts = gen_reasoning.build() + gen_other.build()
names = [p["name"] for p in prompts]
assert len(names) == len(set(names)), "duplicate names"
for p in prompts:
    assert re.match(p["output_contract"]["pattern"], p["expected_answer"]), (p["name"], p["expected_answer"])
    assert "." not in p["expected_answer"], p["name"]
with open(OUT, "w", encoding="utf8", newline="\n") as f:
    json.dump(prompts, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(len(prompts), "prompts written")
