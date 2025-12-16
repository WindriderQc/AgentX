/**
 * Response Helper Functions
 * Utilities for standardized API responses
 */

/**
 * Send error response with consistent format
 * @param {Object} res - Express response object
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {Object} details - Optional error details
 */
function sendError(res, statusCode = 500, message = 'Internal server error', details = null) {
  const response = {
    status: 'error',
    message
  };
  
  if (details) {
    response.details = details;
  }
  
  res.status(statusCode).json(response);
}

/**
 * Send success response with consistent format
 * @param {Object} res - Express response object
 * @param {*} data - Response data
 * @param {Object} meta - Optional metadata
 */
function sendSuccess(res, data, meta = null) {
  const response = {
    status: 'success',
    data
  };
  
  if (meta) {
    response.meta = meta;
  }
  
  res.json(response);
}

module.exports = {
  sendError,
  sendSuccess
};
