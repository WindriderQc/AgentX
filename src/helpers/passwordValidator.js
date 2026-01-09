/**
 * Password Validation Helper
 *
 * Enforces strong password requirements to prevent weak credentials
 *
 * Requirements:
 * - Minimum 12 characters
 * - At least one uppercase letter (A-Z)
 * - At least one lowercase letter (a-z)
 * - At least one number (0-9)
 *
 * @module helpers/passwordValidator
 */

const MIN_LENGTH = 12;

/**
 * Validate password strength
 *
 * @param {string} password - The password to validate
 * @returns {{valid: boolean, errors: string[]}} - Validation result with error messages
 */
function validatePassword(password) {
  const errors = [];

  if (!password || typeof password !== 'string') {
    return {
      valid: false,
      errors: ['Password is required']
    };
  }

  // Check minimum length
  if (password.length < MIN_LENGTH) {
    errors.push(`Password must be at least ${MIN_LENGTH} characters long`);
  }

  // Check for uppercase letter
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }

  // Check for lowercase letter
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }

  // Check for number
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validate password and return Express response if invalid
 *
 * @param {string} password - The password to validate
 * @param {object} res - Express response object
 * @returns {boolean} - True if valid, false if invalid (response already sent)
 */
function validatePasswordMiddleware(password, res) {
  const validation = validatePassword(password);

  if (!validation.valid) {
    res.status(400).json({
      status: 'error',
      message: 'Password does not meet security requirements',
      errors: validation.errors
    });
    return false;
  }

  return true;
}

module.exports = {
  validatePassword,
  validatePasswordMiddleware,
  MIN_LENGTH
};
