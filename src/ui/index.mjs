// UI toolkit — originally @eeshans/cli-kit, inlined into this repo (the kit
// had a single consumer; the "shared design language" never materialized, and
// a separate package only added release friction). Clack + commander +
// picocolors are used directly from here.

export { theme, icons } from "./theme.mjs";
export { maxWidth, termWidth, visibleLen, padEndVisible, padStartVisible, fillLine, wrapText, sectionLine } from "./layout.mjs";
export {
  appHeader,
  screenHeader,
  section,
  status,
  logStatus,
  withSpinner,
  outroScreen,
  hintFooter,
  renderList,
  isCancel,
  cancel,
} from "./components.mjs";
export {
  promptText,
  promptConfirm,
  promptNumber,
  promptSelect,
  promptChoice,
  promptSelectModel,
  promptMultiSelect,
  promptContentWidth,
} from "./prompts.mjs";
export { createCli, runCli, formatError } from "./cli.mjs";
export { FangHelp } from "./help.mjs";
