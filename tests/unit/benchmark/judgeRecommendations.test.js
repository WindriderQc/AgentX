const { buildJudgeHostRecommendations } = require('../../../src/services/benchmark/judgeRecommendations');

describe('buildJudgeHostRecommendations', () => {
  it('picks host-appropriate judge defaults from available calibrated models', () => {
    const hosts = [
      { id: 'primary', name: 'UGFrank', url: 'http://192.168.2.99:11434', vramMb: 12288 },
      { id: 'secondary', name: 'UGBrutal', url: 'http://192.168.2.12:11434', vramMb: 16303 },
      { id: 'tertiary', name: 'UGClawdX', url: 'http://192.168.2.66:11434', vramMb: 24576 }
    ];

    const registryEntries = [
      {
        modelName: 'qwen2.5:7b-instruct-q5_K_M',
        categories: ['judge'],
        parameterSize: '7B',
        quantization: 'Q5_K_M',
        capabilities: {
          judgeTier: 'standard',
          judgeReliability: 1
        }
      },
      {
        modelName: 'qwen2.5:14b-instruct-q5_K_M',
        categories: ['judge'],
        parameterSize: '14B',
        quantization: 'Q5_K_M',
        capabilities: {
          judgeTier: 'advanced',
          judgeReliability: 0.92
        }
      },
      {
        modelName: 'qwen2.5:14b-instruct-q4_K_M',
        categories: ['judge'],
        parameterSize: '14B',
        quantization: 'Q4_K_M',
        capabilities: {
          judgeTier: 'advanced',
          judgeReliability: 0.6
        }
      },
      {
        modelName: 'qwen3:30b-a3b',
        categories: ['generalist'],
        parameterSize: '30B',
        quantization: 'Q4_K_M',
        capabilities: {
          judgeTier: 'advanced'
        }
      }
    ];

    const hostInventoryByUrl = {
      'http://192.168.2.99:11434': {
        available: true,
        models: [
          'qwen2.5:7b-instruct-q5_K_M',
          'deepseek-r1:14b'
        ]
      },
      'http://192.168.2.12:11434': {
        available: true,
        models: [
          'qwen2.5:14b-instruct-q5_K_M',
          'qwen2.5:7b-instruct-q5_K_M',
          'qwen3:14b'
        ]
      },
      'http://192.168.2.66:11434': {
        available: true,
        models: [
          'qwen2.5:14b-instruct-q4_K_M',
          'qwen3:30b-a3b',
          'mistral-small3.2:24b'
        ]
      }
    };

    const recommendations = buildJudgeHostRecommendations({
      hosts,
      registryEntries,
      hostInventoryByUrl,
      judgeDefaults: {
        'http://192.168.2.99:11434': 'qwen2.5:7b-instruct-q5_K_M',
        'http://192.168.2.12:11434': 'qwen2.5:14b-instruct-q5_K_M',
        'http://192.168.2.66:11434': 'qwen2.5:14b-instruct-q4_K_M'
      }
    });

    expect(recommendations['http://192.168.2.99:11434'].recommended.model).toBe('qwen2.5:7b-instruct-q5_K_M');
    expect(recommendations['http://192.168.2.99:11434'].recommended.num_ctx).toBe(8192);

    expect(recommendations['http://192.168.2.12:11434'].recommended.model).toBe('qwen2.5:14b-instruct-q5_K_M');
    expect(recommendations['http://192.168.2.12:11434'].recommended.num_ctx).toBe(4096);

    expect(recommendations['http://192.168.2.66:11434'].recommended.model).toBe('qwen2.5:14b-instruct-q4_K_M');
    expect(recommendations['http://192.168.2.66:11434'].recommended.num_ctx).toBe(8192);
    expect(recommendations['http://192.168.2.66:11434'].recommended.differsFromConfiguredDefault).toBe(false);
  });

  it('falls back to heuristic judge selection when no judge-tagged registry entry exists', () => {
    const recommendations = buildJudgeHostRecommendations({
      hosts: [
        { id: 'primary', name: 'UGFrank', url: 'http://127.0.0.1:11434', vramMb: 12288 }
      ],
      registryEntries: [],
      hostInventoryByUrl: {
        'http://127.0.0.1:11434': {
          available: true,
          models: ['llama3:8b-instruct-q4_K_M', 'qwen3-coder:30b']
        }
      }
    });

    expect(recommendations['http://127.0.0.1:11434'].recommended.model).toBe('llama3:8b-instruct-q4_K_M');
    expect(recommendations['http://127.0.0.1:11434'].recommended.num_ctx).toBeGreaterThanOrEqual(8192);
  });
});
