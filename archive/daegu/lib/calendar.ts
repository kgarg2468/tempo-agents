/**
 * Google Calendar exit-interview scheduler.
 *
 * Used by the inbound-email handler when a terminated employee asks to
 * speak with a human. Creates a 30-minute event two business days out
 * with the employee as an attendee and returns the new event id.
 *
 * Falls back to a deterministic stub event id when no Google credentials
 * are configured so the rest of the demo flow keeps working.
 */
import { google } from "googleapis";

function getOAuth() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

export interface ScheduleResult {
  event_id: string;
  start: string; // ISO
  end: string; // ISO
  simulated: boolean;
}

/**
 * Schedule a 30-minute exit interview for the named employee.
 * Returns the calendar event id.
 */
export async function scheduleExitInterview(
  email: string,
  name: string
): Promise<ScheduleResult> {
  const start = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  start.setHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  const auth = getOAuth();
  if (!auth) {
    const stub = `sim_evt_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    return {
      event_id: stub,
      start: start.toISOString(),
      end: end.toISOString(),
      simulated: true,
    };
  }

  const cal = google.calendar({ version: "v3", auth });
  const ev = await cal.events.insert({
    calendarId: "primary",
    sendUpdates: "all",
    requestBody: {
      summary: `Exit Interview — ${name}`,
      description:
        "Brief 30-minute conversation to coordinate handoffs and answer any final questions. Sent on behalf of OpenFire HR.",
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      attendees: [{ email }],
    },
  });

  return {
    event_id: ev.data.id ?? `unknown_${Date.now()}`,
    start: start.toISOString(),
    end: end.toISOString(),
    simulated: false,
  };
}
