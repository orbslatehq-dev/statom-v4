/**
 * Groq AI Configuration for Statom V4 Solar Advisor
 *
 * SECURITY NOTE:
 * - Never log GROQ_API_KEY to console or include it in error messages.
 * - Only transmit GROQ_API_KEY in the Authorization header to GROQ_CHAT_ENDPOINT.
 * - The key is read from Vite env var VITE_GROQ_API_KEY. See .env.example
 */

export const GROQ_API_KEY =
  (import.meta.env.VITE_GROQ_API_KEY as string | undefined)?.trim() ?? '';

export const GROQ_CHAT_ENDPOINT =
  'https://api.groq.com/openai/v1/chat/completions';

export const GROQ_DEFAULT_MODEL = 'openai/gpt-oss-20b' as const;
export const GROQ_FALLBACK_MODEL = 'openai/gpt-oss-120b' as const;
