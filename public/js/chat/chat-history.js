/**
 * Chat history — loadHistoryList, loadConversation, judging, search/filters
 */
import { sanitizeHTML } from './chat-messaging.js';

export async function loadHistoryList(elements, state) {
  try {
    const url = window.WorkspaceManager
      ? WorkspaceManager.addWorkspaceParam('/api/history')
      : '/api/history';
    const res = await fetch(url);
    const { data } = await res.json();
    elements.historyList.innerHTML = '';
    if (!Array.isArray(data)) return [];

    data.forEach(item => {
      const div = document.createElement('div');
      div.className = 'history-item';
      if (state.conversationId === item.id) div.classList.add('active');

      let scoreBadge = '';
      if (item.qualityScore != null) {
        const color = item.qualityScore >= 80 ? '#22c55e' : item.qualityScore >= 60 ? '#eab308' : item.qualityScore >= 40 ? '#f59e0b' : '#ef4444';
        scoreBadge = `<span class="quality-badge" style="background:${color};color:#000;padding:1px 5px;border-radius:3px;font-size:0.65rem;font-weight:700;margin-left:6px;" title="Quality: ${item.qualityScore}/100">${item.qualityScore}</span>`;
      }

      div.innerHTML = `
        <div class="history-item-header">
          <div class="title">${sanitizeHTML(item.title)}${scoreBadge}</div>
          <div class="history-item-actions">
            <button class="judge-btn ghost" title="Judge quality" data-id="${item.id}" style="padding:2px 6px;font-size:0.7rem;flex-shrink:0;">
              <i class="fas fa-star"></i>
            </button>
            <button class="history-menu-btn ghost" title="More actions" data-id="${item.id}" style="padding:2px 6px;font-size:0.7rem;flex-shrink:0;">
              <i class="fas fa-ellipsis-v"></i>
            </button>
          </div>
        </div>
        <div class="date">${new Date(item.date).toLocaleString()}</div>
      `;

      // Click to load conversation
      div.querySelector('.title').parentElement.addEventListener('click', (e) => {
        if (!e.target.closest('.judge-btn') && !e.target.closest('.history-menu-btn')) {
          state._helpers.loadConversation(item.id);
        }
      });

      // Judge button
      div.querySelector('.judge-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        judgeConversationFromHistory(item.id, e.currentTarget);
      });

      // Context menu button
      div.querySelector('.history-menu-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        showHistoryContextMenu(e.currentTarget, item, state, elements);
      });

      elements.historyList.appendChild(div);
    });
    return data;
  } catch (err) {
    console.error('Failed to load history', err);
    return [];
  }
}

