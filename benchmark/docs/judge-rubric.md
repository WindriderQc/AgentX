# Judge rubric

How the decomposed judge grades one response, and why each rule exists. The
question bank is `src/services/decomposedJudgeQuestions.js`; the aggregation is
`src/services/decomposedJudge.js`; per-category weights and the primary
dimension are `src/services/scoring/scoringConfigs.js`. Scorer version 2.16.0.

## One question per call

Each question is asked on its own, with the task, the expected answer (when
one exists) and the response. The judge answers one word. The prompt states:

- YES means the response clearly satisfies what the question asks; NO means it
  does not; NA is allowed only on a conditional question, when the task does
  not call for that at all.
- Judge only what the task asks for. Do not require properties the task did
  not request.
- The expected answer is a reference for meaning and correctness, not required
  wording. A different response that is equally correct earns YES.
- Evaluate the aspect independently: a wrong value does not make the format
  wrong, and good style does not make a wrong answer right.

## Question rules

- **Positively keyed.** YES always earns credit. Calibration on six judges
  showed that every model, larger ones more, answers "is anything wrong?"
  questions by overall impression rather than by wording; a response identical
  to its expected answer lost two points that way.
- **Conditional questions start with "If"** and carry `conditional: true`. An
  NA answer removes the question from the dimension's weight. NA on any other
  question is read as NO, so a judge cannot dodge a question it should answer.
  A dimension whose every question is NA has no score and drops out of the
  average.
- **Anchored to the task.** Secondary dimensions ask about what the task or the
  expected answer requires (its boundary values, its stated constraints), not
  about robustness or efficiency in the abstract.
- **One counted question per category.** "Compared with the expected answer,
  how many of its key points are missing? Count them." (for code: requirements
  not met; for translation: words mistranslated or omitted; for creative: form
  constraints violated). The judge answers 0, 1, 2 or "3 or more", worth 1,
  0.66, 0.33 and 0 of the question's weight. Yes/no questions separate wrong
  from right; the count separates "correct but thin" from "correct". A counted
  question never offers NA, and an unreadable count is an error rather than a
  zero.
- **Creative form is primary.** A "haiku" without 5-7-5 or a dialog when a
  story was asked is wrong, not weak; imagery and engagement are judged among
  pieces that are in the requested form.

## Aggregation

Each dimension is the weighted share of credited questions, 0–10. The overall
score is the weighted mean of the dimensions using the category weights, then
**capped at the primary dimension plus one point**. Without the cap, a wrong
answer collected up to 7.5 points for clarity and style. The primary dimension
is correctness for coding, accuracy for reasoning, knowledge and translation,
answer correctness for math, constraint compliance for instruction and
relevance for creative. The result records `primary_cap` with the uncapped
score.

## Attention check

After the questions, two known-answer probes are asked on the same response:
one whose answer must be YES, one whose answer must be NO. A judge that
answers by disposition fails exactly one. The outcome never changes the score;
`judgeConfidence` marks the result for review and caps confidence at 0.3. An
unanswerable probe leaves the check unknown.

## Executable correctness

A coding prompt that carries `reference_tests` is not read by the judge for
correctness. The candidate's program is extracted from the response and run
against the authored cases in the code runner. Every case passes or the answer
is wrong; partial credit is the passed weight fraction, below 1, and only
orders wrong answers among themselves, so a wrong program stays in the wrong
tier (overall at most 2). No program, a load error, a crash, a timeout and runaway output
score 0 with their status recorded. The judge still asks the clarity,
efficiency and robustness questions; the correctness questions are skipped,
the executed score enters the weighted average, and the primary-dimension cap
bounds the overall by it. A runner that cannot answer leaves the row unscored
and asks for review; the judge is not asked to guess instead. Rows record
`execution_result`, `code_extraction` and `correctness_source: executable`.

## Calibration

`POST /api/benchmark/judge/calibrate-accuracy` grades the calibration set and
reports agreement within one point, MAE, correlation, the identity check, the
keying-bias diagnostic, the attention-probe summary and pairwise ordering
accuracy (ties counted half).

The set (`benchmark/data/judge-calibration-set.json`) covers every catalog
category with authored responses and reference grades. A case scores on the
path of the catalog prompts it mirrors through the fields it carries:
`reference_tests` run the code, a `reference_answer` selects the reference
scorer, and `judge_criteria` become the decomposed judge's specific criteria.
Translation has cases on both of its paths (with and without a reference
answer); agent cases are judged against their planted findings. Both have an
identity case (the reference answer as the response) and the three tiers.
Changing the set changes its fingerprint, so every judge has to be calibrated
again before its grades qualify.

A judge **qualifies** on ordering, because the product ranks models: ordering
with ties at half ≥ 85 %, MAE ≤ 1.5, every reference answer at full marks, and
no failed attention probe. Absolute agreement and correlation are diagnostics;
on the authored set, the judge with the best absolute agreement was the worst at
ordering. The response names the criteria and which ones a run failed.

## Grader qualification and the qualification card

Every completed `calibrate-accuracy` run is recorded (`JudgeQualification`,
append-only, per-case grades kept). A record qualifies one exact identity: the
judge model on one host, one scorer version and the current reference set
(fingerprinted). The newest complete record of that identity decides; a later
failing run withdraws the qualification, while a run that did not finish (a call
failed, timed out or was cancelled) neither qualifies nor withdraws. Readiness,
a default selection, completion rate or an older scorer version never qualify a
judge. The judge digest is recorded as provenance; result rows do not carry the
judge artifact, so matching uses model and host.

- `GET /api/benchmark/judge/qualifications` lists the newest record per judge
  identity and scorer version with its current status and causes;
  `/judge/qualifications/:id` returns one record with its cases. Nothing here
  runs inference.
- The generalist leaderboard attaches `graderQualification` to every row. A
  comparable verdict orders models judged on the same terms; it is
  **authoritative** only when every judge behind the row is qualified for the
  row's scorer version. Otherwise the rank is shown as provisional, carries no
  medal, and `verdict.authorityReasons` / `graderCauses` say why. Scores stay
  visible either way. The deterministic axis does not depend on a judge.
- `GET /api/benchmark/results/:id` returns a `qualification_card` that answers
  five questions separately: product behavior (did the run answer), model
  quality (raw scores, never invented), grader (qualified, and whether it held
  up on this answer: attention probe, review flag, incomplete output),
  environment (an infrastructure failure means the model was not measured) and
  evidence (what proof is missing). The Test Inspector renders it; The Bench
  shows each judge's qualification for the running scorer version.

Twenty authored references are a smoke test, not ground truth; thresholds are
to be confirmed on human-graded references. A calibration item with
`reference_tests` is executed like any coding prompt; without a runner it is
reported as incomplete, never silently judged.
