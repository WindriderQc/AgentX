/**
 * Model Router Tests
 * Tests for multi-model routing functionality
 */

const {
    getTargetForModel,
    getModelForTask,
    routeRequest,
    HOSTS,
    MODEL_ROUTING,
    TASK_MODELS
} = require('../../src/services/modelRouter');

describe('Model Router Service', () => {
    describe('getTargetForModel', () => {
        it('should return primary host for Qwen 7B', () => {
            const target = getTargetForModel('qwen2.5:7b-instruct-q4_0');
            expect(target).toBe(HOSTS.primary);
        });

        it('should return secondary host for DeepSeek', () => {
            const target = getTargetForModel('deepseek-r1:8b');
            expect(target).toBe(HOSTS.secondary);
        });

        it('should return primary for undefined model', () => {
            const target = getTargetForModel(undefined);
            expect(target).toBe(HOSTS.primary);
        });

        it('should return primary for null model', () => {
            const target = getTargetForModel(null);
            expect(target).toBe(HOSTS.primary);
        });

        it('should fallback to secondary for 70b models', () => {
            const target = getTargetForModel('some-model:70b');
            expect(target).toBe(HOSTS.secondary);
        });

        it('should fallback to secondary for 32b models', () => {
            const target = getTargetForModel('custom:32b');
            expect(target).toBe(HOSTS.secondary);
        });
    });

    describe('getModelForTask', () => {
        it('should return Qwen for quick_chat', () => {
            const result = getModelForTask('quick_chat');
            expect(result.model).toContain('qwen');
            expect(result.host).toBe('primary');
        });

        it('should return coder model for code_generation', () => {
            const result = getModelForTask('code_generation');
            expect(result.model).toContain('coder');
            expect(result.host).toBe('secondary');
        });

        it('should return DeepSeek for deep_reasoning', () => {
            const result = getModelForTask('deep_reasoning');
            expect(result.model).toContain('deepseek');
            expect(result.host).toBe('secondary');
        });

        it('should fallback to general_chat for unknown task', () => {
            const result = getModelForTask('unknown_task');
            expect(result.model).toContain('qwen');
            expect(result.host).toBe('primary');
        });
    });

    describe('routeRequest', () => {
        it('should use preferred model when specified', async () => {
            const result = await routeRequest('Hello', {
                preferredModel: 'deepseek-r1:8b'
            });
            expect(result.model).toBe('deepseek-r1:8b');
            expect(result.routed).toBe(false);
        });

        it('should route based on taskType', async () => {
            const result = await routeRequest('Write code', {
                taskType: 'code_generation'
            });
            expect(result.model).toContain('coder');
            expect(result.routed).toBe(true);
            expect(result.taskType).toBe('code_generation');
        });

        it('should return default when no routing options', async () => {
            const result = await routeRequest('Hello', {});
            expect(result.model).toContain('qwen');
            expect(result.routed).toBe(false);
            expect(result.taskType).toBe('default');
        });
    });

    describe('Configuration', () => {
        it('should have valid host URLs', () => {
            expect(HOSTS.primary).toMatch(/^http:\/\//);
            expect(HOSTS.secondary).toMatch(/^http:\/\//);
        });

        it('should have all task types mapped', () => {
            const taskTypes = ['quick_chat', 'general_chat', 'code_generation', 
                              'code_review', 'deep_reasoning', 'analysis', 
                              'summarization', 'translation', 'embeddings'];
            taskTypes.forEach(task => {
                expect(TASK_MODELS[task]).toBeDefined();
                expect(TASK_MODELS[task].model).toBeDefined();
                expect(TASK_MODELS[task].host).toBeDefined();
            });
        });
    });
});
