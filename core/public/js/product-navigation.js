(function() {
  var container = document.getElementById('nav-container');
  var navItems = document.querySelectorAll('#nav-container .nav-item');
  var tools = container && container.querySelector('.nav-tools');
  if (tools) {
    tools.addEventListener('toggle', function() { if (tools.open) closeAll(null); });
    tools.addEventListener('focusout', function() {
      window.setTimeout(function() { if (!tools.contains(document.activeElement)) tools.open = false; }, 0);
    });
  }

  function controls(item) {
    return {
      button: item.querySelector('button.nav-link'),
      menu: item.querySelector('.nav-dropdown')
    };
  }

  function syncContainerState() {
    if (!container) return;
    container.classList.toggle('has-open-menu', !!container.querySelector('.nav-item.open'));
  }

  function setOpen(item, open, focusFirst) {
    var pair = controls(item);
    if (!pair.button || !pair.menu) return;
    item.classList.toggle('open', open);
    pair.button.setAttribute('aria-expanded', open ? 'true' : 'false');
    syncContainerState();
    if (open && focusFirst) {
      var first = pair.menu.querySelector('.dropdown-item:not([disabled])');
      if (first) first.focus();
    }
  }

  function closeAll(except) {
    navItems.forEach(function(item) {
      if (item !== except) setOpen(item, false, false);
    });
    syncContainerState();
  }

  navItems.forEach(function(item) {
    var pair = controls(item);
    var btn = pair.button;
    var menu = pair.menu;
    if (!btn || !menu) return;

    btn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var willOpen = !item.classList.contains('open');
      closeAll(item);
      if (tools) tools.open = false;
      setOpen(item, willOpen, false);
    });

    btn.addEventListener('keydown', function(e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        closeAll(item);
        if (tools) tools.open = false;
        setOpen(item, true, true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(item, false, false);
      }
    });

    menu.addEventListener('keydown', function(e) {
      var entries = Array.prototype.slice.call(menu.querySelectorAll('.dropdown-item:not([disabled])'));
      var index = entries.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(item, false, false);
        btn.focus();
      } else if (e.key === 'ArrowDown' && entries.length) {
        e.preventDefault();
        entries[(index + 1 + entries.length) % entries.length].focus();
      } else if (e.key === 'ArrowUp' && entries.length) {
        e.preventDefault();
        entries[(index - 1 + entries.length) % entries.length].focus();
      } else if (e.key === 'Home' && entries.length) {
        e.preventDefault();
        entries[0].focus();
      } else if (e.key === 'End' && entries.length) {
        e.preventDefault();
        entries[entries.length - 1].focus();
      }
    });

    item.addEventListener('focusout', function() {
      window.setTimeout(function() {
        if (!item.contains(document.activeElement)) setOpen(item, false, false);
      }, 0);
    });
  });

  /* Close dropdowns on outside click */
  document.addEventListener('click', function(e) {
    if (tools && !tools.contains(e.target)) tools.open = false;
    if (!e.target.closest('.nav-item')) {
      closeAll(null);
    }
  });

  /* ── Action handlers (keyboard shortcuts, etc.) ────────── */
  document.querySelectorAll('#nav-container [data-nav-action]').forEach(function(el) {
    el.addEventListener('click', function() {
      var action = el.dataset.navAction;
      if (action === 'show-shortcuts' && typeof ShortcutsHelpModal !== 'undefined') {
        closeAll(null);
        ShortcutsHelpModal.show();
      }
    });
  });

  /* ── Ctrl+/ opens shortcuts modal ──────────────────────── */
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      if (tools && tools.open) { tools.open = false; tools.querySelector('summary').focus(); }
      var openItem = container && container.querySelector('.nav-item.open');
      if (openItem) {
        var openButton = openItem.querySelector('button.nav-link');
        setOpen(openItem, false, false);
        if (openButton) openButton.focus();
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      if (typeof ShortcutsHelpModal !== 'undefined') {
        ShortcutsHelpModal.show();
      }
    }
  });
})();
