export type { ProcessedSessionData, PreprocessContext, IPreprocessStrategy } from "./types.js";
export { resolvePreprocessStrategy, runPreprocess } from "./registry.js";
export {
  resolveExistingSessionRoot,
  resolvePreprocessTreeRoot,
} from "./tree-root.js";
export {
  resolveSettingsPathForSession,
  persistProcessedSessionData,
  resolveSettingsPath,
  readSettingsObject,
} from "./settings-io.js";
export { sessionMainHtmlName, collectFilesUnder, pruneEmptyDirsUnder } from "./fs-utils.js";
export { readTitleFromSessionMainHtml } from "./session-read.js";
export {
  moveViewHtmlToSessionRoot,
  rewriteMirrorTextInTree,
  injectRes1PolyfillIntoMainHtml,
  writeMainHtmlTitleToSettingJson,
  writeThumbJpgListToSettings,
} from "./vr-justeasy-strategy.js";
export {
  injectBackHomeIntoHtmlInTree,
  replaceMissingMp3RefsInHtmlInTree,
  rewriteHttpsToDotSlashInTree,
} from "./post-common.js";
export {
  MIRROR_HIDE_CHROME_MARKER,
  MIRROR_HIDE_CHROME_STYLE,
  injectMirrorHideChromeStyleIntoHead,
} from "./chrome-hide-style.js";
export { genericStrategy } from "./generic-strategy.js";
export { vr3d66DetailStrategy } from "./vr-3d66-detail-strategy.js";
export { vrJusteasyStrategy } from "./vr-justeasy-strategy.js";
