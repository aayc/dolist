import { describe, expect, it } from "vitest";
import {
  decodePersistedMutationJournal,
  PersistedNotificationEventSchema,
} from "../../src/persisted";
import { listFixtures, readFixture } from "./fixtures";

describe("mutation journal fixtures", () => {
  it.each(listFixtures("mutation-journal"))("%s never skips a damaged or newer event", (name) => {
    const read = () => decodePersistedMutationJournal(readFixture("mutation-journal", name));
    if (name.startsWith("v1")) expect(read()[0]?.type).toBe("mutation.prepared");
    else expect(read).toThrow();
  });
});

describe("notification journal fixtures", () => {
  it.each(listFixtures("notification-journal"))("%s keeps the exact scheduler decision", (name) => {
    const read = () =>
      PersistedNotificationEventSchema.parse(JSON.parse(readFixture("notification-journal", name)));
    if (name.startsWith("v1")) expect(read().type).toBe("routine.notification.decided");
    else expect(read).toThrow();
  });
});
