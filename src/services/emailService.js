/**
 * Email Service
 *
 * Handles email delivery for invitations, notifications, and alerts
 * Uses nodemailer with SMTP or sendmail transport
 */

const nodemailer = require('nodemailer');
const logger = require('../../config/logger');

class EmailService {
  constructor() {
    this.transporter = null;
    this.enabled = false;
    this.initialize();
  }

  initialize() {
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = parseInt(process.env.SMTP_PORT || '587');
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const emailFrom = process.env.EMAIL_FROM || 'AgentX <noreply@agentx.local>';

    // Check if SMTP is configured
    if (!smtpHost || !smtpUser || !smtpPass) {
      logger.warn('Email service not configured (missing SMTP credentials)');
      this.enabled = false;
      return;
    }

    try {
      this.transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465, // true for 465, false for other ports
        auth: {
          user: smtpUser,
          pass: smtpPass
        }
      });

      this.from = emailFrom;
      this.enabled = true;

      logger.info('Email service initialized', {
        host: smtpHost,
        port: smtpPort,
        from: emailFrom
      });

      // Verify connection
      this.transporter.verify((error) => {
        if (error) {
          logger.error('Email service verification failed', { error: error.message });
          this.enabled = false;
        } else {
          logger.info('Email service ready');
        }
      });

    } catch (error) {
      logger.error('Email service initialization failed', { error: error.message });
      this.enabled = false;
    }
  }

  /**
   * Send workspace invitation email
   */
  async sendInvitation(invitation) {
    if (!this.enabled) {
      logger.warn('Email service disabled, skipping invitation email', {
        email: invitation.email
      });
      return { sent: false, reason: 'Email service not configured' };
    }

    const workspace = invitation.workspaceId;
    const inviter = invitation.invitedBy;

    const acceptUrl = `${process.env.BASE_URL || 'http://localhost:3080'}/invite/accept?token=${invitation.token}`;

    const subject = `You've been invited to join ${workspace.name} on AgentX`;
    const html = this._renderInvitationTemplate({
      workspaceName: workspace.name,
      inviterName: inviter.username || inviter.email || 'A team member',
      role: invitation.role,
      acceptUrl,
      expiresAt: invitation.expiresAt,
      personalMessage: invitation.metadata?.personalMessage
    });

    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        to: invitation.email,
        subject,
        html
      });

      logger.info('Invitation email sent', {
        email: invitation.email,
        messageId: info.messageId,
        workspaceId: workspace._id
      });

      return { sent: true, messageId: info.messageId };

    } catch (error) {
      logger.error('Failed to send invitation email', {
        email: invitation.email,
        error: error.message
      });

      return { sent: false, error: error.message };
    }
  }

  /**
   * Send invitation accepted notification to inviter
   */
  async sendAcceptedNotification(invitation, acceptedUser) {
    if (!this.enabled) {
      return { sent: false, reason: 'Email service not configured' };
    }

    const inviter = invitation.invitedBy;
    const workspace = invitation.workspaceId;

    const subject = `${acceptedUser.username || invitation.email} accepted your invitation`;
    const html = `
      <h2>Invitation Accepted</h2>
      <p>${acceptedUser.username || invitation.email} has accepted your invitation to join <strong>${workspace.name}</strong>.</p>
      <p>They now have <strong>${invitation.role}</strong> access to the workspace.</p>
      <p><a href="${process.env.BASE_URL || 'http://localhost:3080'}/workspace-settings?workspace=${workspace._id}">View Workspace Settings</a></p>
    `;

    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        to: inviter.email,
        subject,
        html
      });

      logger.info('Acceptance notification sent', {
        email: inviter.email,
        messageId: info.messageId
      });

      return { sent: true, messageId: info.messageId };

    } catch (error) {
      logger.error('Failed to send acceptance notification', {
        email: inviter.email,
        error: error.message
      });

      return { sent: false, error: error.message };
    }
  }

  /**
   * Render invitation email template
   */
  _renderInvitationTemplate({ workspaceName, inviterName, role, acceptUrl, expiresAt, personalMessage }) {
    const expiryDate = new Date(expiresAt).toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
    .content { background: white; padding: 30px; border: 1px solid #e0e0e0; border-top: none; }
    .button { display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
    .button:hover { background: #5568d3; }
    .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
    .role-badge { display: inline-block; padding: 4px 12px; background: #f0f0f0; border-radius: 4px; font-weight: bold; }
    .personal-message { background: #f9f9f9; padding: 15px; border-left: 4px solid #667eea; margin: 15px 0; font-style: italic; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🚀 You're Invited to Join AgentX</h1>
    </div>

    <div class="content">
      <p><strong>${inviterName}</strong> has invited you to join the <strong>${workspaceName}</strong> workspace on AgentX.</p>

      ${personalMessage ? `<div class="personal-message">${personalMessage}</div>` : ''}

      <p>You've been invited with <span class="role-badge">${role.toUpperCase()}</span> access.</p>

      <p>Click the button below to accept the invitation:</p>

      <p style="text-align: center;">
        <a href="${acceptUrl}" class="button">Accept Invitation</a>
      </p>

      <p style="font-size: 14px; color: #666;">
        Or copy and paste this link into your browser:<br>
        <code style="background: #f5f5f5; padding: 5px; display: inline-block; margin-top: 5px;">${acceptUrl}</code>
      </p>

      <hr style="margin: 30px 0; border: none; border-top: 1px solid #e0e0e0;">

      <p style="font-size: 13px; color: #666;">
        <strong>Note:</strong> This invitation will expire on <strong>${expiryDate}</strong>.
      </p>

      <p style="font-size: 13px; color: #666;">
        If you didn't expect this invitation, you can safely ignore this email.
      </p>
    </div>

    <div class="footer">
      <p>AgentX - Intelligent AI Assistant Platform</p>
      <p>This is an automated message. Please do not reply to this email.</p>
    </div>
  </div>
</body>
</html>
    `;
  }
}

// Singleton instance
let emailService = null;

function getEmailService() {
  if (!emailService) {
    emailService = new EmailService();
  }
  return emailService;
}

module.exports = { getEmailService, EmailService };
