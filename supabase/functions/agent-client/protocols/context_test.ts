import { assertEquals } from "jsr:@std/assert@1";
import { isOpenAt } from "./context.ts";
import type { BusinessHours } from "../../_shared/types/extra_types.ts";

/**
 * The first test in this repository, and it earns the exception for one
 * reason: `isOpenAt` is arithmetic whose wrong answers look plausible. A
 * conversation at 21:00 that gets told the shop is closed reads as a policy,
 * not as a bug, so nobody reports it.
 *
 * Run with `deno test` from `supabase/functions`.
 */

const TZ = "America/Sao_Paulo"; // UTC-3, no DST since 2019.

/** Sunday first. Weekdays 09:00-18:00, Saturday half day, Sunday closed. */
const office: BusinessHours = [
  null,
  { from: "09:00", to: "18:00" },
  { from: "09:00", to: "18:00" },
  { from: "09:00", to: "18:00" },
  { from: "09:00", to: "18:00" },
  { from: "09:00", to: "18:00" },
  { from: "09:00", to: "13:00" },
];

/** Friday and Saturday nights, 18:00 through 02:00 the next morning. */
const bar: BusinessHours = [
  null,
  null,
  null,
  null,
  null,
  { from: "18:00", to: "02:00" },
  { from: "18:00", to: "02:00" },
];

const cases: [string, BusinessHours, string, boolean][] = [
  ["Tuesday 10:00", office, "2026-08-04T13:00:00Z", true],
  ["a minute before opening", office, "2026-08-04T11:59:00Z", false],
  ["on the closing minute", office, "2026-08-04T21:00:00Z", false],
  ["a minute before closing", office, "2026-08-04T20:59:00Z", true],
  ["Sunday, no row at all", office, "2026-08-02T13:00:00Z", false],
  ["Saturday within the half day", office, "2026-08-01T15:00:00Z", true],
  ["Saturday after the half day", office, "2026-08-01T17:00:00Z", false],
  // The reason the timezone exists: 21:00 in São Paulo is already midnight of
  // the following day in UTC, so a UTC clock reads Wednesday and the whole
  // schedule shifts by a day.
  ["21:00 local, already tomorrow in UTC", office, "2026-08-05T00:00:00Z", false],
  ["open on Friday night", bar, "2026-08-08T02:00:00Z", true],
  ["still open after midnight", bar, "2026-08-08T04:00:00Z", true],
  ["closed once the overnight range ends", bar, "2026-08-08T06:00:00Z", false],
  // Sunday has no row of its own; being open depends on Saturday's range.
  ["Sunday 01:00 belongs to Saturday", bar, "2026-08-09T04:00:00Z", true],
  ["Sunday 03:00 belongs to nobody", bar, "2026-08-09T06:00:00Z", false],
];

for (const [name, hours, instant, expected] of cases) {
  Deno.test(`isOpenAt: ${name}`, () => {
    assertEquals(isOpenAt(hours, TZ, new Date(instant)), expected);
  });
}
