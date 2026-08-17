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
      `Your verification code is ${code}.\n\nEnter it on the sign-up screen to finish creating your account. Your account is not created until you do.\n\nThis code expires in ${expiresMinutes} minutes. If you did not try to create an account, you can ignore this email.`,
      layout(
        'Confirm your email',
        // THE CODE IS WRITTEN AS PART OF A SENTENCE, not displayed as a monument.
        //
        // It was 34px monospace with 10px letter-spacing, which is the treatment a marketing email
        // gives a discount code. Set at the size of the surrounding text it reads as information,
        // and the letters stay together so a double-click selects the whole code — wide tracking
        // breaks that in several clients, forcing the user to select it by hand.
        `<p style="margin:0 0 18px">Your verification code is
           <strong style="font-weight:600;color:#171320">${escapeHtml(code)}</strong>.</p>
         <p style="margin:0 0 18px">Enter it on the sign-up screen to finish creating your account.
           Your account is not created until you do.</p>
         <p style="margin:0;font-size:13px;color:#8b8598">This code expires in ${expiresMinutes} minutes.
           If you did not try to create an account, you can ignore this email.</p>`,
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


/**
 * Where the logo is fetched from. Overridable so a staging deployment does not hotlink production.
 *
 * An absolute HTTPS URL, not a CID attachment: inline attachments show as a paperclip in several
 * webmail clients and are stripped outright by others, and a relative path has no meaning in an
 * inbox.
 */
const ASSET_BASE = (process.env.MAIL_ASSET_BASE ?? 'https://lobrowser.com').replace(/\/+$/, '');

/**
 * Content font stack.
 *
 * Inter first, as asked. Most clients ignore webfonts entirely and will fall through to the system
 * stack, which is why the fallbacks are ordered to look like Inter rather than merely to exist:
 * Segoe UI on Windows and -apple-system on macOS/iOS are the closest widely-installed neighbours.
 * The `@import` below serves the clients that DO honour it (Apple Mail, some desktop clients); it
 * is harmless where it is stripped.
 */
const FONT_STACK = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * Table-based layout with inline styles — the only thing mail clients render consistently.
 *
 * WHITE, AND SQUARE. The previous version floated a rounded card on a tinted page. In an inbox that
 * reads as a decorated marketing mail rather than a transactional one, and the tint fights every
 * client that composites its own background behind the message. Flat white edge to edge with square
 * corners is what a receipt or a security notice looks like, and it renders identically everywhere
 * — including Outlook, whose renderer ignores `border-radius` and would have squared the corners
 * for a chunk of the audience regardless, giving two different-looking emails.
 */
function layout(heading: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');</style>
</head>
<body style="margin:0;padding:0;background:#ffffff">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background:#ffffff">
  <tr><td align="center" style="padding:40px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;border-collapse:collapse;background:#ffffff">
      <tr><td style="padding:0 0 28px">
        <img src="${ASSET_BASE}/brand/email-logo.png" width="150" height="30" alt="Lobster Browser"
             style="display:block;border:0;outline:none;text-decoration:none;height:auto;width:150px">
      </td></tr>
      <tr><td style="font-family:${FONT_STACK};color:#171320">
        <h1 style="margin:0 0 18px;font-size:21px;font-weight:600;line-height:1.3">${escapeHtml(heading)}</h1>
        <div style="font-size:15px;line-height:1.65;color:#3f3a4d">${body}</div>
      </td></tr>
      <tr><td style="padding:32px 0 0">
        <div style="border-top:1px solid #e8e5f0;padding-top:16px;font-family:${FONT_STACK};font-size:12px;line-height:1.6;color:#8b8598">
          Sent by Lobster Browser. Please do not reply to this address.
        </div>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;
}

/** `a***@example.com` — enough to correlate a suppressed send, not enough to harvest addresses. */
function redactAddress(address: string): string {
  const at = address.indexOf('@');
  if (at <= 0) return '***';
  return `${address[0]}***${address.slice(at)}`;
}
