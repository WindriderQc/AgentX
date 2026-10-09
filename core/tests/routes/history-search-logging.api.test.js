'use strict';

const express = require('express');
const request = require('supertest');
const logger = require('../../config/logger');
const conversationSearchService = require('../../src/services/conversationSearchService');
const historyRoutes = require('../../routes/history');

const SEARCH_TEXT = 'synthetic private search words';

function buildApp() {
  const app = express();
  app.use('/api/history', historyRoutes);
  return app;
}

afterEach(() => jest.restoreAllMocks());

function loggedText(spy) {
  return JSON.stringify(spy.mock.calls);
}

test('a successful search logs the query length, never the search text', async () => {
  const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
  jest.spyOn(conversationSearchService, 'searchConversations').mockResolvedValue({
    status: 'success',
    data: { results: [], pagination: { totalResults: 0 } }
  });

  await request(buildApp()).get('/api/history/search')
    .query({ q: SEARCH_TEXT, page: '2', limit: '10' }).expect(200);

  expect(info).toHaveBeenCalledWith('Conversation search executed', expect.objectContaining({
    queryLength: SEARCH_TEXT.length, page: 2, limit: 10, resultsCount: 0
  }));
  expect(loggedText(info)).not.toContain('private search');
});

test('a failed search logs the query length, never the search text', async () => {
  const error = jest.spyOn(logger, 'error').mockImplementation(() => {});
  jest.spyOn(conversationSearchService, 'searchConversations').mockRejectedValue(new Error('search failed'));

  await request(buildApp()).get('/api/history/search').query({ q: SEARCH_TEXT }).expect(500);

  expect(error).toHaveBeenCalledWith('Conversation search failed', expect.objectContaining({
    queryLength: SEARCH_TEXT.length
  }));
  expect(loggedText(error)).not.toContain('private search');
});
