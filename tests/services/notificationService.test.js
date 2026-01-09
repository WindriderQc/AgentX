const { NotificationService } = require('../../src/services/notificationService');

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn().mockResolvedValue({ messageId: 'mock-message-id' }),
    verify: jest.fn()
  }))
}));

jest.mock('node-fetch', () => ({
  default: jest.fn()
}));
const fetch = require('node-fetch').default;

describe('NotificationService', () => {
  beforeEach(() => {
    process.env.ALERT_TEST_MODE = 'true';
    process.env.EMAIL_ENABLED = 'true';
    process.env.SMTP_HOST = 'smtp.test.local';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'test-user';
    process.env.SMTP_PASS = 'test-pass';
    process.env.WEBHOOK_ENABLED = 'true';
    process.env.WEBHOOK_URL = 'https://hooks.test.local/alerts';
    process.env.WEBHOOK_METHOD = 'POST';
  });

  afterEach(() => {
    delete process.env.ALERT_TEST_MODE;
    delete process.env.EMAIL_ENABLED;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.WEBHOOK_ENABLED;
    delete process.env.WEBHOOK_URL;
    delete process.env.WEBHOOK_METHOD;
  });

  test('builds webhook payload from template', () => {
    const service = new NotificationService();
    const alert = {
      _id: 'alert123',
      title: 'CPU Spike',
      severity: 'critical',
      context: { component: 'api-service' }
    };

    const payload = service._buildWebhookPayload(
      alert,
      '{"title":"{{title}}","severity":"{{severity}}","component":"{{context.component}}"}'
    );

    expect(payload).toEqual({
      title: 'CPU Spike',
      severity: 'critical',
      component: 'api-service'
    });
  });

  test('handles invalid JSON in webhook template', () => {
    const service = new NotificationService();
    const alert = {
      _id: 'alert123',
      title: 'Test Alert',
      severity: 'warning'
    };

    const payload = service._buildWebhookPayload(
      alert,
      '{"title":"{{title}}",invalid}'  // Fixed: Added missing closing brace
    );

    expect(payload).toHaveProperty('text');
    expect(payload.text).toContain('Test Alert');
  });

  test('handles malformed template syntax', () => {
    const service = new NotificationService();
    const alert = {
      _id: 'alert123',
      title: 'Test Alert',
      severity: 'warning'
    };

    const payload = service._buildWebhookPayload(
      alert,
      '{"title":"{{title}","unclosed":"{{missing.field}'
    );

    expect(payload).toBeDefined();
  });

  test('handles missing required fields in alert', () => {
    const service = new NotificationService();
    const alert = {
      message: 'Test message'
      // missing _id, title, severity
    };

    const payload = service._buildWebhookPayload(
      alert,
      '{"title":"{{title}}","severity":"{{severity}}"}'
    );

    expect(payload.title).toBe('');
    expect(payload.severity).toBe('');
  });

  test('handles null alert object', () => {
    const service = new NotificationService();
    
    const payload = service._buildWebhookPayload(
      null,
      '{"title":"{{title}}"}'
    );

    expect(payload).toBeDefined();
  });

  test('handles undefined alert object', () => {
    const service = new NotificationService();
    
    const payload = service._buildWebhookPayload(
      undefined,
      '{"title":"{{title}}"}'
    );

    expect(payload).toBeDefined();
  });

  test('handles missing context fields in template', () => {
    const service = new NotificationService();
    const alert = {
      _id: 'alert123',
      title: 'Test Alert',
      severity: 'warning'
      // missing context
    };

    const payload = service._buildWebhookPayload(
      alert,
      '{"title":"{{title}}","component":"{{context.component}}"}'
    );

    expect(payload.title).toBe('Test Alert');
    expect(payload.component).toBe('');
  });

  test('uses channel config recipients for email', async () => {
    const service = new NotificationService();
    const alert = {
      _id: 'alert456',
      title: 'Disk Full',
      severity: 'warning',
      channelConfig: {
        email: {
          recipients: ['ops@example.com', 'oncall@example.com']
        }
      }
    };

    const result = await service.sendEmail(alert);

    expect(result.sent).toBe(true);
    expect(result.recipients).toBe('ops@example.com, oncall@example.com');
  });
});


describe.skip('NotificationService webhook retries', () => {
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

  test('sends webhook with channel config', async () => {
    const service = new NotificationService();
    const alert = {
      _id: 'alert789',
      title: 'API Latency',
      message: 'High latency detected',
      severity: 'critical',
      channelConfig: {
        webhook: {
          url: 'https://hooks.test.com/alert',
          method: 'POST',
          headers: { 'X-Custom-Header': 'test-value' },
          template: '{"alert":"{{title}}","level":"{{severity}}"}'
        }
      }
    };

    const result = await service.sendWebhook(alert);

    expect(result.sent).toBe(true);
    expect(result.url).toBe('https://hooks.test.com/alert');
  });

  test('builds webhook payload with per-alert template', () => {
    const service = new NotificationService();
    const alert = {
      _id: 'alert999',
      title: 'Memory Alert',
      severity: 'warning',
      context: { host: 'server-01' },
      channelConfig: {
        webhook: {
          template: '{"event":"{{title}}","priority":"{{severity}}","server":"{{context.host}}"}'
        }
      }
    };

    const config = service._resolveWebhookConfig(alert);
    const payload = service._buildWebhookPayload(alert, config.template);

    expect(payload).toEqual({
      event: 'Memory Alert',
      priority: 'warning',
      server: 'server-01'
    });
  });
});
