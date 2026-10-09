"""Math, instruction, agent and code-tracing prompts. Every expected answer is computed here."""
import contextlib, datetime, io, itertools, math
from functools import lru_cache


def numeric(name, prompt, value, criteria):
    return {
        "name": name, "prompt": prompt + " Output only the number.", "level": 5, "category": "math", "scoring_type": "math",
        "expected_tokens": 15, "expected_answer": str(value), "judge_criteria": criteria + ["Outputs only the number"],
        "deterministic_scoring": {"type": "numeric", "numeric_tolerance": 0},
        "output_contract": {"type": "regex", "pattern": "^-?[0-9]+$"},
    }


def math_prompts():
    out = []
    out.append(numeric("Remainder Of A Large Power", "What is the remainder when 3 raised to the power 16807 is divided by 9973?",
                       pow(3, 16807, 9973), ["Uses modular arithmetic, not an approximation", "The result is 3^16807 mod 9973"]))
    count = sum(1 for n in range(1, 100001) if (n % 6 == 0 or n % 10 == 0 or n % 14 == 0) and n % 21 != 0 and n % 35 != 0)
    out.append(numeric("Divisible By Three Numbers Not Two Others",
                       "How many integers from 1 to 100000 inclusive are divisible by at least one of 6, 10 and 14, but divisible by neither 21 nor 35?",
                       count, ["Counts multiples of 6, 10 or 14 with inclusion-exclusion", "Removes every multiple of 21 or 35 among them"]))
    blocked = ((2, 3), (5, 4), (7, 7))

    @lru_cache(None)
    def paths(x, y):
        if (x, y) in blocked:
            return 0
        if x == 0 and y == 0:
            return 1
        return (paths(x - 1, y) if x else 0) + (paths(x, y - 1) if y else 0)
    out.append(numeric("Lattice Paths Avoiding Three Points",
                       "On a grid, a path goes from (0,0) to (9,8) using only steps of +1 in x or +1 in y. How many such paths pass through none of the points (2,3), (5,4) and (7,7)?",
                       paths(9, 8), ["Counts monotone lattice paths", "Excludes paths through the three points without double counting"]))
    out.append(numeric("Digit Sum Of A Factorial", "What is the sum of the decimal digits of 40! (40 factorial)?",
                       sum(int(d) for d in str(math.factorial(40))), ["Computes 40! exactly", "Adds its decimal digits"]))
    words = sum(1 for w in itertools.product("abc", repeat=12) if "aa" not in "".join(w) and "bc" not in "".join(w))
    out.append(numeric("Strings Avoiding Two Patterns",
                       "How many strings of length 12 over the alphabet {a, b, c} contain neither two consecutive letters a (the substring aa) nor the substring bc?",
                       words, ["Sets up a recurrence or automaton on the last letter", "Counts exactly the strings of length 12"]))
    sols = sum(1 for x in range(13) for y in range(13) for z in range(13) if 0 <= 30 - x - y - z <= 12)
    out.append(numeric("Bounded Integer Solutions",
                       "How many solutions in integers does x + y + z + w = 30 have when each of x, y, z and w is between 0 and 12 inclusive?",
                       sols, ["Uses stars and bars with inclusion-exclusion on the upper bound", "Counts ordered solutions"]))
    return out


def exact(name, category, prompt, answer, pattern, criteria, tokens=40):
    return {
        "name": name, "prompt": prompt, "level": 5, "category": category, "scoring_type": category, "expected_tokens": tokens,
        "expected_answer": answer, "judge_criteria": criteria + ["Outputs only the requested line"],
        "deterministic_scoring": {"type": "exact", "case_sensitive": False},
        "output_contract": {"type": "regex", "pattern": pattern},
    }


