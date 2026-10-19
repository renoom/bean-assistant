import type { TaskSchedule } from './types.ts'

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/
const DAILY_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/

function validInstant(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ISO_WITH_OFFSET.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be an ISO timestamp with an explicit offset`)
  }
  return new Date(value).toISOString()
}

export function validateSchedule(value: unknown): TaskSchedule {
  if (!value || typeof value !== 'object') throw new Error('schedule is required')
  const schedule = value as Record<string, unknown>
  if (schedule.kind === 'once') {
    return { kind: 'once', at: validInstant(schedule.at, 'schedule.at') }
  }
  if (schedule.kind === 'interval') {
    if (typeof schedule.everySeconds !== 'number' || !Number.isInteger(schedule.everySeconds) || schedule.everySeconds < 60) {
      throw new Error('schedule.everySeconds must be an integer greater than or equal to 60')
    }
    return {
      kind: 'interval',
      everySeconds: schedule.everySeconds,
      ...(schedule.startAt !== undefined ? { startAt: validInstant(schedule.startAt, 'schedule.startAt') } : {}),
    }
  }
  if (schedule.kind === 'daily') {
    if (typeof schedule.time !== 'string' || !DAILY_TIME.test(schedule.time)) {
      throw new Error('schedule.time must use HH:mm (24-hour) format')
    }
    if (typeof schedule.timezone !== 'string' || !isValidTimezone(schedule.timezone)) {
      throw new Error('schedule.timezone must be a valid IANA timezone')
    }
    return { kind: 'daily', time: schedule.time, timezone: schedule.timezone }
  }
  throw new Error('schedule.kind must be once, interval, or daily')
}

export function nextRunAtForSchedule(
  schedule: TaskSchedule,
  now: Date = new Date(),
  previousScheduledAt?: string,
): string | null {
  const nowMs = now.getTime()
  if (schedule.kind === 'once') {
    const at = Date.parse(schedule.at)
    return previousScheduledAt === undefined || at > nowMs ? new Date(at).toISOString() : null
  }
  if (schedule.kind === 'interval') {
    const step = schedule.everySeconds * 1000
    let candidate = previousScheduledAt !== undefined
      ? Date.parse(previousScheduledAt) + step
      : schedule.startAt !== undefined
        ? Date.parse(schedule.startAt)
        : nowMs + step
    if (candidate <= nowMs) candidate += (Math.floor((nowMs - candidate) / step) + 1) * step
    return new Date(candidate).toISOString()
  }
  return nextDaily(schedule.time, schedule.timezone, now)
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0)
    return true
  } catch {
    return false
  }
}

function nextDaily(time: string, timezone: string, now: Date): string {
  const [hour, minute] = time.split(':').map(Number)
  const localNow = zonedParts(now, timezone)
  for (let dayOffset = 0; dayOffset < 4; dayOffset++) {
    const date = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day + dayOffset, hour, minute))
    const candidate = localDateTimeToUtc({
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour,
      minute,
    }, timezone)
    // A nonexistent local time during a DST jump must not execute at a
    // different wall-clock time. Skip that date and use the next occurrence.
    const observed = zonedParts(candidate, timezone)
    if (observed.year === date.getUTCFullYear() && observed.month === date.getUTCMonth() + 1
      && observed.day === date.getUTCDate() && observed.hour === hour && observed.minute === minute
      && candidate.getTime() > now.getTime()) return candidate.toISOString()
  }
  throw new Error(`unable to calculate next daily run for ${timezone}`)
}

interface DateParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function zonedParts(date: Date, timezone: string): DateParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(part => part.type === type)?.value)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') }
}

/** Resolve a wall-clock time by iterating the timezone's observed offset. */
function localDateTimeToUtc(parts: DateParts, timezone: string): Date {
  const wallClock = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
  let candidate = wallClock
  for (let i = 0; i < 4; i++) {
    const observed = zonedParts(new Date(candidate), timezone)
    const observedWallClock = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute)
    const adjustment = wallClock - observedWallClock
    if (adjustment === 0) break
    candidate += adjustment
  }
  return new Date(candidate)
}
