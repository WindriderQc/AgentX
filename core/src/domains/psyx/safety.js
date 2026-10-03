'use strict';

// Deterministic crisis signals. They never depend on the model: a matching
// message switches PsyX to a safety stance and the interface shows Québec
// crisis resources. Patterns favour explicit phrasing over single words so
// figures of speech ("ça me tue de rire") do not trigger.

const SIGNALS = Object.freeze([
  { kind: 'suicide', pattern: /\b(decide|prevu|l'intention|compte|prevois) (d'|de )?en finir(?! avec)\b|\b(decided|intend|intending) to end (it all|my life)\b/ },
  { kind: 'suicide', pattern: /\b(suicid\w*|me (tuer|suicider|pendre|jeter (sous|du haut))|(envie d'|veux |vais |pense a |pense d'?)en finir(?! avec)|en finir avec (la vie|ma vie|tout|moi)|(envie de|veux|voudrais) (mourir|crever(?! de))|(veux|voulais|voudrais) (plus|pas) vivre|n'?en peux plus de vivre|(voudrais|aimerais) etre mort|mettre fin a (mes jours|ma vie)|(plus|pas) (envie|le gout) de vivre|veux (mourir|disparaitre)|voudrais (mourir|disparaitre)|mieux (sans moi|si j'?etais mort)|kill myself|end (it all|my life)|want to die|better off dead|no reason to live|(don'?t|do not) want to live|want to disappear|plan to end (it|my life))\b/ },
  // Passive ideation: wishing not to exist, without a stated plan. Errs toward
  // asking; the safety instruction covers what is clearly something else.
  { kind: 'passive_ideation', pattern: /\b(si je (n'?etais|ne serais|n'?existais) plus (la|ici)|si je disparaissais|(serait|serais|seraient) (mieux|plus simple|plus facile) sans moi|(aimerais|voudrais|veux) (ne )?(pas|plus) me reveiller|wish i (were|was) (dead|gone)|not wake up)\b/ },
  { kind: 'self_harm', pattern: /\b(me (faire du mal|blesser|blesse|couper|coupe|scarifier|scarifie|bruler|brule)(?! (les|la|le|l'|au|a|du|des|en|un|une|avec|sur) )|me suis (fait du mal|blesse|coupe|scarifie|brule)e?(?! (les|la|le|l'|au|a|du|des|en|un|une|avec|sur) )|automutil\w*|scarification|self[- ]?harm\w*|cut(ting)? myself|hurt(ing)? myself)\b/ },
  { kind: 'harm_to_others', pattern: /\b((envie|peur) de (le|la|les|lui) (tuer|frapper|faire du mal)|vais (le|la|les|lui) (tuer|faire du mal)|(want|going) to (kill|hurt) (him|her|them))\b/ },
  { kind: 'self_harm', pattern: /\b(me (couper|coupe|taillader|taillade)|me suis (coupe|taillade)e?) (les? )?(poignets?|veines?)\b|\bcut(ting)? my wrists?\b/ },
  { kind: 'immediate_danger', pattern: /\b(j'?ai (pris|avale) (des|trop de|tous mes|toutes mes|tous les|toutes les) (pilules|medicaments|comprimes)|overdos\w*|surdos\w*|i (took|swallowed) (all( my| the)?|too many) (pills|meds|tablets))\b/ }
]);

const RESOURCES = Object.freeze([
  { label: 'Danger immédiat', contact: '911' },
  { label: 'Ligne de prévention du suicide, 24/7, appel ou texto', contact: '9-8-8' },
  { label: 'Ligne québécoise de prévention du suicide', contact: '1 866 APPELLE (277-3553)' },
  { label: 'Info-Social, intervenant psychosocial 24/7', contact: '8-1-1' }
]);

const SAFETY_INSTRUCTION = `SAFETY STANCE — a deterministic check found a possible crisis signal in the user's latest message. This overrides the selected stance and depth.
Respond calmly, warmly and directly. Ask plainly whether the user is safe right now and whether they are thinking of harming themselves or someone else. Do not analyze, challenge, plan experiments or lecture. Acknowledge the pain without minimizing it. Encourage contacting a person now: 911 for immediate danger, 9-8-8 (call or text, 24/7) or 1 866 APPELLE for suicide prevention in Québec, 811 Info-Social. The interface already shows these numbers; mention them briefly. If the signal was clearly a figure of speech, say so lightly and continue normally.`;

function normalize(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ');
}

// A crisis does not end with the message that named it: the next replies keep
// the safety stance while one of the user's last two messages carried a signal.
function detectRecentCrisis(message, context = []) {
  const recentUserTurns = context.filter((turn) => turn.role === 'user').slice(-2).map((turn) => turn.content);
  for (const text of [message, ...recentUserTurns.reverse()]) {
    const found = detectCrisis(text);
    if (found) return { ...found, carriedOver: text !== message };
  }
  return null;
}

function detectCrisis(text) {
  const value = normalize(text);
  const kinds = [...new Set(SIGNALS.filter(signal => signal.pattern.test(value)).map(signal => signal.kind))];
  return kinds.length ? { kinds, resources: RESOURCES } : null;
}

module.exports = { RESOURCES, SAFETY_INSTRUCTION, detectCrisis, detectRecentCrisis };
