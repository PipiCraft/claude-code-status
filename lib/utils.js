// @ts-check
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const THEMES = {
  default: {
    DIM: "\x1b[2m",
    CYAN: "\x1b[36m",
    GREEN: "\x1b[32m",
    YELLOW: "\x1b[33m",
    RED: "\x1b[31m",
    MAGENTA: "\x1b[35m",
    RESET: "\x1b[0m",
  },
  catppuccin: {
    DIM: "\x1b[2m",
    CYAN: "\x1b[38;2;137;220;235m", // #89dceb
    GREEN: "\x1b[38;2;166;227;161m", // #a6e3a1
    YELLOW: "\x1b[38;2;249;226;175m", // #f9e2af
    RED: "\x1b[38;2;243;139;168m", // #f38ba8
    MAGENTA: "\x1b[38;2;203;166;247m", // #cba6f7
    RESET: "\x1b[0m",
  },
  nord: {
    DIM: "\x1b[2m",
    CYAN: "\x1b[38;2;136;192;208m", // #88C0D0
    GREEN: "\x1b[38;2;163;190;140m", // #A3BE8C
    YELLOW: "\x1b[38;2;235;203;139m", // #EBCB8B
    RED: "\x1b[38;2;191;97;106m", // #BF616A
    MAGENTA: "\x1b[38;2;180;142;173m", // #B48EAD
    RESET: "\x1b[0m",
  },
  tokyo: {
    DIM: "\x1b[2m",
    CYAN: "\x1b[38;2;122;162;247m", // #7aa2f7
    GREEN: "\x1b[38;2;158;206;106m", // #9ece6a
    YELLOW: "\x1b[38;2;224;175;104m", // #e0af68
    RED: "\x1b[38;2;247;118;142m", // #f7768e
    MAGENTA: "\x1b[38;2;187;154;247m", // #bb9af7
    RESET: "\x1b[0m",
  },
  dracula: {
    DIM: "\x1b[38;2;98;114;164m", // #6272a4
    CYAN: "\x1b[38;2;139;233;253m", // #8be9fd
    GREEN: "\x1b[38;2;80;250;123m", // #50fa7b
    YELLOW: "\x1b[38;2;241;250;140m", // #f1fa8c
    RED: "\x1b[38;2;255;85;85m", // #ff5555
    MAGENTA: "\x1b[38;2;189;147;249m", // #bd93f9
    RESET: "\x1b[0m",
  },
  gruvbox: {
    DIM: "\x1b[38;2;146;131;116m", // #928374
    CYAN: "\x1b[38;2;142;192;124m", // #8ec07c
    GREEN: "\x1b[38;2;184;187;38m", // #b8bb26
    YELLOW: "\x1b[38;2;250;189;47m", // #fabd2f
    RED: "\x1b[38;2;251;73;52m", // #fb4934
    MAGENTA: "\x1b[38;2;211;134;155m", // #d3869b
    RESET: "\x1b[0m",
  },
  "solarized-dark": {
    DIM: "\x1b[38;2;101;123;131m", // #657b83
    CYAN: "\x1b[38;2;42;161;152m", // #2aa198
    GREEN: "\x1b[38;2;133;153;0m", // #859900
    YELLOW: "\x1b[38;2;181;137;0m", // #b58900
    RED: "\x1b[38;2;220;50;47m", // #dc322f
    MAGENTA: "\x1b[38;2;108;113;196m", // #6c71c4
    RESET: "\x1b[0m",
  },
};

const { DIM, CYAN, GREEN, YELLOW, RED, MAGENTA, RESET } = THEMES.default;

/**
 * Get color scheme palette by theme name
 * @param {string} [themeName]
 * @returns {typeof THEMES.default}
 */
function getThemeColors(themeName) {
  const name = String(themeName || "default").toLowerCase();
  return THEMES[name] || THEMES.default;
}

/**
 * Strip ANSI escape codes from string
 * @param {string} str
 * @returns {string}
 */
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Check if a Unicode code point is East Asian Fullwidth or Wide
 * @param {number} cp
 * @returns {boolean}
 */
function isWideCodePoint(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK Radicals, Kangxi, Ideographs, Hangul, Bopomofo, Kana
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) || // Vertical forms
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compatibility Forms
    (cp >= 0xff01 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth Signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // Miscellaneous Symbols and Pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Unified Ideographs Extension B/C/D/E/F/G
  );
}