function showHistoryContextMenu(btn, item, state, elements) {
  // Remove any existing context menu
  const existing = document.querySelector('.history-context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'history-context-menu';
  menu.innerHTML = `
    <button class="ctx-menu-item" data-action="rename"><i class="fas fa-pen"></i> Rename</button>
    <button class="ctx-menu-item" data-action="export"><i class="fas fa-download"></i> Export</button>
    <button class="ctx-menu-item ctx-menu-danger" data-action="delete"><i class="fas fa-trash"></i> Delete</button>
  `;

  // Position near the button
  const rect = btn.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left - 100}px`;
  menu.style.zIndex = '9999';

  document.body.appendChild(menu);

  // Close on outside click
  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);

  // Actions
  menu.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    menu.remove();

    if (action === 'rename') {
      const newTitle = prompt('Rename conversation:', item.title);
      if (newTitle && newTitle.trim()) {
        try {
          const fetchOptions = {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: newTitle.trim() }),
            credentials: 'include'
          };
          await fetch(`/api/history/${item.id}`,
            window.WorkspaceManager ? WorkspaceManager.addWorkspaceHeader(fetchOptions) : fetchOptions
          );
          state._helpers.loadHistoryList();
          if (typeof Toast !== 'undefined') Toast.success('Conversation renamed');
        } catch (err) {
          console.error('Rename failed:', err);
        }
      }
    } else if (action === 'export') {
      try {
        const url = window.WorkspaceManager
          ? WorkspaceManager.addWorkspaceParam(`/api/history/${item.id}`)
          : `/api/history/${item.id}`;
        const res = await fetch(url);
        const responseData = await res.json();
        const conv = responseData.data || responseData;
        if (conv && conv.messages) {
          let md = `# ${conv.title || 'Conversation'}\n\n`;
          md += `Model: ${conv.model || 'unknown'}\nDate: ${new Date(conv.createdAt).toLocaleString()}\n\n---\n\n`;
          conv.messages.forEach(m => {
            md += `**${m.role === 'user' ? 'You' : 'AgentX'}:**\n${m.content}\n\n`;
          });
          const blob = new Blob([md], { type: 'text/markdown' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `${(conv.title || 'conversation').replace(/[^a-z0-9]/gi, '_')}.md`;
          a.click();
          URL.revokeObjectURL(a.href);
          if (typeof Toast !== 'undefined') Toast.success('Conversation exported');
        }
      } catch (err) {
        console.error('Export failed:', err);
      }
    } else if (action === 'delete') {
      if (confirm('Delete this conversation? This cannot be undone.')) {
        try {
          const fetchOptions = { method: 'DELETE', credentials: 'include' };
          await fetch(`/api/history/${item.id}`,
            window.WorkspaceManager ? WorkspaceManager.addWorkspaceHeader(fetchOptions) : fetchOptions
          );
          if (state.conversationId === item.id) {
            state.conversationId = null;
            state._helpers.clearChat();
          }
          state._helpers.loadHistoryList();
          if (typeof Toast !== 'undefined') Toast.success('Conversation deleted');
        } catch (err) {
          console.error('Delete failed:', err);
        }
      }
    }
  });
}

