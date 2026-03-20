import { describe, it, expect } from 'vitest';
import { mapCalendarEvent } from './connector.js';
import type { calendar_v3 } from 'googleapis';

function makeCalendarEvent(overrides?: Partial<calendar_v3.Schema$Event>): calendar_v3.Schema$Event {
  return {
    id: 'event_test_123',
    summary: 'Team Sync',
    description: 'Weekly sync with the team',
    location: 'Meeting Room A',
    start: { dateTime: '2026-03-20T10:00:00Z' },
    end: { dateTime: '2026-03-20T11:00:00Z' },
    htmlLink: 'https://calendar.google.com/event?id=123',
    status: 'confirmed',
    creator: { email: 'alice@company.com' },
    organizer: { email: 'alice@company.com' },
    attendees: [
      { displayName: 'Bob Jones', email: 'bob@company.com', responseStatus: 'accepted' },
      { displayName: 'Charlie', email: 'charlie@company.com', responseStatus: 'needsAction' },
    ],
    ...overrides,
  };
}

describe('Google Calendar Connector', () => {
  it('maps raw Calendar API event to correct DataRow with all fields', () => {
    const event = makeCalendarEvent();
    const row = mapCalendarEvent(event);

    expect(row.source).toBe('google_calendar');
    expect(row.source_item_id).toBe('event_test_123');
    expect(row.type).toBe('calendar_event');
    expect(row.timestamp).toBe('2026-03-20T10:00:00.000Z');

    expect(row.data.title).toBe('Team Sync');
    expect(row.data.body).toBe('Weekly sync with the team');
    expect(row.data.location).toBe('Meeting Room A');
    expect(row.data.start).toBe('2026-03-20T10:00:00Z');
    expect(row.data.end).toBe('2026-03-20T11:00:00Z');
    expect(row.data.url).toBe('https://calendar.google.com/event?id=123');
    expect(row.data.status).toBe('confirmed');
    expect(row.data.creator).toBe('alice@company.com');
    expect(row.data.isAllDay).toBe(false);
  });

  it('extracts attendees correctly', () => {
    const event = makeCalendarEvent();
    const row = mapCalendarEvent(event);
    const attendees = row.data.attendees as Array<{ name: string; email: string; responseStatus: string }>;

    expect(attendees).toHaveLength(2);
    expect(attendees[0]).toEqual({ name: 'Bob Jones', email: 'bob@company.com', responseStatus: 'accepted' });
    expect(attendees[1]).toEqual({ name: 'Charlie', email: 'charlie@company.com', responseStatus: 'needsAction' });
  });

  it('handles all-day events correctly', () => {
    const event = makeCalendarEvent({
      start: { date: '2026-03-20' },
      end: { date: '2026-03-21' },
    });

    const row = mapCalendarEvent(event);
    expect(row.data.start).toBe('2026-03-20');
    expect(row.data.isAllDay).toBe(true);
    expect(row.timestamp).toBe(new Date('2026-03-20').toISOString());
  });

  it('handles missing summary gracefully', () => {
    const event = makeCalendarEvent({ summary: undefined });
    const row = mapCalendarEvent(event);
    expect(row.data.title).toBe('(No Title)');
  });

  it('handles missing description gracefully', () => {
    const event = makeCalendarEvent({ description: undefined });
    const row = mapCalendarEvent(event);
    expect(row.data.body).toBe('');
  });
});
