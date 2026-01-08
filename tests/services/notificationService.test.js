const { NotificationService } = require('../../src/services/notificationService');

jest.mock('node-fetch', () => ({
  default: jest.fn()
}));

const fetch = require('node-fetch').default;

describe('NotificationService webhook retries', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    fetch.mockReset();
  });

  test('calculates exponential backoff with jitter', () => {
    process.env.WEBHOOK_RETRY_BASE_DELAY_MS = '500';
    process.env.WEBHOOK_RETRY_JITTER_MS = '250';

    const service = new NotificationService();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);

    const delay = service._calculateWebhookRetryDelay(0);
    expect(delay).toBe(625);

    Math.random.mockRestore();
  });

  test('retries webhook until success', async () => {
    process.env.WEBHOOK_ENABLED = 'true';
    process.env.WEBHOOK_URL = 'https://example.com/webhook';
    process.env.WEBHOOK_RETRY_MAX_ATTEMPTS = '3';

    const service = new NotificationService();
    service._sleep = jest.fn(() => Promise.resolve());

    fetch
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: jest.fn().mockResolvedValue('')
      });

    const result = await service.sendWebhook({ _id: 'alert-1' });

    expect(result.sent).toBe(true);
    expect(result.attempts).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('returns failure after exhausting retries', async () => {
    process.env.WEBHOOK_ENABLED = 'true';
    process.env.WEBHOOK_URL = 'https://example.com/webhook';
    process.env.WEBHOOK_RETRY_MAX_ATTEMPTS = '2';

    const service = new NotificationService();
    service._sleep = jest.fn(() => Promise.resolve());

    fetch.mockRejectedValue(new Error('timeout'));

    const result = await service.sendWebhook({ _id: 'alert-2' });

    expect(result.sent).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.lastError).toBe('timeout');
  });
});
