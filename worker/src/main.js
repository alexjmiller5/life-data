// The deployed entry: the hub with its usage meter, cap and notification feed
// around it (src/usage.js). Tests drive src/index.js directly for hub behavior.
import hub, { SWEEP_CRON, authenticate } from "./index.js";
import { withUsage } from "./usage.js";

export { ChangeSignal } from "./changes.js";
export default withUsage(hub, { authenticate, sweepCron: SWEEP_CRON });
