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
