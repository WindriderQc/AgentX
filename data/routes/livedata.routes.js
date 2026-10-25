const router = require('express').Router();
const liveDataController = require('../controllers/liveDataController');
const liveDataSourcesController = require('../controllers/liveDataSourcesController');

// Config / state
router.get('/state', liveDataController.getState);
router.get('/config', liveDataController.getConfig);
router.post('/config', liveDataController.updateConfig);

// Registry + per-feed health
router.get('/feeds', liveDataController.getFeeds);

// Legacy aliases (single-segment — kept for existing consumers / dataapiClient)
router.get('/iss', liveDataController.getISS);
router.get('/quakes', liveDataController.getQuakes);
router.get('/pressure', liveDataController.getPressure);
router.get('/weather', liveDataController.getWeather);

// On-demand sources (no master switch, nothing stored; cached in memory)
router.get('/tle', liveDataSourcesController.getTle);
router.get('/tides', liveDataSourcesController.getTides);
router.get('/ec-weather', liveDataSourcesController.getEcWeather);

// Uniform per-feed consumption (two-segment — works for any registry feed)
router.get('/:feed/latest', liveDataController.getFeedLatest);
router.get('/:feed/history', liveDataController.getFeedHistory);
router.get('/:feed/stream', liveDataController.streamFeed);

module.exports = router;
