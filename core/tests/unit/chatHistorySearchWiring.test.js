'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const view = fs.readFileSync(path.join(root, 'views/pages/chat.ejs'), 'utf8');
const search = fs.readFileSync(path.join(root, 'public/js/chat/chat-history-search.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'public/js/chat/chat-main.js'), 'utf8');

describe('chat history search wiring', () => {
  const controls = [
    'conversationSearchInput', 'clearSearchBtn', 'toggleFiltersBtn', 'filterPanel',
    'filterDateFrom', 'filterDateTo', 'filterModel', 'filterRagOnly', 'filterFeedback',
    'filterTagsInput', 'filterTagsChips', 'filterSortBy', 'applyFiltersBtn', 'clearFiltersBtn',
    'paginationControls', 'paginationInfo', 'prevPageBtn', 'nextPageBtn'
  ];

  test.each(controls)('%s in the view is wired by the search module', (id) => {
    expect(view).toContain(`id="${id}"`);
    expect(search).toContain(`'${id}'`);
  });

  test('searches through the visibility-filtered endpoint and is started by the page', () => {
    expect(search).toContain('/api/history/search?');
    expect(main).toContain('initHistorySearch(elements, state)');
  });
});
