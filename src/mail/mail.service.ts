import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  private readonly brevoApiKey: string | null;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>('SMTP_HOST') ?? 'smtp-relay.brevo.com';
    const port = Number(this.config.get<string>('SMTP_PORT') ?? 587);
    const user = this.config.get<string>('SMTP_USER')?.trim();
    const pass = this.config.get<string>('SMTP_PASS')?.trim();
    const apiKey = this.config.get<string>('BREVO_API_KEY')?.trim();

    this.from = this.config.get<string>('SMTP_FROM') ?? 'LockPro <cauakt@gmail.com>';
    this.brevoApiKey = apiKey || null;

    if (user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
    } else {
      this.transporter = null;
      if (!this.brevoApiKey) {
        this.logger.warn(
          'BREVO_API_KEY e SMTP_USER/SMTP_PASS vazios: e-mails serão apenas simulados em log local.',
        );
      }
    }
  }

  private parseSender(): { name?: string; email: string } {
    const match = /^(.*?)<([^>]+)>$/.exec(this.from.trim());
    if (match) {
      const name = match[1].trim().replace(/^"|"$/g, '');
      const email = match[2].trim();
      return name ? { name, email } : { email };
    }
    return { email: this.from.trim() };
  }

  async sendVerificationEmail(to: string, verifyUrl: string): Promise<void> {
    const subject = 'LockPro — Confirme seu e-mail';
    const text = `Confirme sua conta no LockPro acessando o link abaixo (válido por 24 horas):\n\n${verifyUrl}`;
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#0a0d0c;color:#f4efe6;border-radius:12px;border:1px solid #262626">
        <h2 style="margin:0 0 12px;color:#f59e0b">Confirme seu e-mail no LockPro</h2>
        <p style="margin:0 0 20px;color:#d4d4d4;font-size:14px">Clique no botão abaixo para ativar sua conta. O link expira em 24 horas.</p>
        <a href="${verifyUrl}" style="display:inline-block;padding:12px 20px;background:#f59e0b;color:#000;font-weight:bold;text-decoration:none;border-radius:8px">Confirmar e-mail</a>
        <p style="margin:20px 0 0;color:#737373;font-size:12px;word-break:break-all">${verifyUrl}</p>
      </div>
    `;

    await this.send(to, subject, text, html, verifyUrl);
  }

  async sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
    const subject = 'LockPro — Redefinição de senha';
    const text = `Recebemos um pedido para redefinir sua senha no LockPro. Acesse o link abaixo (válido por 1 hora):\n\n${resetUrl}\n\nSe não foi você, ignore este e-mail.`;
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#0a0d0c;color:#f4efe6;border-radius:12px;border:1px solid #262626">
        <h2 style="margin:0 0 12px;color:#f59e0b">Redefinir senha no LockPro</h2>
        <p style="margin:0 0 20px;color:#d4d4d4;font-size:14px">Clique no botão abaixo para escolher uma nova senha. O link expira em 1 hora.</p>
        <a href="${resetUrl}" style="display:inline-block;padding:12px 20px;background:#f59e0b;color:#000;font-weight:bold;text-decoration:none;border-radius:8px">Redefinir senha</a>
        <p style="margin:20px 0 0;color:#737373;font-size:12px">Se você não solicitou essa alteração, ignore este e-mail.</p>
      </div>
    `;

    await this.send(to, subject, text, html, resetUrl);
  }

  async sendEmailChangeCode(to: string, code: string): Promise<void> {
    const subject = 'LockPro — Código para trocar seu e-mail';
    const text = `Seu código de confirmação do LockPro é ${code}. Ele vale por 15 minutos.\n\nSe você não pediu a troca de e-mail, ignore esta mensagem.`;
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#0a0d0c;color:#f4efe6;border-radius:12px;border:1px solid #262626">
        <h2 style="margin:0 0 12px;color:#f59e0b">Confirme seu novo e-mail</h2>
        <p style="margin:0 0 16px;color:#d4d4d4;font-size:14px">Use o código abaixo no LockPro. Ele expira em 15 minutos.</p>
        <p style="margin:0 0 20px;font-size:32px;font-weight:bold;letter-spacing:8px;color:#f59e0b">${code}</p>
        <p style="margin:0;color:#737373;font-size:12px">Se você não pediu essa alteração, ignore este e-mail.</p>
      </div>
    `;

    await this.send(to, subject, text, html, code);
  }

  async sendEmailChangedNotice(to: string, newEmail: string): Promise<void> {
    const subject = 'LockPro — Seu e-mail foi alterado';
    const text = `O e-mail da sua conta no LockPro foi alterado para ${newEmail}. Se não foi você, redefina sua senha imediatamente.`;
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#0a0d0c;color:#f4efe6;border-radius:12px;border:1px solid #262626">
        <h2 style="margin:0 0 12px;color:#f59e0b">E-mail da conta alterado</h2>
        <p style="margin:0;color:#d4d4d4;font-size:14px">O e-mail da sua conta no LockPro foi alterado para <b>${newEmail}</b>. Se não foi você, redefina sua senha imediatamente.</p>
      </div>
    `;

    await this.send(to, subject, text, html, newEmail);
  }

  private async sendViaBrevoHttp(
    to: string,
    subject: string,
    text: string,
    html: string,
  ): Promise<void> {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': this.brevoApiKey!,
      },
      body: JSON.stringify({
        sender: this.parseSender(),
        to: [{ email: to }],
        subject,
        textContent: text,
        htmlContent: html,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Brevo HTTP ${res.status}: ${detail}`);
    }
  }

  private async send(
    to: string,
    subject: string,
    text: string,
    html: string,
    devUrl: string,
  ): Promise<void> {
    if (this.brevoApiKey) {
      await this.sendViaBrevoHttp(to, subject, text, html);
      return;
    }

    if (this.transporter) {
      await this.transporter.sendMail({
        from: this.from,
        to,
        subject,
        text,
        html,
      });
      return;
    }

    if (this.config.get<string>('NODE_ENV') !== 'production') {
      this.logger.log(`[DEV MAIL] para=${to} | assunto="${subject}" | url=${devUrl}`);
    }
  }
}