/**
 * Calculate visual terminal display width taking East Asian characters into account
 * @param {string} str
 * @returns {number}
 */
function getStringWidth(str) {
  if (!str || typeof str !== "string") return 0;
  const clean = stripAnsi(str)
    .replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "")
    .replace(/\x1b\]0;[^\x07]*\x07/g, "");
  let width = 0;
  for (let i = 0; i < clean.length; i++) {
    const cp = clean.codePointAt(i);
    if (cp === undefined) continue;
    if (cp > 0xffff) {
      i++; // Skip low surrogate
    }
    // Ignore control characters
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) {
      continue;
    }
    width += isWideCodePoint(cp) ? 2 : 1;
  }
  return width;
}

/**
 * Middle-truncate a string symmetrically based on visual terminal column width.
 * Correctly accounts for CJK double-width characters so that truncation remains visually balanced.
 *
 * @param {string} str
 * @param {number} maxCols
 * @returns {string}
 */
function truncateMiddleByWidth(str, maxCols) {
  if (!str || typeof str !== "string") return "";
  const totalWidth = getStringWidth(str);
  if (totalWidth <= maxCols || maxCols < 4) return str;

  const targetWidth = maxCols - 3; // 3 columns for "..."
  const targetHead = Math.ceil(targetWidth / 2);
  const targetTail = targetWidth - targetHead;

  let head = "";
  let headWidth = 0;
  for (let i = 0; i < str.length; i++) {
    const cp = str.codePointAt(i);
    if (cp === undefined) continue;
    const charLen = cp > 0xffff ? 2 : 1;
    const w = isWideCodePoint(cp) ? 2 : 1;
    if (headWidth + w > targetHead) break;
    head += str.slice(i, i + charLen);
    headWidth += w;
    if (charLen === 2) i++;
  }

  let tail = "";
  let tailWidth = 0;
  for (let i = str.length - 1; i >= 0; i--) {
    let charStart = i;
    let cp = str.codePointAt(i);
    if (i > 0) {
      const prevCp = str.codePointAt(i - 1);
      if (prevCp !== undefined && prevCp > 0xffff) {
        charStart = i - 1;
        cp = prevCp;
      }
    }
    if (cp === undefined) continue;
    const charLen = cp > 0xffff ? 2 : 1;
    const w = isWideCodePoint(cp) ? 2 : 1;
    if (tailWidth + w > targetTail) break;
    tail = str.slice(charStart, charStart + charLen) + tail;
    tailWidth += w;
    if (charLen === 2) i--;
  }

  return `${head}...${tail}`;
}

const PROGRESS_BAR_STYLES = {
  blocks: { filled: "█", empty: "░" },
  smooth: { filled: "━", empty: "┈" },
  dots: { filled: "●", empty: "○" },
  ascii: { filled: "=", empty: "-" },
};

/**
 * Build a compact character progress bar
 * @param {number} pct (0 - 100)
 * @param {number} [length]
 * @param {string} [style]
 * @returns {string}
 */
function makeProgressBar(pct, length = 8, style = "blocks") {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const filled = Math.round((clamped / 100) * length);
  const empty = length - filled;
  const glyphs = PROGRESS_BAR_STYLES[style] || PROGRESS_BAR_STYLES.blocks;
  return `[${glyphs.filled.repeat(filled)}${glyphs.empty.repeat(empty)}]`;
}

/**
 * Format reset countdown time from resets_at timestamp / ISO string
 * @param {string | number | undefined} resetsAt
 * @returns {string} e.g. "2h15m", "45m", "3d4h"
 */
function formatCountdown(resetsAt) {
  if (!resetsAt) return "";

  let targetMs = 0;
  if (typeof resetsAt === "number") {
    targetMs = resetsAt < 1e11 ? resetsAt * 1000 : resetsAt;
  } else if (typeof resetsAt === "string") {
    const parsed = Date.parse(resetsAt);
    if (!isNaN(parsed)) {
      targetMs = parsed;
    } else {
      const num = Number(resetsAt);
      if (!isNaN(num)) {
        targetMs = num < 1e11 ? num * 1000 : num;
      }
    }
  }

  if (!targetMs) return "";

  const diffMs = targetMs - Date.now();
  if (diffMs <= 0) return "<1m";

  const totalSec = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);

  if (days > 0) {
    return `${days}d${hours}h`;
  } else if (hours > 0) {
    return `${hours}h${mins}m`;
  } else {
    return `${Math.max(1, mins)}m`;
  }
}

