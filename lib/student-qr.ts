import { instituteDate, localInputToISO } from './hub-types';

export function dailyQrWindow(timestamp: number, timeZone: string) {
  const day = instituteDate(new Date(timestamp).toISOString(), timeZone);
  const tomorrow = new Date(Date.parse(day + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
  return { day, timeZone, expiresAt: new Date(Math.min(timestamp + 5 * 60_000, Date.parse(localInputToISO(tomorrow + 'T00:00', timeZone)))).toISOString() };
}

export function newStudentQrToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
}

export function studentQrPayload(day: string, token: string) {
  return `BSQ1:${day}:${token}`;
}
