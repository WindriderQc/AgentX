'use strict';

const path = require('node:path');
const { calendarWindow, readCalendarView } = require('../../src/services/calendarPresentation');

// Registered behind Household's existing device boundary. This surface only
// composes personalCalendarService and the shared presentation reader.
function registerCalendarRoutes({ app, calendar, reader, env = process.env, now = Date.now } = {}) {
  const page = require('../../src/ui/productShell').surfacePage(app, path.join(__dirname, 'pages/calendar.html'), { activePage: 'dad' });
  app.get('/dad/calendar', (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      calendarWindow(req.query, { env, now });
      return page(req, res, next);
    } catch {
      return res.status(400).type('text').send('Période du calendrier invalide.');
    }
  });
  app.get('/api/personal-calendar/view', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const data = await readCalendarView(req.query, { calendar, reader, env, now });
      return res.json({ ok: true, data });
    } catch (error) {
      const badQuery = error.code === 'CALENDAR_VIEW_INVALID';
      return res.status(badQuery ? 400 : 502).json({ ok: false, code: badQuery ? error.code : 'CALENDAR_VIEW_UNAVAILABLE',
        message: badQuery ? 'Période du calendrier invalide.' : 'Agenda indisponible. Vous pouvez réessayer la consultation.' });
    }
  });
}

module.exports = { registerCalendarRoutes };
