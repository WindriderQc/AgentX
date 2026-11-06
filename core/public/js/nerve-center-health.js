(function () {
    'use strict';

    const shared = window.NerveCenterShared;

    // Speech engines: the cloned-voice worker (VoxCPM2 or Pocket TTS) and the Kokoro catalog voices.
    function renderVoices(voix) {
        if (!voix) return '';
        const engines = voix.engines || {};
        const line = (label, engine) => {
            if (!engine || engine.configured === false) return '';
            const ready = engine.ready === true;
            const color = engine.ready === null ? 'var(--muted)' : ready ? '#4ade80' : '#f59e0b';
            const state = engine.ready === null ? 'unknown' : ready ? 'ready' : 'unavailable';
            const since = engine.since ? ` since ${shared.timeAgo(engine.since)}` : '';
            const reason = !ready && engine.reason ? ` · ${shared.escapeHtml(engine.reason)}` : '';
            return `<div><span style="color:${color};font-weight:600">${shared.escapeHtml(label)}: ${state}</span><span class="nc-muted">${since}${reason}</span></div>`;
        };
        const down = voix.status !== 'ok' || engines.voxcpm?.ready === false;
        return `<div class="nc-host-card" role="status" style="margin-bottom:10px;padding:10px;border-left:3px solid ${down ? '#f59e0b' : '#4ade80'}">
            <strong>Voices</strong> <span class="nc-muted">VoiX ${voix.status === 'ok' ? 'up' : 'down'}</span>
            ${line('Cloned voice (worker)', engines.voxcpm)}${line('Catalog voices (Kokoro)', engines.kokoro)}
        </div>`;
    }

    async function loadHealth() {
        const body = document.getElementById('sectionHealthBody');
        if (!body) return;

        shared.renderSectionLoading(body, 'Loading health data...');

        try {
            const [json, panel] = await Promise.all([
                shared.fetchJson('/api/nerve-center/health/feed?limit=30'),
                // Household's panel names the speech engines; absent outside the full profile.
                shared.fetchJson('/api/panel/status').catch(() => null)
            ]);
            const events = json.data || [];
            const feedMeta = json.meta || {};

            const pinned = events.filter(event => event.type === 'alert' && event.status === 'active');
            const rest = events.filter(event => !(event.type === 'alert' && event.status === 'active'));

            const renderEvent = (event, isPinned) => {
                const severity = event.severity || 'info';
                const pinStyle = ` style="display:block;${isPinned ? 'border-left:3px solid #f59e0b;' : ''}"`;
                const groupedCount = Number(event.groupedCount) || 1;
                const occurrenceCount = Number(event.occurrenceCount) || 1;
                const evidenceBits = [];
                if (occurrenceCount > 1) evidenceBits.push(`${occurrenceCount} occurrences`);
                if (groupedCount > 1) evidenceBits.push(`${groupedCount} persisted rows grouped`);
                const descBits = [event.description, event.ruleName ? `rule: ${event.ruleName}` : '']
                    .concat(evidenceBits)
                    .filter(Boolean).join(' · ');
                const descLine = descBits
                    ? `<div style="font-size:0.72rem;color:var(--muted);margin:2px 0 0 20px;">${shared.escapeHtml(descBits)}</div>`
                    : '';
                const statusLabel = isPinned
                    ? 'ACTIVE'
                    : (event.type === 'alert' ? (event.status || 'history') : (event.outcome || event.status || 'history'));
                return `<div class="nc-event-item"${pinStyle}>
                    <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;">
                        <span class="nc-event-severity ${severity}" role="img" aria-label="${shared.escapeHtml(severity)}"></span>
                        <span class="nc-event-time">${shared.timeAgo(event.timestamp)}</span>
                        <span style="flex:1;">${shared.escapeHtml(event.title || '--')}</span>
                        <span style="font-size:0.7rem;color:${isPinned ? '#f59e0b' : 'var(--muted)'};background:rgba(255,255,255,0.05);padding:2px 6px;border-radius:4px;white-space:nowrap;">${shared.escapeHtml(String(statusLabel).toUpperCase())}</span>
                        <span style="font-size:0.7rem;color:var(--muted);background:rgba(255,255,255,0.05);padding:2px 6px;border-radius:4px;white-space:nowrap;">${shared.escapeHtml(event.source || '')}</span>
                    </div>${descLine}
                </div>`;
            };

            // Active alerts that need a person come first. Informational active
            // alerts (completed-work receipts) and history fold below them.
            const actionable = pinned.filter(event => (event.severity || 'info') !== 'info');
            const receipts = pinned.filter(event => (event.severity || 'info') === 'info');
            const actionRows = actionable.map(event => renderEvent(event, true));
            const foldedRows = receipts.map(event => renderEvent(event, false)).concat(rest.map(event => renderEvent(event, false)));
            const activeAlertCount = Number.isFinite(Number(feedMeta.activeAlertCount))
                ? Number(feedMeta.activeAlertCount)
                : pinned.length;
            const groupedRows = Number(feedMeta.groupedRows) || 0;
            const tone = actionable.length > 0 ? '#f59e0b' : '#4ade80';
            const feedContext = `<div class="nc-host-card" role="status" style="margin-bottom:10px;padding:10px;border-left:3px solid ${tone}">
                <strong style="color:${tone}">${actionable.length === 0 ? 'Nothing needs action' : `${actionable.length} ${actionable.length === 1 ? 'alert needs' : 'alerts need'} action`}</strong>
                <span class="nc-muted" style="margin-left:8px">in the latest ${events.length} events · ${activeAlertCount} active ${activeAlertCount === 1 ? 'alert' : 'alerts'} in total, receipts included${groupedRows > 0 ? ` · ${groupedRows} repeated rows grouped` : ''}.</span>
            </div>`;
            const voiceCard = renderVoices(panel?.data?.voix);
            const actionList = actionRows.length > 0
                ? `<div class="nc-event-list" style="max-height:400px;overflow-y:auto;">${actionRows.join('')}</div>` : '';
            const folded = foldedRows.length > 0
                ? `<details class="nc-feed-folded"><summary>Completed receipts and history (${foldedRows.length})</summary>
                    <div class="nc-event-list" style="max-height:400px;overflow-y:auto;">${foldedRows.join('')}</div></details>`
                : '';
            const feedHtml = events.length > 0
                ? `${voiceCard}${feedContext}${actionList}${folded}`
                : `${voiceCard}${feedContext}<div class="nc-section-placeholder" style="padding:20px;text-align:center;color:var(--muted);">No health events</div>`;

            body.innerHTML = feedHtml;
        } catch (err) {
            console.error('[NerveCenter] loadHealth error:', err);
            shared.renderSectionError(body, 'Failed to load health data');
        } finally {
            shared.finishSectionLoad(body);
        }
    }

    window.NerveCenterHealth = { loadHealth };
})();
