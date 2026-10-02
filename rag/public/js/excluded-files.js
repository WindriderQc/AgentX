/**
 * Excluded files panel — lists files removed with "Delete and exclude" and
 * restores them so the next scan ingests them again.
 */
(function () {
  'use strict';

  var panel, tbody, status;

  function setStatus(text) {
    status.textContent = text;
  }

  function renderRow(file) {
    var tr = document.createElement('tr');
    var pathCell = document.createElement('td');
    var code = document.createElement('code');
    code.textContent = file.path;
    pathCell.appendChild(code);
    var dateCell = document.createElement('td');
    dateCell.textContent = file.excludedAt ? new Date(file.excludedAt).toLocaleString() : '—';
    var actionCell = document.createElement('td');
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-secondary btn-sm';
    button.textContent = 'Restore';
    button.addEventListener('click', function () { restore(file.path, button); });
    actionCell.appendChild(button);
    tr.appendChild(pathCell);
    tr.appendChild(dateCell);
    tr.appendChild(actionCell);
    return tr;
  }

  async function load() {
    setStatus('Loading excluded files…');
    try {
      var response = await window.RAG.listExcludedFiles();
      var files = response.data.files || [];
      tbody.replaceChildren.apply(tbody, files.map(renderRow));
      setStatus(files.length ? files.length + ' excluded file' + (files.length === 1 ? '' : 's') + '.' : 'No excluded files.');
    } catch (err) {
      setStatus('Could not load excluded files: ' + (err.message || 'unknown error'));
    }
  }

  async function restore(path, button) {
    button.disabled = true;
    try {
      await window.RAG.restoreExcludedFile(path);
      await load();
      setStatus('Restored ' + path + '. The next scan indexes it again.');
    } catch (err) {
      button.disabled = false;
      setStatus('Restore failed: ' + (err.message || 'unknown error'));
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    panel = document.getElementById('excluded-files');
    tbody = document.getElementById('excluded-files-tbody');
    status = document.getElementById('excluded-files-status');
    if (!panel || !window.RAG) return;
    panel.addEventListener('toggle', function () { if (panel.open) load(); });
    document.addEventListener('rag:files-excluded', function () { if (panel.open) load(); });
  });
})();
