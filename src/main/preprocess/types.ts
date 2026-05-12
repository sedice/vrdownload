import type { LogFn } from "../cdp-capture.js";

/**
 * 各平台预处理结束后写入 settings、供封面/标题编辑与上传使用的统一结构。
 */
export type ProcessedSessionData = {
  title: string;
  /** 相对会话根目录的 posix 路径，如 `vrpic.justeasy.cn/thumb/xxx/thumb.jpg` */
  thumbJpgList: string[];
  /** 默认封面；在 thumbJpgList 中或 null */
  cover: string | null;
  tags: string[];
};

export type PreprocessContext = {
  treeRoot: string;
  startUrl: string;
  log: LogFn;
};

/**
 * 按平台拆分的预处理策略：先改镜像/入口，再汇总为统一的 ProcessedSessionData。
 */
export interface IPreprocessStrategy {
  readonly platformId: string;
  /** 站点专属：移动入口页、改写资源路径、注入 polyfill 等 */
  runPlatformTransforms(ctx: PreprocessContext): Promise<void>;
  /** 从当前树读取标题、缩略图列表等，产出与 UI 一致的结构 */
  collectSessionData(ctx: PreprocessContext): Promise<ProcessedSessionData>;
}
