const { NotificationService } = require('../../src/services/notificationService');

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn().mockResolvedValue({ messageId: 'mock-message-id' }),
    verify: jest.fn()
  }))
}));

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
      '{"title":"{{title}",invalid}'
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
