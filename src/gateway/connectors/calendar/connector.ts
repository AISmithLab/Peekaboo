import { google, type calendar_v3 } from 'googleapis';
import type { SourceConnector, DataRow, SourceBoundary, ActionResult } from '../types.js';

export interface CalendarConnectorConfig {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
}

export class GoogleCalendarConnector implements SourceConnector {
  name = 'google_calendar';
  private calendar: calendar_v3.Calendar;
  private auth: InstanceType<typeof google.auth.OAuth2>;
  private lastSyncTimestamp?: string;

  constructor(config: CalendarConnectorConfig) {
    this.auth = new google.auth.OAuth2(config.clientId, config.clientSecret);
    if (config.accessToken || config.refreshToken) {
      this.auth.setCredentials({
        access_token: config.accessToken,
        refresh_token: config.refreshToken,
      });
    }
    this.calendar = google.calendar({ version: 'v3', auth: this.auth });
  }

  /**
   * Expose the underlying OAuth2 client so callers can listen for
   * the 'tokens' event (fired when tokens are auto-refreshed).
   */
  getAuth(): InstanceType<typeof google.auth.OAuth2> {
    return this.auth;
  }

  /**
   * Update the access token on the underlying OAuth2 client.
   */
  setAccessToken(token: string): void {
    this.auth.setCredentials({ ...this.auth.credentials, access_token: token });
  }

  async fetch(boundary: SourceBoundary, params?: Record<string, unknown>): Promise<DataRow[]> {
    const listParams: calendar_v3.Params$Resource$Events$List = {
      calendarId: 'primary',
      maxResults: (params?.limit as number) ?? 100,
      singleEvents: true,
      orderBy: 'startTime',
    };

    if (boundary.after) {
      listParams.timeMin = new Date(boundary.after).toISOString();
    } else {
      // Default to showing events from 7 days ago to ensure recent/upcoming visibility
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      listParams.timeMin = sevenDaysAgo.toISOString();
    }

    if (params?.query) {
      listParams.q = params.query as string;
    }

    console.log('[calendar] list params:', JSON.stringify(listParams));

    const response = await this.calendar.events.list(listParams);
    const events = response.data.items ?? [];
    
    return events.map(mapCalendarEvent);
  }

  async executeAction(actionType: string, actionData: Record<string, unknown>): Promise<ActionResult> {
    switch (actionType) {
      case 'create_event':
        return this.createEvent(actionData);
      case 'update_event':
        return this.updateEvent(actionData);
      case 'delete_event':
        return this.deleteEvent(actionData);
      case 'list_calendars':
        return this.listCalendars();
      default:
        return { success: false, message: `Unknown action type: ${actionType}` };
    }
  }

  async sync(boundary: SourceBoundary): Promise<DataRow[]> {
    const params: Record<string, unknown> = {};
    if (this.lastSyncTimestamp) {
      // Use lastSyncTimestamp to filter new/updated events
      boundary.after = this.lastSyncTimestamp;
    }

    const rows = await this.fetch(boundary, params);
    this.lastSyncTimestamp = new Date().toISOString();
    return rows;
  }

  private async createEvent(data: Record<string, unknown>): Promise<ActionResult> {
    const event: calendar_v3.Schema$Event = {
      summary: data.title as string,
      description: data.body as string,
      location: data.location as string,
      start: {
        dateTime: data.start as string,
        timeZone: (data.timeZone as string) || 'UTC',
      },
      end: {
        dateTime: data.end as string,
        timeZone: (data.timeZone as string) || 'UTC',
      },
      attendees: (data.attendees as Array<{ email: string }>) ?? [],
    };

    const response = await this.calendar.events.insert({
      calendarId: 'primary',
      requestBody: event,
    });

    return {
      success: true,
      message: 'Event created',
      resultData: { eventId: response.data.id, htmlLink: response.data.htmlLink },
    };
  }

  private async updateEvent(data: Record<string, unknown>): Promise<ActionResult> {
    const eventId = data.eventId as string;
    if (!eventId) {
      return { success: false, message: 'Missing eventId' };
    }

    const event: calendar_v3.Schema$Event = {
      summary: data.title as string,
      description: data.body as string,
      location: data.location as string,
      start: data.start ? { dateTime: data.start as string } : undefined,
      end: data.end ? { dateTime: data.end as string } : undefined,
    };

    const response = await this.calendar.events.patch({
      calendarId: 'primary',
      eventId,
      requestBody: event,
    });

    return {
      success: true,
      message: 'Event updated',
      resultData: { eventId: response.data.id, htmlLink: response.data.htmlLink },
    };
  }

  private async deleteEvent(data: Record<string, unknown>): Promise<ActionResult> {
    const eventId = data.eventId as string;
    if (!eventId) {
      return { success: false, message: 'Missing eventId' };
    }

    await this.calendar.events.delete({
      calendarId: 'primary',
      eventId,
    });

    return { success: true, message: 'Event deleted' };
  }

  private async listCalendars(): Promise<ActionResult> {
    const response = await this.calendar.calendarList.list();
    return {
      success: true,
      message: 'Calendars retrieved',
      resultData: { calendars: response.data.items },
    };
  }
}

export function mapCalendarEvent(event: calendar_v3.Schema$Event): DataRow {
  const start = event.start?.dateTime || event.start?.date || '';
  const end = event.end?.dateTime || event.end?.date || '';

  return {
    source: 'google_calendar',
    source_item_id: event.id ?? '',
    type: 'calendar_event',
    timestamp: start ? new Date(start).toISOString() : new Date().toISOString(),
    data: {
      title: event.summary ?? '(No Title)',
      body: event.description ?? '',
      location: event.location ?? '',
      start,
      end,
      attendees: event.attendees?.map((a) => ({
        name: a.displayName,
        email: a.email,
        responseStatus: a.responseStatus,
      })) ?? [],
      url: event.htmlLink ?? '',
      status: event.status,
      creator: event.creator?.email,
      organizer: event.organizer?.email,
      isAllDay: !!event.start?.date,
    },
  };
}
