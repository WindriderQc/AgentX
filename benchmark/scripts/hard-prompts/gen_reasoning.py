"""Reasoning prompts with a unique solution, found and proven by brute force."""
import itertools, random

ISLANDERS = ["A", "B", "C", "D", "E", "F", "G", "H"]
WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five"}


def knights_instance(seed):
    """Eight speakers, one statement each; exactly one consistent assignment."""
    rng = random.Random(seed)
    people = ISLANDERS

    def make(speaker):
        others = [p for p in people if p != speaker]
        kind = rng.choice(["knave", "same", "different", "exactly", "atleast", "implies", "ofthree", "iff", "parity", "likeme"])
        if kind == "knave":
            x = rng.choice(others)
            return (f'{x} is a knave.', lambda t, x=x: not t[x])
        if kind == "same":
            x, y = rng.sample(others, 2)
            return (f'{x} and {y} are the same type.', lambda t, x=x, y=y: t[x] == t[y])
        if kind == "different":
            x, y = rng.sample(others, 2)
            return (f'{x} and {y} are of different types.', lambda t, x=x, y=y: t[x] != t[y])
        if kind == "exactly":
            k = rng.choice([2, 3, 4, 5])
            return (f'Exactly {WORDS[k]} of us eight are knights.', lambda t, k=k: sum(t.values()) == k)
        if kind == "atleast":
            x, y = rng.sample(others, 2)
            return (f'At least one of {x} and {y} is a knight.', lambda t, x=x, y=y: t[x] or t[y])
        if kind == "implies":
            x, y = rng.sample(others, 2)
            return (f'If {x} is a knight, then {y} is a knave.', lambda t, x=x, y=y: (not t[x]) or (not t[y]))
        if kind == "ofthree":
            x, y, z = rng.sample(others, 3)
            k = rng.choice([1, 2])
            return (f'Exactly {WORDS[k]} of {x}, {y} and {z} {"is a knight" if k == 1 else "are knights"}.',
                    lambda t, x=x, y=y, z=z, k=k: t[x] + t[y] + t[z] == k)
        if kind == "iff":
            x, y = rng.sample(others, 2)
            return (f'{x} is a knight if and only if {y} is a knave.', lambda t, x=x, y=y: t[x] == (not t[y]))
        if kind == "parity":
            return ('The number of knights among us eight is odd.', lambda t: sum(t.values()) % 2 == 1)
        x, y = rng.sample(others, 2)
        return (f'{x} is the same type as me, and {y} is not.', lambda t, x=x, y=y, s=speaker: t[x] == t[s] and t[y] != t[s])

    while True:
        statements = {p: make(p) for p in people}
        solutions = []
        for bits in itertools.product([True, False], repeat=len(people)):
            t = dict(zip(people, bits))
            if all(bool(statements[p][1](t)) == t[p] for p in people):
                solutions.append(t)
        if len(solutions) == 1 and 3 <= sum(solutions[0].values()) <= 5:
            kinds = {statements[p][0].split()[0] + statements[p][0].split()[-1] for p in people}
            if len(kinds) >= 6:
                return statements, solutions[0]


def knights_prompt(seed, name):
    statements, solution = knights_instance(seed)
    lines = " ".join(f'{p} says: "{statements[p][0]}"' for p in ISLANDERS)
    answer = ",".join(f'{p}={"knight" if solution[p] else "knave"}' for p in ISLANDERS)
    form = ",".join(f"{p}=<type>" for p in ISLANDERS)
    return {
        "name": name,
        "prompt": ("On an island, knights always tell the truth and knaves always lie. Eight inhabitants speak. " + lines
                   + f" Determine the type of each. Output only one line in the form {form}, where each type is knight or knave."),
        "level": 5, "category": "reasoning", "scoring_type": "reasoning", "expected_tokens": 60,
        "expected_answer": answer,
        "judge_criteria": ["Every speaker's statement is true exactly when the speaker is a knight", "The assignment is the only consistent one",
                           "Outputs only the requested line"],
        "deterministic_scoring": {"type": "exact", "case_sensitive": False},
        "output_contract": {"type": "regex", "pattern": "^" + ",".join(f"{p}=(knight|knave)" for p in ISLANDERS) + "$"},
    }


