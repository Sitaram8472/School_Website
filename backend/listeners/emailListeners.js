const { eventBus, EVENTS } = require('../core/events');
const sendEmail = require('../utils/sendEmail');

eventBus.on(EVENTS.USER_REGISTERED, async ({ user, verifyUrl }) => {
  try {
    await sendEmail({
      to: user.email,
      subject: "EduStream Academy - Verify Your Email",
      html: `
        <p>Hi ${user.name},</p>
        <p>Thank you for registering. Please verify your email using the link below (valid for 24 hours):</p>
        <p><a href="${verifyUrl}">${verifyUrl}</a></p>
        <br/>
        <p>- EduStream Academy</p>
      `,
    });
  } catch (emailError) {
    console.error("Verification email error:", emailError.message);
    console.log(`[DEV] Verification link for ${user.email}: ${verifyUrl}`);
  }
});

eventBus.on(EVENTS.PASSWORD_RESET_REQUESTED, async ({ user, resetUrl }) => {
  try {
    await sendEmail({
      to: user.email,
      subject: "EduStream Academy - Password Reset Request",
      html: `
        <p>Hi ${user.name},</p>
        <p>We received a request to reset your password. Click the link below. It expires in <strong>1 hour</strong>.</p>
        <p><a href="${resetUrl}">${resetUrl}</a></p>
        <p>If you did not request this, you can safely ignore this email.</p>
        <br/>
        <p>- EduStream Academy</p>
      `,
    });
  } catch (emailError) {
    console.log(`[DEV] Password reset link for ${user.email}: ${resetUrl}`);
  }
});

eventBus.on(EVENTS.VERIFICATION_RESENT, async ({ user, verifyUrl }) => {
  try {
    await sendEmail({
      to: user.email,
      subject: "EduStream Academy - Verify Your Email",
      html: `
        <p>Hi ${user.name},</p>
        <p>Here is your new verification link (valid for 24 hours):</p>
        <p><a href="${verifyUrl}">${verifyUrl}</a></p>
        <br/>
        <p>- EduStream Academy</p>
      `,
    });
  } catch (emailError) {
    console.error("Resend verification email error:", emailError.message);
  }
});
