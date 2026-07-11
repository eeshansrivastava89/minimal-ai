// Barrel re-export — keeps external consumers stable while the implementation
// lives in server-command.mjs, server-lifecycle.mjs, and server-status.mjs.

export { computeServerCommand, buildStartScript } from "./server-command.mjs";

export {
  startServer,
  stopProfile,
  unloadModelFromServer,
} from "./server-lifecycle.mjs";

export {
  isProfileRunning,
  isProfileServerUp,
  modelLoadedOnServer,
  modelAvailableOnServer,
  profileRuntimeStatus,
  serverMatchesProfile,
  waitForReady,
  preflightInference,
  serverModelIds,
  apiRootUrl,
} from "./server-status.mjs";

export { serverReady } from "./server-check.mjs";