SEATED = ["Ana", "Ben", "Cara", "Dev", "Eli", "Fay", "Gus", "Hana"]


def all_needed(clues, universe):
    """Dropping any one clue must leave several solutions."""
    for drop in clues:
        rest = [c[1] for c in clues if c is not drop]
        found = 0
        for state in universe:
            if all(check(state) for check in rest):
                found += 1
                if found > 1:
                    break
        if found <= 1:
            return False
    return True


def seating_instance(seed):
    rng = random.Random(seed)
    people = SEATED
    last = len(people) - 1
    perms = list(itertools.permutations(people))

    def make():
        kind = rng.choice(["left", "adjacent", "notadjacent", "gap", "end", "notend", "seat", "immediately", "between"])
        x, y, z = rng.sample(people, 3)
        if kind == "left":
            return (f"{x} sits somewhere to the left of {y}.", lambda p: p.index(x) < p.index(y))
        if kind == "adjacent":
            return (f"{x} sits next to {y}.", lambda p: abs(p.index(x) - p.index(y)) == 1)
        if kind == "notadjacent":
            return (f"{x} does not sit next to {y}.", lambda p: abs(p.index(x) - p.index(y)) != 1)
        if kind == "gap":
            k = rng.choice([1, 2, 3])
            return (f"Exactly {WORDS[k]} seat{'' if k == 1 else 's'} separate{'s' if k == 1 else ''} {x} and {y}.",
                    lambda p, k=k: abs(p.index(x) - p.index(y)) == k + 1)
        if kind == "end":
            return (f"{x} sits at one of the two ends.", lambda p: p.index(x) in (0, last))
        if kind == "notend":
            return (f"{x} does not sit at either end.", lambda p: p.index(x) not in (0, last))
        if kind == "immediately":
            return (f"{x} sits immediately to the right of {y}.", lambda p: p.index(x) == p.index(y) + 1)
        if kind == "between":
            return (f"{x} sits somewhere between {y} and {z}.",
                    lambda p: min(p.index(y), p.index(z)) < p.index(x) < max(p.index(y), p.index(z)))
        s = rng.choice([2, 3, 4, 5, 6, 7])
        return (f"{x} is not in seat {s}.", lambda p, s=s: p.index(x) != s - 1)

    while True:
        clues, remaining = [], perms
        for _ in range(22):
            clue = make()
            kept = [p for p in remaining if clue[1](p)]
            if 0 < len(kept) < len(remaining):
                clues.append(clue)
                remaining = kept
            if len(remaining) == 1:
                break
        if len(remaining) == 1 and 9 <= len(clues) <= 13 and all_needed(clues, perms):
            return clues, remaining[0]


def seating_prompt(seed, name):
    clues, order = seating_instance(seed)
    names = "(" + "|".join(SEATED) + ")"
    return {
        "name": name,
        "prompt": ("Eight people, Ana, Ben, Cara, Dev, Eli, Fay, Gus and Hana, sit in a row of eight seats numbered 1 to 8 from left to right, one per seat. "
                   + " ".join(c[0] for c in clues)
                   + " Give the seating from seat 1 to seat 8. Output only the eight names separated by commas, with no spaces."),
        "level": 5, "category": "reasoning", "scoring_type": "reasoning", "expected_tokens": 40,
        "expected_answer": ",".join(order),
        "judge_criteria": ["Every clue holds for the seating", "The seating is the only one that satisfies all clues", "Outputs only the eight names"],
        "deterministic_scoring": {"type": "exact", "case_sensitive": False},
        "output_contract": {"type": "regex", "pattern": f"^{names}(,{names}){{7}}$"},
    }


TENANTS = ["Ana", "Ben", "Cara", "Dev", "Eli", "Fay"]
PETS = ["cat", "dog", "owl", "fox", "hen", "bat"]
_GRID = None


def grid_universe():
    global _GRID
    if _GRID is None:
        perms = list(itertools.permutations(range(6)))
        # state = (floor of each tenant, pet index of each tenant)
        _GRID = [(f, p) for f in perms for p in perms]
    return _GRID


