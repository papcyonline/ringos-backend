import twilio from 'twilio';
import { env } from '../config/env';
import { logger } from './logger';

// Initialize Twilio client if credentials are configured
const twilioClient =
  env.TWILIO_ACCOUNT_SID &&
  env.TWILIO_AUTH_TOKEN &&
  env.TWILIO_ACCOUNT_SID !== 'your_twilio_account_sid'
    ? twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN)
    : null;

const TWILIO_PHONE = env.TWILIO_PHONE_NUMBER;

interface SendSmsOptions {
  to: string;
  body: string;
}

export async function sendSms({ to, body }: SendSmsOptions): Promise<boolean> {
  // Skip sending if Twilio is not configured
  if (!twilioClient || !TWILIO_PHONE) {
    logger.info({ to, body }, 'SMS skipped (Twilio not configured)');
    return false;
  }

  try {
    const message = await twilioClient.messages.create({
      body,
      from: TWILIO_PHONE,
      to,
    });

    logger.info({ messageSid: message.sid, to }, 'SMS sent successfully');
    return true;
  } catch (error) {
    logger.error({ error, to }, 'Failed to send SMS');
    return false;
  }
}

export async function sendOtpSms(phone: string, code: string): Promise<boolean> {
  return sendSms({
    to: phone,
    body: `Your YoMeet verification code is: ${code}. It expires in 5 minutes. Don't share this code with anyone.`,
  });
}