def instruction_prompts():
    out = []
    # 1. Record pipeline
    records = [("pump", 14, "north"), ("valve", 9, "south"), ("gasket", 22, "north"), ("filter", 14, "east"), ("hose", 3, "north"),
               ("clamp", 22, "south"), ("seal", 17, "east"), ("nozzle", 9, "north"), ("bearing", 11, "west"), ("flange", 7, "east"),
               ("rotor", 28, "west"), ("spring", 11, "east"), ("washer", 34, "north"), ("coupler", 8, "west")]
    kept = [r for r in records if r[2] != "south"]
    kept = [(n, q * 2 if z == "east" else q, z) for n, q, z in kept]
    kept = [r for r in kept if r[1] >= 12]
    kept.sort(key=lambda r: (-r[1], r[0]))
    kept = [r for i, r in enumerate(kept) if (i + 1) % 4 != 0]
    answer = ";".join(f"{i + 1}:{r[0].upper()}:{r[1] * 3 - (i + 1)}" for i, r in enumerate(kept))
    listing = " ".join(f"{n},{q},{z}." for n, q, z in records)
    out.append(exact("Parts Inventory Pipeline", "instruction",
                     "Each record is name,quantity,zone. Records: " + listing + " Apply these rules in order: (1) drop every record in zone south; "
                     "(2) double the quantity of every record in zone east; (3) drop every record whose quantity is now below 12; "
                     "(4) sort by quantity from highest to lowest, breaking ties by name in alphabetical order; (5) remove every fourth record of the sorted list (the 4th, the 8th and so on); "
                     "(6) for each remaining record output position:NAME:value where position counts from 1 in the final list, NAME is the name in upper case and value is the quantity multiplied by 3, minus the position. "
                     "Output only one line with the records separated by semicolons and no spaces.",
                     answer, "^[0-9]+:[A-Z]+:[0-9]+(;[0-9]+:[A-Z]+:[0-9]+)*$",
                     ["Drops the south records, doubles east and drops those below 12", "Sorts by quantity descending then name and removes every fourth", "Numbers, upper-cases and computes the value correctly"]))
    # 2. Word cipher
    sentence = "quiet rivers carry old maps toward hidden northern harbors while patient sailors wait"
    words = sentence.split()
    step1 = [w[::-1] for w in words]
    step2 = [w for i, w in enumerate(step1) if (i + 1) % 3 != 0]
    step3 = ["".join(chr((ord(c) - 97 + 2) % 26 + 97) for c in w) for w in step2]
    step4 = sorted(step3, key=lambda w: (len(w), w))
    step5 = [w[-1] + w[1:-1] + w[0] if len(w) % 2 == 0 else w for w in step4]
    out.append(exact("Five Step Word Transformation", "instruction",
                     f'Start from this sentence: "{sentence}". Apply these steps in order: (1) reverse the letters of each word; (2) remove every third word of the list (the 3rd, the 6th and so on); '
                     "(3) replace each letter by the letter two places later in the alphabet, wrapping from z to a; (4) sort the words by length from shortest to longest, breaking ties alphabetically; "
                     "(5) in every word that has an even number of letters, exchange the first and the last letter. "
                     "Output only the resulting words on one line, separated by single hyphens.",
                     "-".join(step5), "^[a-z]+(-[a-z]+)*$",
                     ["Reverses each word before anything else", "Removes every third word", "Shifts every letter by two with wrap-around", "Sorts by length then alphabetically, then swaps ends of even-length words"]))
    # 3. Cellular automaton
    row = "0110100011010010"
    cells = [int(c) for c in row]
    for _ in range(5):
        n = len(cells)
        cells = [1 if cells[(i - 1) % n] + cells[i] + cells[(i + 1) % n] == 1 else 0 for i in range(n)]
    out.append(exact("Ring Automaton Five Steps", "instruction",
                     f"Sixteen cells are arranged in a ring, so the first and the last cell are neighbours. The starting row is {row}. At each step every cell is updated at the same time: "
                     "a cell becomes 1 if exactly one of the three cells formed by its left neighbour, itself and its right neighbour is 1, and becomes 0 otherwise. "
                     "Apply five steps. Output only the final row of sixteen digits.",
                     "".join(str(c) for c in cells), "^[01]{16}$",
                     ["Updates all cells simultaneously", "Wraps around at both ends", "Applies exactly five steps"], tokens=20))
    # 4. Stack machine
    program = ("push 4, push 7, dup, add, swap, push 3, mul, push 2, sub, swap, dup, push 5, add, rot, push 9, swap, sub, dup, mul, "
               "push 6, mod, rot, add, swap, push 11, mul, push 8, rot, add, dup, push 4, mod, swap")
    stack = []
    for op in program.split(", "):
        if op.startswith("push"):
            stack.append(int(op.split()[1]))
        elif op == "dup":
            stack.append(stack[-1])
        elif op == "swap":
            stack[-1], stack[-2] = stack[-2], stack[-1]
        elif op == "rot":
            stack.append(stack.pop(-3))
        else:
            b, a = stack.pop(), stack.pop()
            assert op != "mod" or (b > 0 and a >= 0), "mod must stay unambiguous"
            stack.append({"add": a + b, "sub": a - b, "mul": a * b, "mod": a % b if b else 0}[op])
    out.append(exact("Stack Machine Trace", "instruction",
                     "A stack machine starts with an empty stack. push n puts n on top; dup copies the top value; swap exchanges the two top values; "
                     "rot removes the third value from the top and puts it on top; "
                     "add, sub, mul and mod remove the two top values b (top) and a (below it) and push a+b, a-b, a*b or the remainder of a divided by b. Run this program: " + program
                     + ". Output only the final stack from bottom to top, as numbers separated by commas with no spaces.",
                     ",".join(str(v) for v in stack), "^-?[0-9]+(,-?[0-9]+)*$",
                     ["Applies each operation in order", "Uses a minus b with b on top for sub", "Lists the stack from bottom to top"], tokens=20))
    # 5. Ranking with tie-breaks
    players = [("Mira", 82, 31, 4, 1), ("Oskar", 91, 28, 2, 3), ("Lena", 82, 31, 1, 0), ("Tariq", 91, 35, 5, 2), ("Noor", 77, 40, 3, 0),
               ("Hugo", 82, 29, 6, 2), ("Ines", 86, 27, 9, 1), ("Pavel", 88, 33, 7, 0), ("Zoe", 79, 26, 8, 2), ("Remy", 93, 30, 10, 4)]
    eligible = [(n, s + (5 if t < 30 else 0) - 2 * pen, t, b) for n, s, t, b, pen in players if pen <= 2]
    ranked = sorted(eligible, key=lambda p: (-p[1], p[2], p[3]))
    table = " ".join(f"{n}: score {s}, time {t}, badge {b}, penalties {pen}." for n, s, t, b, pen in players)
    assert len({(p[1], p[2], p[3]) for p in eligible}) == len(eligible)
    out.append(exact("Ranking With Adjustments And Tie Breaks", "instruction",
                     "Rank these players. " + table + " Rules, in order: (1) disqualify every player with more than 2 penalties; (2) add 5 to the score of every player whose time is below 30; "
                     "(3) subtract 2 from the score for each penalty; (4) higher adjusted score ranks first; among equal adjusted scores the lower time ranks first; "
                     "among equal scores and times the lower badge number ranks first. "
                     "Output only the names of the remaining players in rank order, separated by the character > with no spaces.",
                     ">".join(p[0] for p in ranked), "^[A-Za-z]+(>[A-Za-z]+)*$",
                     ["Disqualifies players over the penalty limit", "Applies the time bonus and the penalty deduction", "Orders by adjusted score, then time, then badge"], tokens=30))
    # 6. Template numbering
    items = ["  green  tea ", "#skip", "BLACK coffee", "", "oat   milk", "dark  CHOCOLATE", "!hold", "plain water", " Rye   Bread", "#later",
             "smoked  SALMON ", "red  lentils", "!never", "wild   rice", "sea SALT"]
    cleaned = [" ".join(i.split()) for i in items]
    cleaned = [i for i in cleaned if i and i[0] not in "#!"]
    cleaned = [i.lower() for i in cleaned]
    cleaned = [i for i in cleaned if len(i.replace(" ", "")) % 2 == 0]
    cleaned.sort(key=lambda i: (-len(i.replace(" ", "")), i))
    tagged = "|".join(f"{chr(65 + k)}{len(i.replace(' ', ''))}-{i.replace(' ', '_')}" for k, i in enumerate(cleaned))
    out.append(exact("Shopping List Normalisation", "instruction",
                     "Process this JSON array: " + str(items).replace("'", '"') + ". Apply these rules in order: "
                     "(1) trim each entry and collapse runs of spaces to one space; (2) drop empty entries and entries that start with # or !; (3) put every entry in lower case; "
                     "(4) keep only entries whose number of letters, not counting spaces, is even; (5) sort the entries by letter count from highest to lowest, breaking ties alphabetically; "
                     "(6) label the entries A, B, C and so on in that order, and write each as <label><letter count>-<entry with spaces replaced by underscores>. "
                     "Output only one line with the entries separated by the character | and no spaces.",
                     tagged, "^[A-Z][0-9]+-[a-z_]+(\\|[A-Z][0-9]+-[a-z_]+)*$",
                     ["Trims, collapses spaces and drops the marked and empty entries", "Keeps only entries with an even letter count and sorts them", "Labels in order and writes count and underscores correctly"]))
    return out


