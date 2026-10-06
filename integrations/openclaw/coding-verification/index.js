import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { register } from './registration.js';

export default definePluginEntry({
  id: 'agentx-coding-verification',
  name: 'AgentX Coding Verification',
  description: 'Task-bound file access and bounded sandbox verification for the coding worker.',
  register
});