def building_instance(seed):
    rng = random.Random(seed)
    universe = grid_universe()
    T = {name: i for i, name in enumerate(TENANTS)}

    def floor_of_pet(state, pet):
        return state[0][state[1].index(pet)]

    def make():
        kind = rng.choice(["higher", "petfloor", "petnotfloor", "notown", "above", "adjacent", "either", "pethigher", "petgap", "floornot"])
        x, y = rng.sample(TENANTS, 2)
        p, q = rng.sample(range(6), 2)
        n = rng.randrange(6)
        if kind == "higher":
            return (f"{x} lives on a higher floor than {y}.", lambda s: s[0][T[x]] > s[0][T[y]])
        if kind == "petfloor":
            return (f"The {PETS[p]} lives on floor {n + 1}.", lambda s: floor_of_pet(s, p) == n)
        if kind == "petnotfloor":
            return (f"The {PETS[p]} does not live on floor {n + 1}.", lambda s: floor_of_pet(s, p) != n)
        if kind == "notown":
            return (f"{x} does not own the {PETS[p]}.", lambda s: s[1][T[x]] != p)
        if kind == "above":
            return (f"The {PETS[p]} lives on the floor directly above the {PETS[q]}.", lambda s: floor_of_pet(s, p) == floor_of_pet(s, q) + 1)
        if kind == "adjacent":
            return (f"{x} lives on a floor directly above or directly below the {PETS[p]}, and does not own it.",
                    lambda s: abs(s[0][T[x]] - floor_of_pet(s, p)) == 1)
        if kind == "either":
            return (f"{x} owns the {PETS[p]} or the {PETS[q]}.", lambda s: s[1][T[x]] in (p, q))
        if kind == "pethigher":
            return (f"The {PETS[p]} lives on a higher floor than {x}.", lambda s: floor_of_pet(s, p) > s[0][T[x]])
        if kind == "petgap":
            return (f"Exactly one floor lies between {x} and the {PETS[p]}.", lambda s: abs(s[0][T[x]] - floor_of_pet(s, p)) == 2)
        return (f"{x} does not live on floor {n + 1}.", lambda s: s[0][T[x]] != n)

    while True:
        clues, remaining = [], universe
        for _ in range(26):
            clue = make()
            kept = [s for s in remaining if clue[1](s)]
            if 0 < len(kept) < len(remaining):
                clues.append(clue)
                remaining = kept
            if len(remaining) == 1:
                break
        if len(remaining) == 1 and 10 <= len(clues) <= 14 and all_needed(clues, universe):
            return clues, remaining[0]


def building_prompt(seed, name):
    clues, state = building_instance(seed)
    answer = ",".join(f"{t}={state[0][i] + 1}:{PETS[state[1][i]]}" for i, t in enumerate(TENANTS))
    pets = "(" + "|".join(PETS) + ")"
    return {
        "name": name,
        "prompt": ("Six tenants, Ana, Ben, Cara, Dev, Eli and Fay, live in a six-floor building, one per floor, floors numbered 1 (lowest) to 6 (highest). "
                   "Each owns exactly one pet, and the six pets are all different: a cat, a dog, an owl, a fox, a hen and a bat. A pet lives on its owner's floor. "
                   + " ".join(c[0] for c in clues)
                   + " Give each tenant's floor and pet. Output only one line in the form "
                   + ",".join(f"{t}=<floor>:<pet>" for t in TENANTS) + "."),
        "level": 5, "category": "reasoning", "scoring_type": "reasoning", "expected_tokens": 60,
        "expected_answer": answer,
        "judge_criteria": ["Every clue holds for the assignment", "The assignment is the only one that satisfies all clues", "Outputs only the requested line"],
        "deterministic_scoring": {"type": "exact", "case_sensitive": False},
        "output_contract": {"type": "regex", "pattern": "^" + ",".join(f"{t}=[1-6]:{pets}" for t in TENANTS) + "$"},
    }


def build():
    return [
        knights_prompt(11, "Eight Islanders One"),
        knights_prompt(23, "Eight Islanders Two"),
        knights_prompt(37, "Eight Islanders Three"),
        seating_prompt(5, "Eight Seats In A Row One"),
        seating_prompt(19, "Eight Seats In A Row Two"),
        seating_prompt(42, "Eight Seats In A Row Three"),
        building_prompt(9, "Six Floors Six Pets One"),
        building_prompt(27, "Six Floors Six Pets Two"),
    ]