def agent_prompts():
    out = []
    # 1. Working day before the third Thursday, month after next
    today = datetime.date(2031, 3, 19)
    first = datetime.date(2031, 5, 1)
    thursdays = [first + datetime.timedelta(days=d) for d in range(31) if (first + datetime.timedelta(days=d)).weekday() == 3]
    closed = {thursdays[2] - datetime.timedelta(days=1)}
    target = thursdays[2] - datetime.timedelta(days=1)
    while target.weekday() >= 5 or target in closed:
        target -= datetime.timedelta(days=1)
    out.append(exact("Calendar Tool Working Day Before", "agent",
                     "You are an agent with these tools: create_event(date) with an ISO date, send_note(text), search_calendar(month). "
                     f"Today is {today.isoformat()}, a {today.strftime('%A')}. The office is closed on weekends and on {sorted(closed)[0].isoformat()}. "
                     "Request: \"Book the equipment check on the last day the office is open strictly before the third Thursday of the month after next.\" "
                     "Reply with the single call you would make, on one line, in the form tool=<name>,date=<ISO date>.",
                     f"tool=create_event,date={target.isoformat()}", "^tool=[a-z_]+,date=[0-9]{4}-[0-9]{2}-[0-9]{2}$",
                     ["Chooses create_event", "Finds the third Thursday of the month after next", "Steps back past the closed day to an open day"], tokens=25))
    # 2. Route choice under constraints
    routes = [("A", 38, 7, 2, True), ("B", 29, 11, 1, True), ("C", 41, 5, 0, True), ("D", 33, 8, 3, True), ("E", 30, 9, 2, False),
              ("F", 44, 4, 1, True), ("G", 31, 9, 2, True), ("H", 35, 6, 1, True), ("I", 27, 8, 1, False), ("J", 36, 9, 0, True)]
    ok = [(n, c + 4 * t + (6 if h > 7 else 0), h) for n, c, h, t, cold in routes if h <= 9 and t <= 2 and cold]
    best = min(ok, key=lambda r: (r[1], r[2]))
    assert sum(1 for r in ok if (r[1], r[2]) == (best[1], best[2])) == 1
    table = " ".join(f"{n}: base cost {c}, hours {h}, transfers {t}, {'refrigerated' if cold else 'not refrigerated'}." for n, c, h, t, cold in routes)
    out.append(exact("Delivery Route Under Constraints", "agent",
                     "You choose a delivery route for an operator. The cargo is perishable. Options: " + table
                     + " Policy: perishable cargo must travel refrigerated; never exceed 9 hours; never use more than 2 transfers; the total cost is the base cost plus 4 per transfer, "
                     "plus a surcharge of 6 when the route takes more than 7 hours; among the routes that remain choose the lowest total cost, and if two cost the same choose the one with fewer hours. "
                     "Reply on one line in the form route=<letter>,cost=<total cost>.",
                     f"route={best[0]},cost={best[1]}", "^route=[A-J],cost=[0-9]+$",
                     ["Rejects unrefrigerated, slow and many-transfer routes", "Computes the total cost with transfers and surcharge", "Chooses the cheapest remaining route"], tokens=20))
    # 3. Alert triage order
    alerts = [(1, "warning", 40, False), (2, "critical", 5, False), (3, "critical", 55, True), (4, "info", 300, False), (5, "critical", 30, False),
              (6, "warning", 90, False), (7, "warning", 90, True), (8, "warning", 150, False), (9, "info", 500, False), (10, "critical", 30, False),
              (11, "warning", 121, False), (12, "warning", 120, False), (13, "critical", 200, True), (14, "warning", 15, False)]
    kept = [(i, "critical" if (s == "warning" and m > 120) else s, m) for i, s, m, ack in alerts if not ack and s != "info"]
    rank = {"critical": 0, "warning": 1}
    kept.sort(key=lambda a: (rank[a[1]], -a[2], a[0]))
    kept = kept[:7]
    table = " ".join(f"#{i}: {s}, open {m} minutes{', acknowledged' if ack else ''}." for i, s, m, ack in alerts)
    out.append(exact("Alert Triage Order", "agent",
                     "You triage alerts for an operations team. Alerts: " + table + " Rules: ignore acknowledged alerts; ignore info alerts; a warning that has been open for more than 120 minutes "
                     "is treated as critical; handle critical before warning; within the same severity handle the alert that has been open longest first; if still tied, the lower number first; "
                     "you only have time for the first seven. Reply on one line in the form order=<numbers separated by commas>.",
                     "order=" + ",".join(str(a[0]) for a in kept), "^order=[0-9]+(,[0-9]+)*$",
                     ["Leaves out acknowledged and info alerts", "Escalates only warnings open more than 120 minutes", "Orders by severity then time open and stops at seven"], tokens=20))
    # 4. Retention policy
    day = datetime.date(2032, 6, 20)
    offsets = [0, 1, 2, 3, 7, 9, 14, 20, 21, 31, 35, 49, 52, 60, 77]
    files = {f"f{k + 1:02d}": day - datetime.timedelta(days=o) for k, o in enumerate(offsets)}
    ordered = sorted(files, key=lambda f: files[f], reverse=True)
    keep = set(ordered[:3])
    sundays = [f for f in ordered if files[f].weekday() == 6 and f not in keep]
    keep |= set(sundays[:2])
    for month in (5, 4):
        monthly = [f for f in ordered if files[f].month == month and f not in keep]
        keep |= set(monthly[:1])
    delete = sorted(f for f in files if f not in keep)
    listing = " ".join(f"{f}: {files[f].isoformat()} ({files[f].strftime('%A')})." for f in sorted(files))
    out.append(exact("Backup Retention Decision", "agent",
                     f"You manage backups. Today is {day.isoformat()}, a {day.strftime('%A')}. Backups and their dates: " + listing
                     + " Policy, applied in this order: keep the three most recent backups; in addition keep the two most recent backups taken on a Sunday that are not already kept; "
                     "in addition, for May 2032 and for April 2032, keep the most recent backup of that month that is not already kept; delete everything else. "
                     "Reply on one line in the form delete=<file names separated by commas, in alphabetical order>.",
                     "delete=" + ",".join(delete), "^delete=f[0-9]{2}(,f[0-9]{2})*$",
                     ["Keeps the three most recent backups", "Keeps two more Sunday backups beyond those", "Keeps one more backup for May and for April, and deletes the rest"], tokens=30))
    # 5. Budget allocation
    jobs = [("j1", 6, 30), ("j2", 4, 21), ("j3", 3, 18), ("j4", 5, 24), ("j5", 2, 11), ("j6", 4, 27), ("j7", 7, 37), ("j8", 1, 4)]
    feasible = []
    for mask in range(1 << len(jobs)):
        chosen = [j for i, j in enumerate(jobs) if mask >> i & 1]
        names = {j[0] for j in chosen}
        if sum(j[1] for j in chosen) > 15 or ("j6" in names and "j2" not in names) or {"j3", "j5"} <= names:
            continue
        feasible.append((sum(j[2] for j in chosen), chosen))
    best_value, best_set = max(feasible, key=lambda f: f[0])
    assert sum(1 for f in feasible if f[0] == best_value) == 1, "budget optimum is not unique"
    table = " ".join(f"{n}: {h} hours, value {v}." for n, h, v in jobs)
    out.append(exact("Compute Budget Allocation", "agent",
                     "You schedule jobs on a host that has 15 hours of compute tonight. Each job runs entirely or not at all. Jobs: " + table
                     + " Constraints: j6 can only run if j2 also runs; j3 and j5 cannot both run. Choose the set of jobs with the highest total value that fits in the 15 hours. "
                     "Reply on one line in the form jobs=<names separated by commas, in name order>,value=<total value>.",
                     "jobs=" + ",".join(j[0] for j in best_set) + f",value={best_value}", "^jobs=j[0-9](,j[0-9])*,value=[0-9]+$",
                     ["Stays within 15 hours and respects both constraints", "Finds the highest total value, not the greedy choice", "Reports the total value of the chosen set"], tokens=25))
    return out