/**
 * Format a duration in milliseconds to human-readable string (e.g. 38m, 1h 24m, 2d 5h)
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (typeof ms !== "number" || isNaN(ms) || ms < 0) return "";
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  } else if (hours > 0) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  } else if (mins > 0) {
    return `${mins}m`;
  } else {
    return "<1m";
  }
}

/**
 * Read the last token usage from a transcript file without loading the entire file.
 * Reads backwards from the end of the file in chunks (up to 64KB) for maximum performance.
 *
 * @param {string} transcriptPath
 * @returns {number | null}
 */
function readLastUsageFromTranscript(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== "string") return null;

  let fd = null;
  try {
    if (!fs.existsSync(transcriptPath)) return null;
    const stat = fs.statSync(transcriptPath);
    if (stat.size === 0) return null;

    const CHUNK_SIZE = 64 * 1024; // 64KB buffer
    const readSize = Math.min(stat.size, CHUNK_SIZE);
    const buffer = Buffer.alloc(readSize);
    fd = fs.openSync(transcriptPath, "r");

    const offset = Math.max(0, stat.size - readSize);
    fs.readSync(fd, buffer, 0, readSize, offset);

    const chunkStr = buffer.toString("utf8");
    const lines = chunkStr.split("\n");
    const startIndex = offset > 0 ? 1 : 0;

    for (let i = lines.length - 1; i >= startIndex; i--) {
      const line = lines[i].trim();
      if (!line || !line.includes('"usage"')) continue;
      try {
        const rec = JSON.parse(line);
        const u = rec.message?.usage || rec.usage;
        if (u) {
          const total =
            (u.input_tokens || 0) +
            (u.cache_read_input_tokens || 0) +
            (u.cache_creation_input_tokens || 0) +
            (u.output_tokens || 0);
          return total;
        }
      } catch {}
    }
  } catch {
    // Ignore transcript reading errors gracefully
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }

  return null;
}

/**
 * Read the latest todo / task list state from a transcript file without loading the entire file.
 * Reads backwards from the end of the file in chunks (up to 64KB) for maximum performance.
 *
 * @param {string} transcriptPath
 * @returns {{ total: number, completed: number, inProgressTitle?: string } | null}
 */
function readLastTodosFromTranscript(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== "string") return null;

  let fd = null;
  try {
    if (!fs.existsSync(transcriptPath)) return null;
    const stat = fs.statSync(transcriptPath);
    if (stat.size === 0) return null;

    const CHUNK_SIZE = 64 * 1024; // 64KB buffer
    const readSize = Math.min(stat.size, CHUNK_SIZE);
    const buffer = Buffer.alloc(readSize);
    fd = fs.openSync(transcriptPath, "r");

    const offset = Math.max(0, stat.size - readSize);
    fs.readSync(fd, buffer, 0, readSize, offset);

    const chunkStr = buffer.toString("utf8");
    const lines = chunkStr.split("\n");
    const startIndex = offset > 0 ? 1 : 0;

    for (let i = lines.length - 1; i >= startIndex; i--) {
      const line = lines[i].trim();
      if (!line || (!line.includes('"todos"') && !line.includes('"TodoWrite"') && !line.includes('"Task'))) {
        continue;
      }

      try {
        const rec = JSON.parse(line);
        let list = null;

        if (Array.isArray(rec.todos)) {
          list = rec.todos;
        } else if (Array.isArray(rec.input?.todos)) {
          list = rec.input.todos;
        } else if (Array.isArray(rec.tool_use?.input?.todos)) {
          list = rec.tool_use.input.todos;
        } else if (Array.isArray(rec.tasks)) {
          list = rec.tasks;
        } else {
          // Check message content array for tool_use blocks
          const contentArr = Array.isArray(rec.message?.content)
            ? rec.message.content
            : Array.isArray(rec.content)
            ? rec.content
            : null;

          if (contentArr) {
            for (const item of contentArr) {
              if (item && typeof item === "object") {
                if (Array.isArray(item.input?.todos)) {
                  list = item.input.todos;
                  break;
                } else if (Array.isArray(item.todos)) {
                  list = item.todos;
                  break;
                } else if (Array.isArray(item.input?.tasks)) {
                  list = item.input.tasks;
                  break;
                }
              }
            }
          }
        }

        if (Array.isArray(list) && list.length > 0) {
          const total = list.length;
          let completed = 0;
          let inProgressTitle = "";

          for (const item of list) {
            if (!item || typeof item !== "object") continue;
            const status = String(item.status || "").toLowerCase();
            if (status === "completed" || status === "done" || item.completed === true) {
              completed++;
            } else if (status === "in_progress" || status === "active" || status === "running") {
              inProgressTitle = item.content || item.subject || item.title || "";
            }
          }

          return { total, completed, inProgressTitle };
        }
      } catch {}
    }
  } catch {
    // Ignore transcript reading errors gracefully
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }

  return null;
}

