/**
 * @file Central export file for all utility modules.
 * This file acts as a "barrel," gathering all utility functions and
 * exporting them as organized, namespaced objects for convenient access.
 */

import * as GeneralUtils from './general-utils.js';
import * as DOMUtils from './dom-utils.js';
import * as APIUtils from './api-utils.js';
import * as GeoUtils from './geo-utils.js';
import * as P5Helpers from './p5-helpers.js';

export const General = GeneralUtils;
export const DOM = DOMUtils;
export const API = APIUtils;
export const GEO = GeoUtils;
export const P5 = P5Helpers;

// Export commonly used functions directly for convenience
export const { formatFileSize, formatDate, formatNumber } = GeneralUtils;