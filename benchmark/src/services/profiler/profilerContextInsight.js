'use strict';

function _formatCtx(n) {
  if (n >= 1024) return `${Math.round(n / 1024)}k`;
  return String(n);
}

function buildContextInsight(previousNumCtx, previousSource, discoveredNumCtx) {
  if (!previousNumCtx || !discoveredNumCtx) return null;
  const factor = Number((discoveredNumCtx / previousNumCtx).toFixed(1));
  const upgradeAvailable = discoveredNumCtx > previousNumCtx * 1.25; // >25% gain counts
  const downgrade = discoveredNumCtx < previousNumCtx * 0.75;

  let recommendation;
  if (upgradeAvailable) {
    recommendation = `Verified capacity reached ${_formatCtx(discoveredNumCtx)} context (runtime was ${_formatCtx(previousNumCtx)})`;
  } else if (downgrade) {
    recommendation = `Runtime ${_formatCtx(previousNumCtx)} exceeds the current verified maximum ${_formatCtx(discoveredNumCtx)} — reconfigure by workload`;
  } else {
    recommendation = `Runtime is near the measured maximum (${_formatCtx(previousNumCtx)} → ${_formatCtx(discoveredNumCtx)})`;
  }

  return { previousNumCtx, previousSource, discoveredNumCtx, upgradeAvailable, upgradeFactor: factor, recommendation };
}

module.exports = { _formatCtx, buildContextInsight };
