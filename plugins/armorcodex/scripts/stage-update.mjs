// Detached stager. Spawned by SessionStart so a clone and a dependency
// install never run inside a hook the session is waiting on.
import { stageUpdate } from "./lib/update-apply.mjs";

const result = await stageUpdate({
  installHome: process.env.ARMORCODEX_STAGE_INSTALL_HOME,
  tag: process.env.ARMORCODEX_STAGE_TAG
});

process.exit(result.staged ? 0 : 1);
