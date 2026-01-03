(function() {
    // Inject Styles
    const style = document.createElement('style');
    style.textContent = `
        .toast-container {
            position: fixed;
            top: 90px;
            right: 20px;
            z-index: 10000;
            display: flex;
            flex-direction: column;
            gap: 10px;
            pointer-events: none;
        }
        .toast {
            min-width: 300px;
            padding: 16px 20px;
            background: rgba(18, 23, 38, 0.95);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.06);
            border-radius: 12px;
            color: #e8edf5;
            font-size: 14px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.3);
            opacity: 0;
            transform: translateX(400px);
            transition: all 0.3s ease;
            pointer-events: all;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .toast.show {
            opacity: 1;
            transform: translateX(0);
        }
        .toast.success { border-left: 4px solid rgb(52, 211, 153); }
        .toast.error { border-left: 4px solid rgb(248, 113, 113); }
        .toast.info { border-left: 4px solid #7cf0ff; }
        .toast i { font-size: 18px; }
        .toast.success i { color: rgb(52, 211, 153); }
        .toast.error i { color: rgb(248, 113, 113); }
        .toast.info i { color: #7cf0ff; }
    `;
    document.head.appendChild(style);

    // Create Container
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    // Toast Logic
    function show(message, type = 'info', duration = 4000) {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        const iconMap = {
            success: 'fa-check-circle',
            error: 'fa-exclamation-circle',
            info: 'fa-info-circle'
        };

        toast.innerHTML = `
            <i class="fas ${iconMap[type] || iconMap.info}"></i>
            <span>${message}</span>
        `;

        container.appendChild(toast);

        // Trigger animation
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        // Auto-remove
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                toast.remove();
            }, 300);
        }, duration);
    }

    // Expose global
    window.toast = {
        success: (msg, duration) => show(msg, 'success', duration),
        error: (msg, duration) => show(msg, 'error', duration),
        info: (msg, duration) => show(msg, 'info', duration)
    };
})();
