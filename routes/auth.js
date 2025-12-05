const express = require('express');
const router = express.Router();
const UserProfile = require('../models/UserProfile');
const logger = require('../config/logger');

/**
 * POST /api/auth/register
 * Register a new user
 */
router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    
    // Validation
    if (!email || !password) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Email and password are required' 
      });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Password must be at least 6 characters' 
      });
    }
    
    // Check if user exists
    const existingUser = await UserProfile.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ 
        status: 'error', 
        message: 'Email already registered' 
      });
    }
    
    // Create user
    const user = new UserProfile({
      email,
      password, // Will be hashed by pre-save hook
      name: name || email.split('@')[0],
      userId: email.split('@')[0], // Generate userId from email
      isAdmin: false
    });
    
    await user.save();
    
    // Create session
    req.session.userId = user._id.toString();
    
    logger.info(`New user registered: ${email}`);
    
    res.status(201).json({
      status: 'success',
      message: 'User registered successfully',
      user: {
        _id: user._id,
        email: user.email,
        name: user.name,
        userId: user.userId
      }
    });
  } catch (error) {
    logger.error('Registration error:', error);
    res.status(500).json({ 
      status: 'error', 
      message: 'Registration failed' 
    });
  }
});

/**
 * POST /api/auth/login
 * Authenticate user and create session
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Validation
    if (!email || !password) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Email and password are required' 
      });
    }
    
    // Find user
    const user = await UserProfile.findOne({ email });
    if (!user || !user.password) {
      return res.status(401).json({ 
        status: 'error', 
        message: 'Invalid email or password' 
      });
    }
    
    // Verify password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ 
        status: 'error', 
        message: 'Invalid email or password' 
      });
    }
    
    // Update last login
    user.lastLogin = new Date();
    await user.save();
    
    // Create session
    req.session.userId = user._id.toString();
    
    logger.info(`User logged in: ${email}`);
    
    res.json({
      status: 'success',
      message: 'Login successful',
      user: {
        _id: user._id,
        email: user.email,
        name: user.name,
        userId: user.userId,
        isAdmin: user.isAdmin
      }
    });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ 
      status: 'error', 
      message: 'Login failed' 
    });
  }
});

/**
 * POST /api/auth/logout
 * Destroy session
 */
router.post('/logout', (req, res) => {
  const userId = req.session?.userId;
  
  req.session.destroy((err) => {
    if (err) {
      logger.error('Logout error:', err);
      return res.status(500).json({ 
        status: 'error', 
        message: 'Logout failed' 
      });
    }
    
    res.clearCookie('agentx.sid');
    logger.info(`User logged out: ${userId}`);
    
    res.json({
      status: 'success',
      message: 'Logged out successfully'
    });
  });
});

/**
 * GET /api/auth/me
 * Get current user info
 */
router.get('/me', async (req, res) => {
  try {
    if (!req.session?.userId) {
      return res.status(401).json({ 
        status: 'error', 
        message: 'Not authenticated' 
      });
    }
    
    const user = await UserProfile.findById(req.session.userId);
    if (!user) {
      return res.status(404).json({ 
        status: 'error', 
        message: 'User not found' 
      });
    }
    
    res.json({
      status: 'success',
      user: {
        _id: user._id,
        email: user.email,
        name: user.name,
        userId: user.userId,
        isAdmin: user.isAdmin,
        preferences: user.preferences
      }
    });
  } catch (error) {
    logger.error('Get user error:', error);
    res.status(500).json({ 
      status: 'error', 
      message: 'Failed to get user info' 
    });
  }
});

module.exports = router;
