/** Shared types between the main and renderer processes. */

export type StemState = 'none' | 'pending' | 'analyzing' | 'ready' | 'failed';

export interface Credits {
  composer: string[];
  lyricist: string[];
  arranger: string[];
  producer: string[];
  mixer: string[];
  mastering: string[];
  engineer: string[];
  performer: string[];
}

export const EMPTY_CREDITS: Credits = {
  composer: [],
  lyricist: [],
  arranger: [],
  producer: [],
  mixer: [],
  mastering: [],
  engineer: [],
  performer: []
};

export interface BeatGrid {
  /** Beats inside the last 45 s of the track (absolute seconds). */
  tail: number[];
  /** Beats inside the first 30 s of the track (absolute seconds). */
  head: number[];
  /** Seconds per beat at the estimated tempo. */
  period: number;
  /** 0..1, how regular the inter-beat intervals are. */
  stability: number;
  /** 0..3, which beat of the bar is the downbeat. */
  downbeat: number;
}

export interface AnalysisResult {
  bpm: number;
  bpmConfidence: number;
  bpmCandidates: number[];
  grid: BeatGrid;
  lufs: number;
  leadSilence: number;
  tailSilence: number;
  audioStart: number;
  audioEnd: number;
  analyzedAt: number;
  engine: string;
}

export interface StemInfo {
  state: StemState;
  /** Seconds of audio covered by the cached vocal stem window. */
  window: { start: number; end: number } | null;
  /** Vocal energy per 100 ms inside the window, 0..1. */
  vocalCurve: number[] | null;
  /** Detected vocal phrases (absolute seconds). */
  phrases: { start: number; end: number }[] | null;
  model: string | null;
  error: string | null;
}

export interface SongMeta {
  id: string;
  path: string;
  dir: string;
  title: string;
  artists: string[];
  albumArtist: string;
  album: string;
  trackNo: number | null;
  trackTotal: number | null;
  discNo: number | null;
  discTotal: number | null;
  year: number | null;
  genre: string | null;
  bpmTag: number | null;
  durationSec: number;
  bitrate: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number | null;
  codec: string;
  container: string;
  fileSize: number;
  mtimeMs: number;
  replayGainTrackGain: number | null;
  replayGainTrackPeak: number | null;
  replayGainAlbumGain: number | null;
  credits: Credits;
  coverId: string | null;
  coverSizes: number[];
  hasEmbeddedLyrics: boolean;
  addedAt: number;
  analysis: AnalysisResult | null;
  stem: StemInfo | null;
}

export interface LibraryFolder {
  path: string;
  addedAt: number;
}

export interface LyricLineData {
  words: { startTime: number; endTime: number; word: string; romanWord?: string }[];
  translatedLyric: string;
  romanLyric: string;
  isBG: boolean;
  isDuet: boolean;
  startTime: number;
  endTime: number;
}

export type LyricSourceKind = 'lrc' | 'ttml' | 'lys' | 'yrc' | 'qrc' | 'sylt' | 'embedded' | 'none';

export interface LyricsPayload {
  songId: string;
  kind: 'none' | 'synced' | 'plain';
  lines: LyricLineData[];
  plain: string | null;
  source: LyricSourceKind;
  sourceLabel: string;
  filePath: string | null;
  hasTranslation: boolean;
  hasRoman: boolean;
  raw: string;
}

export interface SongInfoExtra {
  path: string;
  dir: string;
  format: string;
  codec: string;
  bitrate: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number | null;
  fileSize: number;
  replayGainTrackGain: number | null;
  replayGainTrackPeak: number | null;
  analysis: AnalysisResult | null;
  stem: StemInfo | null;
  lyricsSource: string;
}

