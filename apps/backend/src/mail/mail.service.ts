import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

/**
 * Outbound transactional mail.
 *
 * FAILS SOFT BY DESIGN. Sending is always best-effort: a dead SMTP host must not roll back a
 * payment we already credited or a registration we already committed. Every caller gets a boolean
 * and no exception, and an unconfigured host disables sending rather than throwing on boot — so a
 * developer without mail credentials still gets a working API.
 *
 * The consequence is that "the email did not arrive" is never a reason to distrust the database.
 * Verification links can be re-requested; receipts describe a fact that is already recorded.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly from: string;
  private readonly transporter: Transporter | null;

  constructor(config: ConfigService) {
    const host = config.get<string>('SMTP_HOST') ?? '';
    const port = Number(config.get<string>('SMTP_PORT') ?? 587);
    const user = config.get<string>('SMTP_USER') ?? '';
    const pass = config.get<string>('SMTP_PASSWORD') ?? '';
    this.from = config.get<string>('MAIL_FROM') ?? 'Lobster Browser <no-reply@lobrowser.com>';

    if (!host || !user || !pass) {
      this.logger.warn('SMTP is not configured — outbound mail is disabled');
      this.transporter = null;
      return;
    }

    this.transporter = createTransport({
      host,
      port,
      // 465 is implicit TLS; 587 upgrades via STARTTLS. Getting this backwards is the usual cause
      // of a transport that hangs rather than failing.
      secure: port === 465,
      requireTLS: port !== 465,
      auth: { user, pass },
    });
  }

  isConfigured(): boolean {
    return this.transporter !== null;
  }

  /** Send one message. Returns whether it was accepted; never throws. */
  async send(to: string, subject: string, text: string, html: string): Promise<boolean> {
    if (!this.transporter) {
      // The subject is NOT logged: verification subjects carry the live 6-digit code, and a
      // secret that reaches a log file has left the channel it was supposed to stay in.
      this.logger.warn(`mail suppressed (SMTP unconfigured) for ${redactAddress(to)}`);
      return false;
    }
    try {
      await this.transporter.sendMail({ from: this.from, to, subject, text, html });
      return true;
    } catch (err) {
      // The recipient is logged; the body is not. Verification links and receipts are exactly the
      // things that must not end up in a log file.
      this.logger.error(`failed to send "${subject}" to ${to}: ${(err as Error).message}`);
      return false;
    }
  }

  async sendVerification(to: string, code: string, expiresMinutes: number): Promise<boolean> {
    return this.send(
      to,
      `${code} is your Lobster Browser verification code`,
      `Your verification code is ${code}\n\nEnter it in the app to finish setting up your account. It expires in ${expiresMinutes} minutes. If you did not create an account, ignore this email.`,
      layout(
        'Confirm your email',
        `<p style="margin:0 0 20px">Enter this code to finish setting up your Lobster Browser account.</p>
         <p style="margin:0 0 8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:34px;letter-spacing:10px;font-weight:600;color:#171320">${escapeHtml(code)}</p>
         <p style="margin:24px 0 0;font-size:13px;color:#736c85">This code expires in ${expiresMinutes} minutes. If you did not create an account, you can ignore this email.</p>`,
      ),
    );
  }

  /** Receipt for a settled deposit. Sent only after the Credit is actually recorded. */
  async sendDepositReceipt(to: string, amount: string, balance: string, asset: string): Promise<boolean> {
    return this.send(
      to,
      `Payment received — ${amount} added to your Credit`,
      `Your ${asset} payment is confirmed.\n\nAdded to Credit: ${amount}\nNew balance: ${balance}\n\nThis is a receipt for a payment that has already been credited to your account.`,
      layout(
        'Payment received',
        `<p style="margin:0 0 20px">Your ${escapeHtml(asset)} payment is confirmed and your Credit has been topped up.</p>
         <table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 8px">
           <tr><td style="padding:10px 0;color:#736c85;font-size:14px">Added to Credit</td>
               <td style="padding:10px 0;text-align:right;font-size:18px;color:#171320">${escapeHtml(amount)}</td></tr>
           <tr><td style="padding:10px 0;border-top:1px solid #ece9f5;color:#736c85;font-size:14px">New balance</td>
               <td style="padding:10px 0;border-top:1px solid #ece9f5;text-align:right;font-size:14px;color:#171320">${escapeHtml(balance)}</td></tr>
         </table>`,
      ),
    );
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}


/** Table-based layout with inline styles — the only thing mail clients render consistently. */
function layout(heading: string, body: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#faf9ff">
<table role="presentation" style="width:100%;border-collapse:collapse;background:#faf9ff">
  <tr><td align="center" style="padding:32px 16px">
    <table role="presentation" style="width:100%;max-width:520px;border-collapse:collapse;background:#fff;border:1px solid #ece9f5;border-radius:16px">
      <tr><td style="padding:32px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#171320">
        <p style="margin:0 0 6px;font-size:14px;color:#7c3aed">Lobster Browser</p>
        <h1 style="margin:0 0 20px;font-size:22px;font-weight:500">${escapeHtml(heading)}</h1>
        <div style="font-size:15px;line-height:1.6;color:#423c52">${body}</div>
      </td></tr>
    </table>
    <p style="margin:16px 0 0;font-size:12px;color:#9a94a8;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
      Sent by Lobster Browser. Please do not reply to this address.</p>
  </td></tr>
</table></body></html>`;
}

/** `a***@example.com` — enough to correlate a suppressed send, not enough to harvest addresses. */
function redactAddress(address: string): string {
  const at = address.indexOf('@');
  if (at <= 0) return '***';
  return `${address[0]}***${address.slice(at)}`;
}
