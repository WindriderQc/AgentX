const auditLogger = require('../../src/middleware/auditLogger');
const AuditLog = require('../../models/AuditLog');
const logger = require('../../config/logger');

// Mock AuditLog model
jest.mock('../../models/AuditLog');
// Mock logger to prevent terminal noise
jest.mock('../../config/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn()
}));

describe('Audit Logger Middleware', () => {
    let req, res, next;
    let originalJson;

    beforeEach(() => {
        jest.clearAllMocks();

        req = {
            method: 'POST',
            originalUrl: '/api/test',
            body: { name: 'Test', password: 'secret123', apiKey: 'agx_secret' },
            query: { filter: 'active' },
            ip: '127.0.0.1',
            get: jest.fn(header => {
                if (header === 'user-agent') return 'Jest-Test-Agent';
                return null;
            }),
            authSource: 'api-key'
        };

        originalJson = jest.fn();
        res = {
            statusCode: 200,
            json: originalJson,
            locals: {
                user: { _id: 'user123', email: 'test@example.com' }
            }
        };

        next = jest.fn();

        // AuditLog.log needs to return a promise
        AuditLog.log.mockResolvedValue({});
    });

    it('should be a function that returns middleware', () => {
        const middleware = auditLogger.auditLog('test_action');
        expect(typeof middleware).toBe('function');
    });

    describe('Middleware Execution', () => {
        it('should execute next()', async () => {
            const middleware = auditLogger.auditLog('test_action');
            await middleware(req, res, next);
            expect(next).toHaveBeenCalled();
        });

        it('should wrap res.json and call AuditLog.log', (done) => {
            const middleware = auditLogger.auditLog('test_action', 'info');
            middleware(req, res, next);

            // Trigger the response
            const responseData = { success: true };
            res.json(responseData);

            // Audit logging happens in setImmediate, so we use setImmediate to check after
            setImmediate(() => {
                try {
                    expect(originalJson).toHaveBeenCalledWith(responseData);
                    expect(AuditLog.log).toHaveBeenCalledTimes(1);
                    const logCall = AuditLog.log.mock.calls[0][0];
                    expect(logCall).toMatchObject({
                        action: 'test_action',
                        severity: 'info',
                        userId: 'user123',
                        username: 'test@example.com',
                        authSource: 'api-key',
                        status: 'success'
                    });
                    done();
                } catch (error) {
                    done(error);
                }
            });
        });

        it('should handle request body sanitization', (done) => {
            const middleware = auditLogger.auditLog('test_action', 'info', { includeBody: true });
            middleware(req, res, next);
            res.json({ success: true });

            setImmediate(() => {
                try {
                    expect(AuditLog.log).toHaveBeenCalled();
                    const logCall = AuditLog.log.mock.calls[0][0];
                    const body = logCall.details.requestBody;
                    
                    expect(body.name).toBe('Test');
                    expect(body.password).toBe('[REDACTED]');
                    expect(body.apiKey).toBe('[REDACTED]');
                    done();
                } catch (error) {
                    done(error);
                }
            });
        });

        it('should determine status based on statusCode', (done) => {
            const middleware = auditLogger.auditLog('test_action');
            res.statusCode = 500;
            middleware(req, res, next);
            res.json({ error: 'Internal Server Error' });

            setImmediate(() => {
                try {
                    expect(AuditLog.log).toHaveBeenCalled();
                    const logCall = AuditLog.log.mock.calls[0][0];
                    expect(logCall.status).toBe('failure');
                    done();
                } catch (error) {
                    done(error);
                }
            });
        });

        it('should extract resource details', (done) => {
            const middleware = auditLogger.auditLog('test_action', 'info', {
                resource: 'api_key',
                resourceId: 'custom-id'
            });
            middleware(req, res, next);
            res.json({});

            setImmediate(() => {
                try {
                    const logCall = AuditLog.log.mock.calls[0][0];
                    expect(logCall.resource).toBe('api_key');
                    expect(logCall.resourceId).toBe('custom-id');
                    done();
                } catch (error) {
                    done(error);
                }
            });
        });

        it('should use custom details extractor', (done) => {
            const middleware = auditLogger.auditLog('test_action', 'info', {
                customDetails: (req, res, data) => ({
                    customField: 'customValue',
                    respData: data.someValue
                })
            });
            middleware(req, res, next);
            res.json({ someValue: 123 });

            setImmediate(() => {
                try {
                    const logCall = AuditLog.log.mock.calls[0][0];
                    expect(logCall.details.customField).toBe('customValue');
                    expect(logCall.details.respData).toBe(123);
                    done();
                } catch (error) {
                    done(error);
                }
            });
        });

        it('should gracefully handle AuditLog errors', (done) => {
            AuditLog.log.mockRejectedValue(new Error('Database error'));
            const middleware = auditLogger.auditLog('test_action');
            middleware(req, res, next);
            
            // Should not throw
            expect(() => res.json({})).not.toThrow();

            setImmediate(() => {
                // Ensure error was logged to logger
                expect(logger.error).toHaveBeenCalledWith('Failed to create audit log', expect.anything());
                done();
            });
        });
    });

    describe('Pre-built Helpers', () => {
        it('auditApiKeyOps.created should include body and correct scopes', (done) => {
            const middleware = auditLogger.auditApiKeyOps.created;
            req.body = { scopes: ['chat:read'], expiresAt: '2026-01-01' };
            middleware(req, res, next);
            res.json({ data: { scopes: ['chat:read'], expiresAt: '2026-01-01' } }); // Mock response data structure

            setImmediate(() => {
                try {
                    const logCall = AuditLog.log.mock.calls[0][0];
                    expect(logCall.action).toBe('api_key_created');
                    expect(logCall.resource).toBe('api_key');
                    expect(logCall.details.scopes).toEqual(['chat:read']);
                    expect(logCall.details.requestBody).toBeDefined();
                    done();
                } catch (error) {
                    done(error);
                }
            });
        });

        it('auditApiKeyOps.revoked should log reason', (done) => {
            const middleware = auditLogger.auditApiKeyOps.revoked;
            req.body = { reason: 'Compromised' };
            middleware(req, res, next);
            res.json({});

            setImmediate(() => {
                try {
                    const logCall = AuditLog.log.mock.calls[0][0];
                    expect(logCall.action).toBe('api_key_revoked');
                    expect(logCall.details.reason).toBe('Compromised');
                    done();
                } catch (error) {
                    done(error);
                }
            });
        });
    });
});