export interface AppSettings {
  theme: 'system' | 'light' | 'dark';
  glass: 'full' | 'lite' | 'off';
  sidebarWidth: number;
  lyricsPriority: ('sidecar' | 'embedded' | 'text')[];
  lyricOffsetMs: number;
  showTranslation: boolean;
  showRoman: boolean;
  lyricFontScale: number;
  /** 歌词字重（200–900） */
  lyricWeight: number;
  /** 已唱字的高光亮度（0.3–1.4），越大越亮 */
  lyricHighlight: number;
  /** 歌词字体：苹方优先 / 跟随系统 */
  lyricFont: 'pingfang' | 'system';
  /** 逐字渐变宽度（AMLL wordFadeWidth） */
  wordFade: number;
  /** 非当前行模糊 */
  lyricBlur: boolean;
  /** 非当前行缩放 */
  lyricScale: boolean;
  /** 隐藏已播放的歌词行 */
  hidePassed: boolean;
  /** 歌词页右上角显示实时帧率 */
  showFps: boolean;
  /** 歌词界面进入/退出的下拉动画 */
  lyricTransition: boolean;
  /** 上一首/下一首按钮的按压动画 */
  btnAnim: boolean;
  /** 切歌时封面与背景交叉淡入 */
  mediaAnim: boolean;
  /** 点击歌词行跳转到对应位置 */
  lyricClickSeek: boolean;
  /** 当前源取不到时自动回退到下一个源 */
  lyricAutoFallback: boolean;
  /** 歌词页背景 */
  bgEnabled: boolean;
  bgType: 'flow' | 'blur' | 'solid';
  bgFlowSpeed: number;
  bgRenderScale: number;
  bgFps: number;
  bgPerf: boolean;
  adaptiveQuality: boolean;
  bgBlur: number;
  bgBrightness: number;
  bgSaturate: number;
  /** 歌曲信息 */
  showAlbum: boolean;
  coverHideCursor: boolean;
  /** 顶栏胶囊材质（对应插件的底边栏） */
  barStyle: 'off' | 'blur';
  barOpacity: number;
  barBlur: number;
  barCover: number;
  backgroundQuality: 'high' | 'medium' | 'low' | 'off';
  automix: {
    enabled: boolean;
    durationSec: number;
    stems: boolean;
    maxRatePct: number;
    protectLastPhrase: boolean;
    baseFadeSec: number;
    preprocess: 'off' | 'smart' | 'all';
    workerLimit: number;
    onlyOnAC: boolean;
    cacheLimitGB: number;
  };
  modelsDir: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  glass: 'full',
  sidebarWidth: 248,
  lyricsPriority: ['sidecar', 'embedded'],
  lyricOffsetMs: 0,
  showTranslation: true,
  showRoman: true,
  lyricFontScale: 1,
  lyricWeight: 600,
  lyricHighlight: 1,
  lyricFont: 'pingfang',
  wordFade: 0.6,
  lyricBlur: true,
  lyricScale: true,
  hidePassed: false,
  showFps: false,
  lyricTransition: true,
  btnAnim: true,
  mediaAnim: true,
  lyricClickSeek: true,
  lyricAutoFallback: true,
  bgEnabled: true,
  bgType: 'flow',
  bgFlowSpeed: 1,
  bgRenderScale: 0.5,
  bgFps: 30,
  bgPerf: false,
  adaptiveQuality: true,
  bgBlur: 100,
  bgBrightness: 0.55,
  bgSaturate: 1.9,
  showAlbum: true,
  coverHideCursor: true,
  barStyle: 'blur',
  barOpacity: 0.42,
  barBlur: 26,
  barCover: 0.45,
  backgroundQuality: 'high',
  automix: {
    enabled: true,
    durationSec: 30,
    stems: true,
    maxRatePct: 8,
    protectLastPhrase: true,
    baseFadeSec: 6,
    preprocess: 'smart',
    workerLimit: 2,
    onlyOnAC: false,
    cacheLimitGB: 10
  },
  modelsDir: null
};

export type RepeatMode = 'off' | 'all' | 'one'

/** 收藏：只存 id / key 集合，专辑与艺人的歌曲集合由渲染进程换算 */
export interface FavoritesState {
  songs: string[]
  albums: string[]
};

export interface QueueItem {
  songId: string;
  /** stable key so the same song can appear twice in a queue */
  key: string;
}

export interface QueueState {
  items: QueueItem[];
  index: number;
  history: string[];
}

export interface ScanProgress {
  active: boolean;
  stage: 'idle' | 'scanning' | 'tags' | 'done';
  processed: number;
  total: number;
  currentTitle: string;
  folder: string | null;
}

export interface AnalysisProgress {
  active: boolean;
  done: number;
  total: number;
  stage: 'analyzing' | 'stemming' | 'idle';
  currentTitle: string;
  failures: { songId: string; title: string; reason: string }[];
  ratePerMin: number;
  etaSec: number | null;
  paused: boolean;
  gpu: 'directml' | 'cpu' | 'none';
  workers: number;
}

export interface LibraryBatch {
  added: SongMeta[];
  updated: SongMeta[];
  removed: string[];
  progress: ScanProgress;
}