SNIPPETS = [
    ("Trace Hash And Equality In Sets", '''class P:
    def __init__(self, x, y):
        self.x, self.y = x, y
    def __eq__(self, other):
        return self.x + self.y == other.x + other.y
    def __hash__(self):
        return self.x * self.y % 4

pts = [P(1, 4), P(2, 3), P(4, 1), P(0, 5), P(3, 3), P(5, 1), P(2, 2)]
s = set(pts)
d = {}
for p in pts:
    d[p] = d.get(p, 0) + p.x
print(len(s), len(d), sum(d.values()), max(d.values()), pts.index(P(4, 1)), P(0, 6) in s)'''),
    ("Trace Loop Else And Slices", '''out = []
for n in range(2, 30):
    for d in range(2, n):
        if n % d == 0:
            if d * d == n:
                out.append(-n)
            break
    else:
        out.append(n)
s = out[::-2][1:6]
print(len(out), sum(out), s[0], s[-1], sum(s[1:-1]))'''),
    ("Trace Aliased Nested Lists", '''grid = [[0] * 3] * 2
grid[0][1] = 5
rows = [list(r) for r in grid]
rows[1][1] += 2
grid.append(rows[0])
grid[2][0] = 9
t = (grid[0], rows)
t[1][0].append(len(grid))
t[0][2] -= rows[1][1]
print(sum(map(sum, grid)), len(rows[0]), rows[0][0], rows[1][1], grid[1] is grid[0], sum(rows[0]) + sum(rows[1]))'''),
    ("Trace String Filtering And Joins", '''s = "benchmarking local models"
t = "".join(c.upper() if i % 3 == 0 else c for i, c in enumerate(s) if c not in "aeo")
u = t.split()
v = "-".join(w[::-1][:4] for w in u)
print(len(t), t.count("L"), v, v.find("l"), sum(map(ord, v[:3])) % 97)'''),
    ("Trace Three Value State Machine", '''def step(state):
    a, b, c = state
    if a % 2 == 0:
        return (a // 2, b + c, c ^ a)
    return (3 * a + 1, b - 1, c + b % 5)

state, seen = (27, 4, 1), {}
n = 0
while state[0] != 1 and n < 25:
    seen[state[0] % 7] = n
    state = step(state)
    n += 1
print(n, state[0], state[1], state[2], len(seen), sum(seen.values()))'''),
]


def coding_prompts():
    out = []
    for name, code in SNIPPETS:
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            exec(code, {"__name__": "trace"})
        printed = buffer.getvalue().strip()
        assert "\n" not in printed and printed, (name, printed)
        out.append({
            "name": name,
            "prompt": "What does this Python 3 program print? Output only the printed line, exactly as Python prints it.\n\n```python\n" + code + "\n```",
            "level": 5, "category": "coding", "scoring_type": "coding", "expected_tokens": 20,
            "expected_answer": printed,
            "judge_criteria": ["Traces the program step by step instead of guessing", "The line matches what Python 3 prints", "Outputs only the printed line"],
            "deterministic_scoring": {"type": "exact", "case_sensitive": True, "trim_only": True},
            "output_contract": {"type": "regex", "pattern": "^[-0-9A-Za-z ]+$"},
        })
    return out


def build():
    return math_prompts() + instruction_prompts() + agent_prompts() + coding_prompts()
