import { z } from 'zod';

const timeSchema = z.string().regex(/^\d{2}:\d{2}$/, 'Expected HH:mm time');

export const watchInputSchema = z.object({
  configKey: z.string().min(1).optional(),
  searchUrl: z.string().url(),
  origin: z.string().min(1),
  destination: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD date'),
  trainNumber: z.string().min(1).optional(),
  departureTime: timeSchema.optional(),
  travelClass: z.number().int().refine((value) => value === 1 || value === 2, {
    message: 'Travel class must be 1 or 2',
  }),
  passengers: z.number().int().min(1).max(9),
  seatRequired: z.boolean().default(true),
  intervalMinutes: z.number().int().min(2).default(5),
  active: z.boolean().default(true),
  notificationTarget: z.string().email().optional(),
});

export const watchUpdateSchema = watchInputSchema.partial();
