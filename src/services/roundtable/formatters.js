/**
 * Roundtable Formatters
 * Markdown transcript and compact summary generation
 */

/**
 * Format a full markdown transcript from a roundtable document
 * @param {Object} doc - Roundtable Mongoose document
 * @returns {string} Markdown transcript
 */
function formatTranscript(doc) {
  const lines = [];
  const durationSec = doc.totalDurationMs ? (doc.totalDurationMs / 1000).toFixed(1) : '—';

  lines.push(`# Roundtable: ${doc.question}`);
  lines.push(`**Status:** ${doc.status} | **Duration:** ${durationSec}s | **Rounds:** ${doc.rounds}`);
  lines.push('');

  // Performance table
  const allTurns = doc.turns || [];
  if (allTurns.length > 0) {
    lines.push('## Performance');
    lines.push('| Agent | Model | Host | Tokens/s | Latency |');
    lines.push('|-------|-------|------|----------|---------|');

    // Show round 1 stats (representative)
    const r1Turns = allTurns.filter(t => t.round === 1);
    for (const turn of r1Turns) {
      const tps = turn.stats?.tokensPerSecond ? turn.stats.tokensPerSecond.toFixed(1) : '—';
      const lat = turn.stats?.latencyMs ? `${(turn.stats.latencyMs / 1000).toFixed(1)}s` : '—';
      const host = turn.hostName || '—';
      lines.push(`| ${turn.role} | ${turn.model} | ${host} | ${tps} | ${lat} |`);
    }

    if (doc.synthesis?.model) {
      const sTps = doc.synthesis.stats?.tokensPerSecond ? doc.synthesis.stats.tokensPerSecond.toFixed(1) : '—';
      const sLat = doc.synthesis.stats?.latencyMs ? `${(doc.synthesis.stats.latencyMs / 1000).toFixed(1)}s` : '—';
      const sHost = doc.synthesis.hostName || '—';
      lines.push(`| Synthesizer | ${doc.synthesis.model} | ${sHost} | ${sTps} | ${sLat} |`);
    }
    lines.push('');
  }

  // Group turns by round
  const maxRound = allTurns.reduce((max, t) => Math.max(max, t.round || 0), 0);

  for (let r = 1; r <= maxRound; r++) {
    const roundTurns = allTurns.filter(t => t.round === r);
    const label = r === 1 ? 'Initial Analysis' : `Rebuttal Round ${r}`;
    lines.push(`## Round ${r} — ${label}`);
    lines.push('');

    for (const turn of roundTurns) {
      lines.push(`### ${turn.role} (${turn.model})`);
      if (turn.error) {
        lines.push(`> **Error:** ${turn.error}`);
      } else {
        lines.push(turn.response || '*No response*');
      }
      // Web search sources
      if (turn.webSearchResults && turn.webSearchResults.length > 0) {
        lines.push('');
        lines.push('**Web Sources:**');
        for (const src of turn.webSearchResults) {
          lines.push(`- [${src.title}](${src.url})`);
        }
      }
      lines.push('');
    }
  }

  // Synthesis
  if (doc.synthesis?.response || doc.synthesis?.error) {
    lines.push('## Synthesis');
    if (doc.synthesis.error) {
      lines.push(`> **Error:** ${doc.synthesis.error}`);
    } else {
      lines.push(doc.synthesis.response);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format a compact Telegram-friendly summary (~500 chars max)
 * @param {Object} doc - Roundtable Mongoose document
 * @returns {string} Compact summary
 */
function formatTelegramSummary(doc) {
  const parts = [];
  const durationSec = doc.totalDurationMs ? (doc.totalDurationMs / 1000).toFixed(0) : '?';

  parts.push(`Roundtable [${doc.status}] (${durationSec}s)`);
  parts.push(`Q: ${doc.question.substring(0, 100)}${doc.question.length > 100 ? '...' : ''}`);

  // First sentence per agent from round 1
  const r1Turns = (doc.turns || []).filter(t => t.round === 1);
  for (const turn of r1Turns) {
    if (turn.response) {
      const firstSentence = turn.response.split(/[.!?]\s/)[0];
      parts.push(`${turn.role}: ${firstSentence.substring(0, 80)}`);
    }
  }

  // Synthesis verdict
  if (doc.synthesis?.response) {
    const verdict = doc.synthesis.response.split(/[.!?]\s/)[0];
    parts.push(`Verdict: ${verdict.substring(0, 120)}`);
  }

  return parts.join('\n');
}

module.exports = {
  formatTranscript,
  formatTelegramSummary
};
