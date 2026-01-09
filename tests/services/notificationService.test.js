const { NotificationService } = require('../../src/services/notificationService');

// Mock node-fetch
const mockFetch = jest.fn();
jest.mock('node-fetch', () => ({
  default: mockFetch,
  __esModule: true,
}));

// Mock nodemailer
const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'mock-message-id' });
const mockVerify = jest.fn().mockResolvedValue(true);
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: mockSendMail,
    verify: mockVerify
  }))
}));

describe('NotificationService', () => {
  let service;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.ALERT_TEST_MODE = 'false'; // Important: Disable test mode to test real logic
    process.env.EMAIL_ENABLED = 'true';
    process.env.SMTP_HOST = 'smtp.test.local';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'test-user';
    process.env.SMTP_PASS = 'test-pass';
    process.env.WEBHOOK_ENABLED = 'true';
    process.env.WEBHOOK_URL = 'https://hooks.test.local/alerts';
    process.env.WEBHOOK_METHOD = 'POST';
    process.env.SLACK_ENABLED = 'true';
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/test';
    
    mockFetch.mockReset();
    mockSendMail.mockClear();
    
    service = new NotificationService();
    // Mock _getFetch to return our mockFetch directly, avoiding dynamic import issues in Jest
    service._getFetch = jest.fn().mockResolvedValue(mockFetch);
    // Mock _sleep to avoid waiting
    service._sleep = jest.fn().mockResolvedValue();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('Webhook Payload & Templates', () => {
    test('builds webhook payload from template', () => {
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
        const alert = {
          _id: 'alert123',
          title: 'Test Alert',
          severity: 'warning'
        };
    
        const payload = service._buildWebhookPayload(
          alert,
          '{"title":"{{title}}",invalid}' 
        );
    
        expect(payload).toHaveProperty('text');
        expect(payload.text).toContain('Test Alert');
      });
  });

  describe('Email Notifications', () => {
      test('sends email with HTML content', async () => {
          const alert = {
              _id: 'alert-email-1',
              title: 'Email Alert',
              severity: 'critical',
              message: 'Something went wrong',
              emailRecipients: ['admin@example.com']
          };

          const result = await service.sendEmail(alert);

          expect(result.sent).toBe(true);
          expect(mockSendMail).toHaveBeenCalledTimes(1);
          const callArgs = mockSendMail.mock.calls[0][0];
          expect(callArgs.to).toBe('admin@example.com');
          expect(callArgs.subject).toContain('CRITICAL');
          expect(callArgs.html).toContain('<!DOCTYPE html>');
          expect(callArgs.html).toContain('background-color: #dc3545'); // critical red
          expect(callArgs.html).toContain('Something went wrong');
      });

      test('uses templates for email subject', async () => {
        const alert = {
            _id: 'alert-email-2',
            title: 'Subject Alert',
            severity: 'info',
            channelConfig: {
                email: {
                    subject: 'Alert: {{title}} ({{severity}})',
                    recipients: ['user@example.com']
                }
            }
        };

        await service.sendEmail(alert);
        
        const callArgs = mockSendMail.mock.calls[0][0];
        expect(callArgs.subject).toBe('Alert: Subject Alert (info)');
      });
  });

  describe('Retries (Webhook)', () => {
    test('retries webhook until success', async () => {
        // Fail twice, succeed third time
        mockFetch
            .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('Server Error') })
            .mockRejectedValueOnce(new Error('Network Error'))
            .mockResolvedValueOnce({ ok: true, status: 200 });

        const result = await service.sendWebhook({ _id: 'alert-retry-1', title: 'Retry Test' });

        expect(result.sent).toBe(true);
        expect(result.attempts).toBe(3);
        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(service._sleep).toHaveBeenCalledTimes(2);
    });

    test('fails after max retries', async () => {
        process.env.WEBHOOK_RETRY_MAX_ATTEMPTS = '2';
        // Re-init service to pick up env
        service = new NotificationService();
        service._getFetch = jest.fn().mockResolvedValue(mockFetch);
        service._sleep = jest.fn().mockResolvedValue();

        mockFetch.mockRejectedValue(new Error('Persistent Error'));

        const result = await service.sendWebhook({ _id: 'alert-fail-1' });

        expect(result.sent).toBe(false);
        expect(result.attempts).toBe(2); // Max attempts
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('Retries (Slack)', () => {
    test('retries slack until success', async () => {
        process.env.SLACK_RETRY_MAX_ATTEMPTS = '3';
        
        mockFetch
            .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve('Service Unavailable') })
            .mockResolvedValueOnce({ ok: true, status: 200 });

        const result = await service.sendSlack({ 
            _id: 'alert-slack-1', 
            title: 'Slack Retry',
            severity: 'high'
        });

        expect(result.sent).toBe(true);
        expect(result.attempts).toBe(2);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch.mock.calls[0][0]).toBe(process.env.SLACK_WEBHOOK_URL);
    });
  });

  describe('Calculations', () => {
      test('calculates exponential backoff', () => {
        const retryConfig = { baseDelayMs: 100, jitterMs: 0 };
        // Attempt 0 (1st retry) -> 100 * 2^0 = 100
        // Attempt 1 (2nd retry) -> 100 * 2^1 = 200
        // Attempt 2 (3rd retry) -> 100 * 2^2 = 400
        
        expect(service._calculateRetryDelay(0, retryConfig)).toBe(100);
        expect(service._calculateRetryDelay(1, retryConfig)).toBe(200);
        expect(service._calculateRetryDelay(2, retryConfig)).toBe(400);
      });
  });
});