const sessionDeltaMemCache = new Map();

/**
 * Track session token usage across turns and calculate single-turn token growth delta.
 * Stores lightweight state in OS temp directory keyed by session ID hash.
 *
 * @param {string | undefined} sessionId
 * @param {number | null} currentTokens
 * @returns {number | null} Token increase since last turn, or null if first turn / unavailable
 */
function getSessionDelta(sessionId, currentTokens) {
  if (!sessionId || typeof sessionId !== "string" || typeof currentTokens !== "number" || currentTokens <= 0) {
    return null;
  }

  const sid = sessionId.trim();
  const memKey = `${sid}:${currentTokens}`;
  if (sessionDeltaMemCache.has(memKey)) {
    return sessionDeltaMemCache.get(memKey);
  }

  const hash = crypto.createHash("sha1").update(sid).digest("hex").slice(0, 16);
  const sessionFile = path.join(os.tmpdir(), `ccs-sess-${hash}.json`);

  let delta = null;
  let recentDeltas = [];
  try {
    if (fs.existsSync(sessionFile)) {
      const data = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      if (Array.isArray(data.recentDeltas)) {
        recentDeltas = data.recentDeltas.slice(-5);
      }
      if (typeof data.lastTokens === "number" && currentTokens > data.lastTokens) {
        delta = currentTokens - data.lastTokens;
        recentDeltas.push(delta);
      }
    }
  } catch {}

  try {
    fs.writeFileSync(sessionFile, JSON.stringify({ lastTokens: currentTokens, recentDeltas, at: Date.now() }), "utf8");
  } catch {}

  sessionDeltaMemCache.set(memKey, delta);
  return delta;
}

/**
 * Estimate safe remaining conversation turns before context exhaustion based on recent turn deltas.
 *
 * @param {string | undefined} sessionId
 * @param {number | null} remainingTokens
 * @returns {number | null} Estimated remaining turns, or null if insufficient history / invalid
 */
function getContextRunway(sessionId, remainingTokens) {
  if (!sessionId || typeof sessionId !== "string" || typeof remainingTokens !== "number" || remainingTokens <= 0) {
    return null;
  }
  const sid = sessionId.trim();
  const hash = crypto.createHash("sha1").update(sid).digest("hex").slice(0, 16);
  const sessionFile = path.join(os.tmpdir(), `ccs-sess-${hash}.json`);
  try {
    if (fs.existsSync(sessionFile)) {
      const data = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      const deltas = Array.isArray(data.recentDeltas)
        ? data.recentDeltas.filter((d) => typeof d === "number" && d > 0)
        : [];
      if (deltas.length > 0) {
        const avg = deltas.reduce((sum, v) => sum + v, 0) / deltas.length;
        if (avg > 0) {
          return Math.max(0, Math.floor(remainingTokens / avg));
        }
      }
    }
  } catch {}
  return null;
}

const sessionCostDeltaMemCache = new Map();

/**
 * Track session cumulative cost across turns and calculate single-turn cost delta.
 *
 * @param {string | undefined} sessionId
 * @param {number | null} currentCostUsd
 * @returns {number | null} Cost increase since last turn, or null if first turn / unavailable
 */
function getSessionCostDelta(sessionId, currentCostUsd) {
  if (!sessionId || typeof sessionId !== "string" || typeof currentCostUsd !== "number" || currentCostUsd <= 0) {
    return null;
  }

  const sid = sessionId.trim();
  const memKey = `${sid}:${currentCostUsd}`;
  if (sessionCostDeltaMemCache.has(memKey)) {
    return sessionCostDeltaMemCache.get(memKey);
  }

  const hash = crypto.createHash("sha1").update(sid).digest("hex").slice(0, 16);
  const costFile = path.join(os.tmpdir(), `ccs-cost-${hash}.json`);

  let delta = null;
  try {
    if (fs.existsSync(costFile)) {
      const data = JSON.parse(fs.readFileSync(costFile, "utf8"));
      if (typeof data.lastCost === "number" && currentCostUsd > data.lastCost) {
        delta = currentCostUsd - data.lastCost;
      }
    }
  } catch {}

  try {
    fs.writeFileSync(costFile, JSON.stringify({ lastCost: currentCostUsd, at: Date.now() }), "utf8");
  } catch {}

  sessionCostDeltaMemCache.set(memKey, delta);
  return delta;
}

