// Barrel re-export — keeps external consumers stable while the implementation
// lives in server-command.mjs, server-lifecycle.mjs, and server-status.mjs.

export { computeServerCommand, buildStartScript } from "./server-command.mjs";

export {
  startServer,
  stopProfile,
  stopOrUnload,
  unloadModelFromServer,
} from "./server-lifecycle.mjs";

export {
  isProfileRunning,
  modelLoadedOnServer,
  modelAvailableOnServer,
  profileRuntimeStatus,
  serverMatchesProfile,
  runningProfiles,
  waitForReady,
  preflightInference,
  serverModelIds,
  apiRootUrl,
  readProcessIdentity,
  processIdentityMatches,
} from "./server-status.mjs";