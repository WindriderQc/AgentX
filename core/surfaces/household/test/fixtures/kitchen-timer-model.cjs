'use strict';

// Deterministic simulator of model decisions, not the production language path.
const name = 'family_kitchen_timer';
function call(action, seconds) {
  return { message: { content: '', tool_calls: [{ function: { name, arguments: { action, ...(seconds && { seconds }) } } }] } };
}
function timerModel(body) {
  const { messages, tools } = body;
  const latest = messages.at(-1);
  if (latest.role === 'tool') return JSON.parse(latest.content).text;
  if (!tools?.some(tool => tool.function.name === name)) return "Je ne peux pas vérifier la minuterie.";
  const text = latest.content;
  if (/Station spatiale/i.test(text)) return "On va parler de l'ISS.";
  if (/encore deux minutes/i.test(text)) return call('extend', 120);
  if (/Combien il reste/i.test(text)) {
    return messages.filter(item => item.role === 'assistant').at(-1)?.content.includes("l'ISS")
      ? "Tu veux dire avant le prochain passage de l'ISS?" : call('status');
  }
  if (/annule la minuterie/i.test(text)) return call('cancel');
  if (/sans rien lancer|ne pars pas|il a dit/i.test(text)) return "D'accord, je ne lance rien.";
  if (/mets deux minutes|minuterie de trente|minuterie de 30|mettre le chrono|minuterie de 5/i.test(text))
    return call('start', /30|trente/.test(text) ? 30 : /5 minutes/.test(text) ? 300 : 120);
  return "Je t'écoute.";
}

module.exports = { call, timerModel, name };
