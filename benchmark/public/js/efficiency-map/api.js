// public/js/efficiency-map/api.js
import { apiFetch } from '../utils/api.js';

export const fetchEfficiencyMap = () => apiFetch('/benchmark/api/benchmark/efficiency-map');
