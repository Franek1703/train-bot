import { Resend } from 'resend';
import { env } from '../config/env.js';
import {
  buildSeatAvailableBody,
  buildSeatAvailableSubject,
} from './emailFormatter.js';
import type {
  NotificationSendResult,
  Notifier,
  SeatAvailableNotificationInput,
} from './types.js';

export class EmailNotifier implements Notifier {
  private readonly resend: Resend;

  constructor(
    private readonly options = {
      apiKey: env.RESEND_API_KEY,
      from: env.EMAIL_FROM,
      to: env.EMAIL_TO,
      timezone: env.TIMEZONE,
    },
  ) {
    if (!options.apiKey) {
      throw new Error('RESEND_API_KEY is required for email notifications');
    }

    this.resend = new Resend(options.apiKey);
  }

  async sendSeatAvailable(
    input: SeatAvailableNotificationInput,
  ): Promise<NotificationSendResult> {
    const emailOptions = this.requiredEmailOptions();

    const subject = buildSeatAvailableSubject(input);
    const text = buildSeatAvailableBody(input, emailOptions.timezone);

    try {
      await this.resend.emails.send({
        from: emailOptions.from,
        to: emailOptions.to,
        subject,
        text,
      });

      return {
        status: 'sent',
        target: emailOptions.to,
        message: text,
      };
    } catch (error) {
      return {
        status: 'failed',
        target: emailOptions.to,
        message: text,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async sendTest(): Promise<NotificationSendResult> {
    const emailOptions = this.requiredEmailOptions();

    const text = `Intercity Monitor test email sent at ${new Date().toISOString()}.`;

    try {
      await this.resend.emails.send({
        from: emailOptions.from,
        to: emailOptions.to,
        subject: 'Intercity Monitor test email',
        text,
      });

      return {
        status: 'sent',
        target: emailOptions.to,
        message: text,
      };
    } catch (error) {
      return {
        status: 'failed',
        target: emailOptions.to,
        message: text,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private requiredEmailOptions(): { from: string; to: string; timezone: string } {
    if (!this.options.from) {
      throw new Error('EMAIL_FROM is required for email notifications');
    }

    if (!this.options.to) {
      throw new Error('EMAIL_TO is required for email notifications');
    }

    return {
      from: this.options.from,
      to: this.options.to,
      timezone: this.options.timezone,
    };
  }
}
