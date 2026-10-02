// The deployed entry: the hub with its usage meter, cap and notification feed
// around it (src/usage.js). Tests drive src/index.js directly for hub behavior.
import hub, { SWEEP_CRON, allowed, authenticate } from "./index.js";
import { withUsage } from "./usage.js";

export default withUsage(hub, { authenticate, allowed, sweepCron: SWEEP_CRON });
