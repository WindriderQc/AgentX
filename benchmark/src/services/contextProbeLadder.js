function buildCoarseCandidates(minCtx, upperBound) {
  const floorCtx = Math.max(1, Math.floor(minCtx));
  const ceilingCtx = Math.max(floorCtx, Math.floor(upperBound));
  const candidates = [floorCtx];

  let nextCtx = floorCtx;
  while (nextCtx < ceilingCtx) {
    nextCtx *= 2;
    if (nextCtx >= ceilingCtx) break;
    candidates.push(nextCtx);
  }

  if (candidates[candidates.length - 1] !== ceilingCtx) {
    candidates.push(ceilingCtx);
  }

  return candidates;
}

function buildRefinementStages(lowerBound, upperBound, minIncrement) {
  const baseIncrement = Math.max(1, Math.floor(minIncrement));
  const range = Math.max(0, Math.floor(upperBound) - Math.floor(lowerBound));
  if (range <= baseIncrement) return [];

  let step = 2 ** Math.floor(Math.log2(Math.max(baseIncrement, Math.floor(range / 4))));
  const stages = [];

  while (step >= baseIncrement) {
    stages.push(step);
    step = Math.floor(step / 2);
  }

  if (stages[stages.length - 1] !== baseIncrement) {
    stages.push(baseIncrement);
  }

  return stages;
}

async function refinePassingBracket(lowerPassingCtx, upperFailingCtx, minIncrement, testCandidate) {
  let bestPassingCtx = lowerPassingCtx;
  let failLimit = upperFailingCtx;
  const refinementStages = buildRefinementStages(lowerPassingCtx, upperFailingCtx, minIncrement);

  for (const increment of refinementStages) {
    let candidate = bestPassingCtx + increment;
    while (candidate < failLimit) {
      const step = await testCandidate(candidate);
      if (step.passed) {
        bestPassingCtx = step.numCtx;
        candidate = bestPassingCtx + increment;
        continue;
      }

      failLimit = candidate;
      break;
    }
  }

  return bestPassingCtx;
}

module.exports = { buildCoarseCandidates, buildRefinementStages, refinePassingBracket };
