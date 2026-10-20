/** Channel plugins' builtins (23 §6): email over SMTP, WhatsApp through the Cloud API. */
export {
  channelTools, smtpSettings, whatsAppSettings, EMAIL_SMTP_PLUGIN, WHATSAPP_CLOUD_PLUGIN, EMAIL_SMTP_BUILTIN, WHATSAPP_CLOUD_BUILTIN,
  DEFAULT_WHATSAPP_API_BASE, type ChannelToolsOptions,
} from './tools'
export { sendMail, buildMessage, dotStuff, messageIdFor, addressOf, SmtpError, type SmtpSettings, type SmtpMessage, type SmtpSecurity } from './smtp'
export { sendWhatsApp, messagePayload, phoneDigits, type WhatsAppSettings, type WhatsAppTemplate, type WhatsAppMessage } from './whatsapp'
export { memorySentStore, pgSentStore, type SentStore } from './sent'
