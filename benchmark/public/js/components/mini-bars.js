// mini-bars.js — Renders one inline mini-bar per benchmark category
import { scoreColor } from './score-color.js';
import { CATEGORY_KEYS, CATEGORY_META } from '../benchmark-categories.js';

const CATS = CATEGORY_KEYS;
const ABBR = CATEGORY_KEYS.map(key => CATEGORY_META[key].abbr);

export function miniBars(categoryScores, { height = 4, width = 30 } = {}) {
  return CATS.map((cat, i) => {
    const score = categoryScores[cat] ?? 0;
    const pct = (score / 10) * 100;
    const color = scoreColor(score);
    return `<div class="r-mini-bar" title="${ABBR[i]}: ${score.toFixed(1)}">
      <div class="r-mini-fill" style="width:${pct}%;background:${color};height:${height}px;"></div>
    </div>`;
  }).join('');
}
