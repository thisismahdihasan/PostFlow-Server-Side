export interface ScrapingWindowConfig {
  scrapingStartTime: string;
  scrapingEndTime: string;
  timezone: string;
}

export const isValidIanaTimezone = (tz: unknown): boolean => {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
};

export const isValidTimeFormat = (time: unknown): boolean => {
  if (typeof time !== 'string') return false;
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(time.trim());
};

export const timeToMinutes = (time: string): number => {
  const [hourStr, minuteStr] = time.trim().split(':');
  const hour = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);
  return hour * 60 + minute;
};

export const getCurrentDateInTimezone = (
  timeZone: string,
  date: Date = new Date()
): string => {
  const safeTimezone = isValidIanaTimezone(timeZone) ? (timeZone as string).trim() : 'Asia/Dhaka';
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value || '1970';
  const month = parts.find((p) => p.type === 'month')?.value || '01';
  const day = parts.find((p) => p.type === 'day')?.value || '01';
  return `${year}-${month}-${day}`;
};

/** UTC bounds of a calendar date, including short/long DST days and midnight transitions. */
export const getDateRangeInTimezone = (date: string, timeZone: string): { start: Date; end: Date } => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, era: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const midnight = new Date(`${date}T00:00:00.000Z`);
  const nextDate = new Date(midnight);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);

  const boundary = (calendarDate: Date): Date => {
    const target = calendarDate.getUTCFullYear() * 10000
      + (calendarDate.getUTCMonth() + 1) * 100 + calendarDate.getUTCDate();
    // Search for the first instant of the local date rather than assuming a 24-hour day.
    let lower = calendarDate.getTime() - 48 * 60 * 60 * 1000;
    let upper = calendarDate.getTime() + 48 * 60 * 60 * 1000;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      const parts = formatter.formatToParts(new Date(middle));
      const year = Number(parts.find((part) => part.type === 'year')?.value);
      const signedYear = parts.find((part) => part.type === 'era')?.value === 'BC' ? 1 - year : year;
      const value = signedYear * 10000
        + Number(parts.find((part) => part.type === 'month')?.value) * 100
        + Number(parts.find((part) => part.type === 'day')?.value);
      if (value < target) lower = middle + 1;
      else upper = middle;
    }
    return new Date(lower);
  };

  return { start: boundary(midnight), end: boundary(nextDate) };
};

export const getCurrentTimeInTimezone = (
  timeZone: string,
  date: Date = new Date()
): { hour: number; minute: number; timeString: string; totalMinutes: number } => {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
  const timeString = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return {
    hour,
    minute,
    timeString,
    totalMinutes: hour * 60 + minute,
  };
};

export const isWithinLeadScrapingWindow = (
  config: ScrapingWindowConfig,
  date: Date = new Date()
): boolean => {
  const { scrapingStartTime, scrapingEndTime, timezone } = config;

  if (!isValidTimeFormat(scrapingStartTime) || !isValidTimeFormat(scrapingEndTime)) {
    return false;
  }

  if (!isValidIanaTimezone(timezone)) {
    return false;
  }

  const startMinutes = timeToMinutes(scrapingStartTime);
  const endMinutes = timeToMinutes(scrapingEndTime);

  // Start and End cannot be equal (rejected as invalid window)
  if (startMinutes === endMinutes) {
    return false;
  }

  const { totalMinutes: nowMinutes } = getCurrentTimeInTimezone(timezone, date);

  if (startMinutes < endMinutes) {
    // Normal window: e.g. 01:00 (60) to 05:00 (300)
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  } else {
    // Cross-midnight window: e.g. 22:00 (1320) to 03:00 (180)
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  }
};