export async function loadJudgedConversations(elements, state, minScore = 0) {
  try {
    const params = new URLSearchParams({ limit: '50', minScore: String(minScore) });
    let url = `/api/conversations/judged?${params}`;
    if (window.WorkspaceManager) url = WorkspaceManager.addWorkspaceParam(url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { data } = await res.json();
    elements.historyList.innerHTML = '';
    if (!data?.conversations?.length) {
      elements.historyList.innerHTML = '<div style="padding:1rem;color:var(--muted);font-size:0.8rem;text-align:center;">No judged conversations found.</div>';
      return;
    }
    data.conversations.forEach(conv => {
      const div = document.createElement('div');
      div.className = 'history-item';
      const score = conv.quality_assessment?.overall_score ?? 0;
      const color = score >= 80 ? '#22c55e' : score >= 60 ? '#eab308' : score >= 40 ? '#f59e0b' : '#ef4444';
      const judgedAt = conv.quality_assessment?.judged_at
        ? new Date(conv.quality_assessment.judged_at).toLocaleDateString()
        : '';
      div.innerHTML = `
        <div class="history-item-header">
          <div class="title">${sanitizeHTML(conv.title || 'Untitled')}<span class="quality-badge" style="background:${color};color:#000;padding:1px 5px;border-radius:3px;font-size:0.65rem;font-weight:700;margin-left:6px;" title="Quality: ${score}/100">${score}</span></div>
        </div>
        <div class="date">${conv.model || ''} ${judgedAt ? '\u00b7 Judged ' + judgedAt : ''}</div>
      `;
      div.addEventListener('click', () => {
        state._helpers.loadConversation(conv._id);
      });
      elements.historyList.appendChild(div);
    });
  } catch (err) {
    console.error('Failed to load judged conversations', err);
    elements.historyList.innerHTML = '<div style="padding:1rem;color:var(--muted);font-size:0.8rem;">Failed to load judged conversations.</div>';
  }
}

async function judgeConversationFromHistory(conversationId, btn) {
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  try {
    const fetchOptions = { method: 'POST', credentials: 'include' };
    const res = await fetch(
      `/api/conversations/${conversationId}/judge`,
      window.WorkspaceManager ? WorkspaceManager.addWorkspaceHeader(fetchOptions) : fetchOptions
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.status === 'success' && data.data?.quality_assessment) {
      const score = data.data.quality_assessment.overall_score;
      const color = score >= 80 ? '#22c55e' : score >= 60 ? '#eab308' : score >= 40 ? '#f59e0b' : '#ef4444';
      const titleEl = btn.closest('.history-item-header')?.querySelector('.title');
      if (titleEl && !titleEl.querySelector('.quality-badge')) {
        titleEl.insertAdjacentHTML('beforeend', `<span class="quality-badge" style="background:${color};color:#000;padding:1px 5px;border-radius:3px;font-size:0.65rem;font-weight:700;margin-left:6px;" title="Quality: ${score}/100">${score}</span>`);
      }
      if (typeof Toast !== 'undefined') Toast.success(`Judged: ${score}/100`);
    }
  } catch (err) {
    console.error('Judge from history failed:', err);
    if (typeof Toast !== 'undefined') Toast.error(`Judge failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-star"></i>';
  }
}

export async function loadConversation(id, state, elements, helpers, preserveModelSelection = false) {
  try {
    const url = window.WorkspaceManager
      ? WorkspaceManager.addWorkspaceParam(`/api/history/${id}`)
      : `/api/history/${id}`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 404) {
        console.warn(`Conversation ${id} not found.`);
        state.conversationId = null;
        return false;
      }
      throw new Error(`Failed to load conversation: ${res.status}`);
    }
    const responseData = await res.json();
    const data = responseData.data || responseData;
    if (!data || !data._id) throw new Error('Invalid conversation data received');

    state.conversationId = data._id;
    state.history = [];
    elements.chatWindow.innerHTML = '';
    state.stats.messages = 0;
    state.stats.replies = 0;

    helpers.updateConversationStats(data);

    // Highlight active history item
    document.querySelectorAll('.history-item').forEach(el => el.classList.remove('active'));
    const activeItem = document.querySelector(`.history-item [data-id="${id}"]`)?.closest('.history-item');
    if (activeItem) activeItem.classList.add('active');

    if (!Array.isArray(data.messages)) return false;
    data.messages.forEach(msg => {
      helpers.appendMessage({
        role: msg.role,
        content: msg.content,
        createdAt: msg.createdAt,
        id: msg._id,
        feedback: msg.feedback,
        stats: msg.stats,
        cost: msg.cost,
        ragSources: msg.ragSources
      }, { persist: true, count: true });
    });

    if (!preserveModelSelection && data.model) {
      const modelExists = Array.from(elements.modelSelect.options).some(opt => opt.value === data.model);
      if (modelExists) elements.modelSelect.value = data.model;
    }

    if (data.quality_assessment?.overall_score != null) {
      helpers.displayQualityAssessment(data.quality_assessment);
    }
    return true;
  } catch (err) {
    console.error('Failed to load conversation', err);
    return false;
  }
}

export function wireHistoryTabs(elements, state, helpers) {
  const viewAllBtn = document.getElementById('viewAllBtn');
  const viewJudgedBtn = document.getElementById('viewJudgedBtn');
  const minScoreControl = document.getElementById('minScoreControl');
  const minScoreInput = document.getElementById('minScoreInput');

  if (viewAllBtn && viewJudgedBtn) {
    viewAllBtn.addEventListener('click', () => {
      viewAllBtn.classList.add('active');
      viewJudgedBtn.classList.remove('active');
      if (minScoreControl) minScoreControl.style.display = 'none';
      helpers.loadHistoryList();
    });
    viewJudgedBtn.addEventListener('click', () => {
      viewJudgedBtn.classList.add('active');
      viewAllBtn.classList.remove('active');
      if (minScoreControl) minScoreControl.style.display = '';
      loadJudgedConversations(elements, state, parseInt(minScoreInput?.value) || 0);
    });
    if (minScoreInput) {
      minScoreInput.addEventListener('change', () => {
        if (viewJudgedBtn.classList.contains('active')) {
          loadJudgedConversations(elements, state, parseInt(minScoreInput.value) || 0);
        }
      });
    }
  }
}
