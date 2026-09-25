import { errorMessage, HttpError, NetworkError } from "../../api/errors";

/** What went wrong, for a notice: a short title and the daemon's reason. */
export interface Notice {
  title: string;
  body: string;
}

export function reason(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message || fallback;
}

/**
 * Why Run now didn't start a run. The daemon's message says which case it is (a run is going,
 * the routine has a problem, today's extra runs are used up; the agent is off or can't run here).
 */
export function runProblem(error: unknown): Notice {
  if (error instanceof HttpError) {
    switch (error.status) {
      case 409:
        return {
          title: "It can't run right now",
          body: reason(error, "A run is going, or today's extra runs are used up."),
        };
      case 503:
        return {
          title: "The agent can't run here",
          body: reason(error, "The agent isn't running on this device."),
        };
      case 404:
        return { title: "This routine is gone", body: "Its file was moved or deleted." };
    }
  }
  if (error instanceof NetworkError) {
    return { title: "Couldn't reach Daily Do List", body: reason(error, "The daemon is offline.") };
  }
  return { title: "Couldn't start the run", body: errorMessage(error) };
}
