(function(){
    const feedEl = document.getElementById('feed');
    const renderEvent = (evt) => {
        const el = document.createElement('div');
        el.className = 'event';
        const header = document.createElement('div');
        header.innerHTML = `<span class='type'>${evt.type || 'event'}</span> <span class='ts'>${new Date(evt.timestamp || Date.now()).toLocaleString()}</span>`;
        el.appendChild(header);

        const msg = document.createElement('div');
        msg.textContent = evt.message || JSON.stringify(evt, null, 2);
        el.appendChild(msg);

        if (evt.stack) {
            const stack = document.createElement('pre');
            stack.className = 'stack';
            stack.textContent = evt.stack;
            el.appendChild(stack);
        }

        // pretty print extra fields
        const extras = Object.assign({}, evt);
        delete extras.message; delete extras.timestamp; delete extras.type; delete extras.stack;
        const keys = Object.keys(extras).filter(k => extras[k] !== undefined && extras[k] !== null && k !== 'id');
        if (keys.length) {
            const meta = document.createElement('pre');
            meta.style.color = '#94a3b8';
            meta.textContent = JSON.stringify(extras, null, 2);
            el.appendChild(meta);
        }

        feedEl.insertBefore(el, feedEl.firstChild);
    };

    // render initial feed
    const initial = window.__INITIAL_ADMIN_FEED__ || [];
    initial.forEach(e => renderEvent(e));

    // subscribe to private SSE
    const url = '/api/v1/feed/events/private';
    const es = new EventSource(url);
    es.onmessage = (msg) => {
        try {
            const data = JSON.parse(msg.data);
            renderEvent(data);
        } catch (e) {
            console.error('Failed to parse SSE message', e);
        }
    };
    es.onerror = (err) => {
        console.error('SSE error', err);
        const errEl = document.createElement('div');
        errEl.textContent = 'SSE connection error';
        feedEl.insertBefore(errEl, feedEl.firstChild);
    };
})();
