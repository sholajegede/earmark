import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("end jobs whose hold ran out", { minutes: 1 }, internal.gate.expire, {});
crons.interval("report changed totals", { minutes: 1 }, internal.report.reportDue, {});
crons.daily("delete lab accounts", { hourUTC: 3, minuteUTC: 0 }, internal.lab.purge, {});
export default crons;
