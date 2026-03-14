import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from './config.js';
import { HeartbeatConfig } from './types.js';

/**
 * Convert a human-friendly interval like "30m", "1h", "6h", "1d"
 * into a cron expression.
 */
export function intervalToCron(interval: string): string {
  const match = interval.match(/^(\d+)(m|h|d)$/);
  if (!match) {
    throw new Error(`Invalid interval format: "${interval}". Use e.g. "30m", "1h", "6h", "1d".`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 'm':
      if (value < 1 || value > 59) throw new Error(`Invalid minute interval: ${value}`);
      return `*/${value} * * * *`;
    case 'h':
      if (value < 1 || value > 23) throw new Error(`Invalid hour interval: ${value}`);
      return `0 */${value} * * *`;
    case 'd':
      if (value < 1 || value > 28) throw new Error(`Invalid day interval: ${value}`);
      return `0 9 */${value} * *`; // Run at 9 AM
    default:
      throw new Error(`Unknown interval unit: ${unit}`);
  }
}

/**
 * Check if the current time falls within a quiet period.
 * Handles overnight ranges like { start: "23:00", end: "07:00" }.
 */
export function isInQuietPeriod(quiet: NonNullable<HeartbeatConfig['quiet']>): boolean {
  const now = new Date();
  const localTime = new Date(now.toLocaleString('en-US', { timeZone: TIMEZONE }));
  const currentMinutes = localTime.getHours() * 60 + localTime.getMinutes();

  const [startH, startM] = quiet.start.split(':').map(Number);
  const [endH, endM] = quiet.end.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Overnight range, e.g. "23:00" to "07:00"
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

/**
 * Check if the current time matches the fields of a cron expression,
 * i.e. the agent is within its active window.
 *
 * The cron defines WHEN the agent is active (e.g. "* 9-17 * * 1-5" = weekdays 9am–5pm).
 * Each cron field is checked against the current time component.
 */
export function isInActiveWindow(cron: string | string[]): boolean {
  if (Array.isArray(cron)) return cron.some(isInActiveWindowSingle);
  return isInActiveWindowSingle(cron);
}

function isInActiveWindowSingle(cron: string): boolean {
  const now = new Date();
  const localTime = new Date(now.toLocaleString('en-US', { timeZone: TIMEZONE }));

  const minute = localTime.getMinutes();
  const hour = localTime.getHours();
  const dayOfMonth = localTime.getDate();
  const month = localTime.getMonth() + 1; // 1-indexed
  // getDay() returns 0=Sun,1=Mon,...,6=Sat; cron standard: 0/7=Sun,1=Mon,...,6=Sat
  const dayOfWeek = localTime.getDay();

  const expr = CronExpressionParser.parse(cron, { tz: TIMEZONE });
  const fields = expr.fields;

  const inSet = (value: number, set: (string | number)[]): boolean => set.includes(value);

  const mVals = fields.minute.serialize().values;
  const hVals = fields.hour.serialize().values;
  const domVals = fields.dayOfMonth.serialize().values;
  const monVals = fields.month.serialize().values;
  const dowVals = fields.dayOfWeek.serialize().values;

  return (
    inSet(minute, mVals) &&
    inSet(hour, hVals) &&
    inSet(dayOfMonth, domVals) &&
    inSet(month, monVals) &&
    (inSet(dayOfWeek, dowVals) || (dayOfWeek === 0 && inSet(7, dowVals)))
  );
}

/**
 * Returns the next time the cron expression would fire (i.e. when the active window next opens).
 */
export function getNextActiveTime(cron: string | string[]): Date {
  const exprs = Array.isArray(cron) ? cron : [cron];
  const times = exprs.map(c => CronExpressionParser.parse(c, { tz: TIMEZONE }).next().toDate());
  return times.reduce((earliest, t) => t < earliest ? t : earliest);
}

/**
 * Format a future Date as a human-friendly string like "today at 9:00 AM" or "Monday at 9:00 AM".
 */
export function formatNextActiveTime(date: Date): string {
  const now = new Date();
  const localNow = new Date(now.toLocaleString('en-US', { timeZone: TIMEZONE }));
  const localDate = new Date(date.toLocaleString('en-US', { timeZone: TIMEZONE }));

  const timeStr = localDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  const nowDay = localNow.toDateString();
  const nextDay = localDate.toDateString();

  if (nowDay === nextDay) return `today at ${timeStr}`;

  const tomorrowDate = new Date(localNow);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  if (tomorrowDate.toDateString() === nextDay) return `tomorrow at ${timeStr}`;

  const dayName = localDate.toLocaleDateString('en-US', { weekday: 'long' });
  return `${dayName} at ${timeStr}`;
}