/**
 * Fast, zero-subprocess detection of git stash count.
 * Inspects `.git/logs/refs/stash` directly via filesystem.
 *
 * @param {string} cwd
 * @returns {number} Active stash count, or 0 if none/not a repo.
 */
function getGitStashCount(cwd) {
  if (!cwd || typeof cwd !== "string") return 0;

  try {
    let current = path.resolve(cwd);
    const root = path.parse(current).root;
    let gitPath = null;

    // Walk up looking for .git folder or file
    while (current) {
      const candidate = path.join(current, ".git");
      if (fs.existsSync(candidate)) {
        gitPath = candidate;
        break;
      }
      if (current === root) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    if (!gitPath) return 0;

    let commonGitDir = null;
    const stat = fs.statSync(gitPath);

    if (stat.isDirectory()) {
      commonGitDir = gitPath;
    } else if (stat.isFile()) {
      // Worktree or submodule: "gitdir: <path>"
      const content = fs.readFileSync(gitPath, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/i.exec(content);
      if (match) {
        let gitDirTarget = match[1].trim();
        if (!path.isAbsolute(gitDirTarget)) {
          gitDirTarget = path.resolve(path.dirname(gitPath), gitDirTarget);
        }
        // If inside a linked worktree, stash is stored in the common git dir
        const commondirFile = path.join(gitDirTarget, "commondir");
        if (fs.existsSync(commondirFile)) {
          const commonRel = fs.readFileSync(commondirFile, "utf8").trim();
          commonGitDir = path.resolve(gitDirTarget, commonRel);
        } else {
          commonGitDir = gitDirTarget;
        }
      }
    }

    if (!commonGitDir) return 0;

    const stashFile = path.join(commonGitDir, "logs", "refs", "stash");
    if (fs.existsSync(stashFile)) {
      const raw = fs.readFileSync(stashFile, "utf8").trim();
      if (!raw) return 0;
      return raw.split("\n").filter(Boolean).length;
    }
  } catch {}

  return 0;
}

const DEFAULT_FIELD_PRIORITIES = {
  // Critical warnings & alarms (highest priority: 100)
  surge: 100,
  surge_alert: 100,
  bloat: 100,
  bloat_alert: 100,
  compact: 100,
  compact_alert: 100,

  // Core status indicators (priority: 80)
  model: 80,
  context: 80,

  // Working tree (priority: 70)
  git: 70,

  // Cost & project location (priority: 60 - 50)
  cost: 60,
  project: 50,
  repo: 50,
  repository: 50,

  // Session & tasks (priority: 40)
  session_duration: 40,
  session: 40,
  duration: 40,
  todo: 40,
  tasks: 40,
  checklist: 40,
  todo_progress: 40,

  // Auxiliary metrics (priority: 35 - 10)
  api_duration: 35,
  api: 35,
  api_time: 35,
  fast: 30,
  fast_mode: 30,
  tokens: 25,
  token_breakdown: 25,
  lines: 25,
  velocity: 25,
  code_velocity: 25,
  speed: 20,
  tok_per_sec: 20,
  token_speed: 20,
  cache: 20,
  cache_efficiency: 20,
  rate_limit: 20,
  rate_limits: 20,
  mcp: 20,
  version: 10,
  cc_version: 10,
  cli_version: 10,
  session_id: 10,
  sid: 10,
  session_hash: 10,
  chat_id: 10,
  session_name: 10,
  name: 10,
  sname: 10,
  chat_name: 10,
};

/**
 * Apply two-stage responsive layout:
 * Stage 1: Soft compression on expandable items (e.g. branch, project)
 * Stage 2: Progressive dropping of lower priority fields with (+N) overflow badge
 * @param {Array<{ field: string, text: string }>} renderedItems
 * @param {Object} options
 * @param {number} options.terminalWidth
 * @param {string} options.delimiter
 * @param {string} [options.prefix]
 * @param {string} [options.suffix]
 * @param {string} [options.dimColor]
 * @param {string} [options.resetColor]
 * @param {Record<string, number>} [options.fieldPriorities]
 * @param {Function} [options.onSoftCompress]
 * @returns {string}
 */
function applyResponsiveLayout(renderedItems, options) {
  if (!Array.isArray(renderedItems) || renderedItems.length === 0) {
    const p = options.prefix || "";
    const s = options.suffix || "";
    return p + s;
  }

  const cols = options.terminalWidth;
  const delimiter = options.delimiter || " | ";
  const prefix = options.prefix || "";
  const suffix = options.suffix || "";
  const dimColor = options.dimColor || "\x1b[2m";
  const resetColor = options.resetColor || "\x1b[0m";
  const delimWidth = getStringWidth(delimiter);
  const prefixWidth = getStringWidth(prefix);
  const suffixWidth = getStringWidth(suffix);

  const priorities = {
    ...DEFAULT_FIELD_PRIORITIES,
    ...(options.fieldPriorities || {}),
  };

  // Helper to compute total width of an array of text segments plus optional overflow badge
  function computeLineWidth(texts, hiddenCount) {
    if (texts.length === 0) return prefixWidth + suffixWidth;
    let w = prefixWidth + suffixWidth;
    for (let i = 0; i < texts.length; i++) {
      w += getStringWidth(texts[i]);
    }
    if (texts.length > 1) {
      w += (texts.length - 1) * delimWidth;
    }
    if (hiddenCount > 0) {
      const badgeText = `(+${hiddenCount})`;
      w += delimWidth + getStringWidth(badgeText);
    }
    return w;
  }

  // Clone items
  let currentItems = renderedItems.map((item) => ({
    field: item.field,
    text: item.text,
    priority:
      typeof priorities[item.field.toLowerCase()] === "number"
        ? priorities[item.field.toLowerCase()]
        : 50,
  }));

  // Initial check: if already fits or cols <= 0, return standard line
  if (!cols || cols <= 0 || computeLineWidth(currentItems.map((it) => it.text), 0) <= cols) {
    const line = currentItems.map((it) => it.text).join(delimiter);
    return `${prefix}${line}${suffix}`;
  }

  // Stage 1: Soft Compression (if callback provided)
  if (typeof options.onSoftCompress === "function") {
    currentItems = options.onSoftCompress(currentItems, cols);
    if (computeLineWidth(currentItems.map((it) => it.text), 0) <= cols) {
      const line = currentItems.map((it) => it.text).join(delimiter);
      return `${prefix}${line}${suffix}`;
    }
  }

  // Stage 2: Progressive Dropping
  let hiddenCount = 0;
  while (currentItems.length > 1) {
    let lowestIdx = -1;
    let lowestPriority = Infinity;

    for (let i = 0; i < currentItems.length; i++) {
      const prio = currentItems[i].priority;
      if (prio < lowestPriority || (prio === lowestPriority && i > lowestIdx)) {
        lowestPriority = prio;
        lowestIdx = i;
      }
    }

    if (lowestIdx >= 0) {
      currentItems.splice(lowestIdx, 1);
      hiddenCount++;
    }

    // Check if remaining items + overflow badge fit
    if (computeLineWidth(currentItems.map((it) => it.text), hiddenCount) <= cols) {
      break;
    }
  }

  // Assemble final string
  let line = currentItems.map((it) => it.text).join(delimiter);
  if (hiddenCount > 0) {
    const badgeText = `${dimColor}(+${hiddenCount})${resetColor}`;
    // Only append badge if it doesn't cause line to exceed cols (unless line is already single item)
    if (computeLineWidth(currentItems.map((it) => it.text), hiddenCount) <= cols || currentItems.length === 1) {
      line = line ? `${line}${delimiter}${badgeText}` : badgeText;
    }
  }

  return `${prefix}${line}${suffix}`;
}

module.exports = {
  DIM,
  CYAN,
  GREEN,
  YELLOW,
  RED,
  MAGENTA,
  RESET,
  THEMES,
  getThemeColors,
  stripAnsi,
  getStringWidth,
  truncateMiddleByWidth,
  makeProgressBar,
  formatCountdown,
  formatDuration,
  readLastUsageFromTranscript,
  readLastTodosFromTranscript,
  getSessionDelta,
  getGitStashCount,
  PROGRESS_BAR_STYLES,
  getContextRunway,
  getSessionCostDelta,
  DEFAULT_FIELD_PRIORITIES,
  applyResponsiveLayout,
};
