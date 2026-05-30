import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  NOTIFICATION_CHANNEL: z.literal('email').default('email'),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_TO: z.string().optional(),
  TIMEZONE: z.string().default('Europe/Warsaw'),
  PKP_BASE_URL: z.string().url().default('https://ebilet.intercity.pl/'),
  INTERCITY_EMAIL: z.string().optional(),
  INTERCITY_PASSWORD: z.string().optional(),
  WATCHES_CONFIG_PATH: z.string().default('./config/watches.json'),
  CHECK_INTERVAL_MINUTES: z.coerce.number().int().min(2).default(5),
  MAX_PARALLEL_CHECKS: z.coerce.number().int().min(1).max(3).default(1),
  HEADLESS: z
    .string()
    .default('true')
    .transform((value) => value.toLowerCase() === 'true'),
  SAVE_SCREENSHOTS: z
    .string()
    .default('false')
    .transform((value) => value.toLowerCase() === 'true'),
  ADD_TO_CART: z
    .string()
    .default('true')
    .transform((value) => value.toLowerCase() === 'true'),
  SCREENSHOTS_DIR: z.string().default('./screenshots'),
});

export const env = envSchema.parse(process.env);
