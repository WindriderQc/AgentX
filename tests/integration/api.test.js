const request = require('supertest');
const { app } = require('../../src/app');

// Mock mongoose models
// We define the mock functions here but they need to be accessed inside the factory or declared globally if using var
// However, jest.mock factory cannot access out-of-scope variables unless they are prefixed with 'mock' AND declared properly.
// The issue is initialization order. jest.mock is hoisted. const ... = jest.fn() is not hoisted.

// Move mock function definitions inside the mock factory or use a better pattern.
// Pattern: mock the module, then in the test get the mocked module and manipulate the mocks.

jest.mock('../../models/Conversation', () => {
  const mockFind = jest.fn();
  const mockFindById = jest.fn();
  const mockFindOne = jest.fn();
  const mockAggregate = jest.fn();
  const mockCountDocuments = jest.fn();

  // Make chainable
  const chainable = {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
  };

  mockFind.mockReturnValue(chainable);
  mockFindById.mockReturnValue(chainable);
  mockFindOne.mockReturnValue(chainable);

  return {
    find: mockFind,
    findById: mockFindById,
    findOne: mockFindOne,
    aggregate: mockAggregate,
    countDocuments: mockCountDocuments,
    create: jest.fn(),
    // Expose mocks for test assertion
    __mocks: {
      find: mockFind,
      findById: mockFindById,
      findOne: mockFindOne,
      aggregate: mockAggregate,
      countDocuments: mockCountDocuments
    }
  };
});

jest.mock('../../models/UserProfile', () => {
  const mockFindOne = jest.fn();
  const mockCreate = jest.fn();
  const mockFindOneAndUpdate = jest.fn();

  return {
    findOne: mockFindOne,
    create: mockCreate,
    findOneAndUpdate: mockFindOneAndUpdate,
    __mocks: {
      findOne: mockFindOne,
      create: mockCreate,
      findOneAndUpdate: mockFindOneAndUpdate
    }
  };
});

jest.mock('../../models/PromptConfig', () => {
  return {
    getActive: jest.fn(),
  };
});

const Conversation = require('../../models/Conversation');
const UserProfile = require('../../models/UserProfile');

describe('API Routes Integration', () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/history', () => {
    it('should return a list of conversations', async () => {
      // Mock data
      const mockConversations = [
        {
          _id: 'conv1',
          title: 'Test Conv 1',
          updatedAt: new Date(),
          model: 'llama2',
          messages: [{ content: 'Hello' }]
        }
      ];

      // Setup chainable mock
      // We need to access the mock function from the required module now
      const mockFind = Conversation.__mocks.find;

      const mockSelect = jest.fn().mockResolvedValue(mockConversations);
      const mockLimit = jest.fn().mockReturnValue({ select: mockSelect });
      const mockSort = jest.fn().mockReturnValue({ limit: mockLimit });
      mockFind.mockReturnValue({ sort: mockSort });

      const res = await request(app).get('/api/history');

      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe('conv1');
      expect(mockFind).toHaveBeenCalledWith({ userId: 'default' });
    });

    it('should handle errors gracefully', async () => {
      const mockFind = Conversation.__mocks.find;
      mockFind.mockImplementation(() => {
        throw new Error('Database error');
      });

      const res = await request(app).get('/api/history');

      expect(res.statusCode).toBe(500);
      expect(res.body.status).toBe('error');
    });
  });

  describe('GET /api/history/:id', () => {
    it('should return a single conversation', async () => {
      const mockConversation = {
        _id: 'conv1',
        title: 'Test Conv 1'
      };
      const mockFindById = Conversation.__mocks.findById;
      mockFindById.mockResolvedValue(mockConversation);

      const res = await request(app).get('/api/history/conv1');

      expect(res.statusCode).toBe(200);
      expect(res.body.data._id).toBe('conv1');
    });

    it('should return 404 if not found', async () => {
      const mockFindById = Conversation.__mocks.findById;
      mockFindById.mockResolvedValue(null);

      const res = await request(app).get('/api/history/conv1');

      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/profile', () => {
    it('should return user profile', async () => {
      const mockProfile = { userId: 'default', about: 'Test user' };
      const mockFindOne = UserProfile.__mocks.findOne;
      mockFindOne.mockResolvedValue(mockProfile);

      const res = await request(app).get('/api/profile');

      expect(res.statusCode).toBe(200);
      expect(res.body.data.about).toBe('Test user');
    });

    it('should create profile if not found', async () => {
      const mockFindOne = UserProfile.__mocks.findOne;
      const mockCreate = UserProfile.__mocks.create;

      mockFindOne.mockResolvedValue(null);
      mockCreate.mockResolvedValue({ userId: 'default', about: '' });

      const res = await request(app).get('/api/profile');

      expect(res.statusCode).toBe(200);
      expect(mockCreate).toHaveBeenCalled();
    });
  });
});
