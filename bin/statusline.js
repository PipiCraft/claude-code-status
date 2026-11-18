#!/usr/bin/env node
// @ts-check
"use strict";

/**
 * Claude Code Statusline
 * Zero-dependency, ultra-fast statusline renderer for Claude Code.
 */

const path = require("path");
const {
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
  makeProgressBar,
  formatCountdown,
  formatDuration,
  readLastUsageFromTranscript,
  applyResponsiveLayout,
  DEFAULT_FIELD_PRIORITIES,
} = require("../lib/utils.js");
const {
  DEFAULT_FIELDS,
  DEFAULT_RATE_LIMIT_WINDOWS,
  GIT_TIMEOUT_MS,
  DEFAULT_CONFIG,
  UI_PRESETS,
  DEFAULT_CONFIG_TEMPLATE,
  parseJsonWithComments,
  loadConfig,
} = require("../lib/config.js");
const { readGitStatus } = require("../lib/git.js");
const { getMcpServerCount } = require("../lib/mcp.js");
const { FIELD_RENDERERS } = require("../lib/renderers.js");

/**
 * Format a segment with capsule / pill wrapping, avoiding nested brackets
 * @param {string} text
 * @param {string} style
 * @param {string} dimColor
 * @param {string} resetColor
 * @returns {string}
 */
function formatSegmentCapsule(text, style, dimColor = "", resetColor = "") {
  if (!text || style === "none" || !style) return text;

  const raw = stripAnsi(text).trim();

  // If the segment already starts with an opening bracket/parenthesis (e.g. progress bar [██░░], session name [fix-auth]),
  // do not wrap it to prevent nested brackets.
  if (raw.startsWith("[") || raw.startsWith("(") || (raw.endsWith("]") && raw.includes("["))) {
    return text;
  }

  if (style === "round") {
    return `${dimColor}(${resetColor} ${text} ${dimColor})${resetColor}`;
  }
  return `${dimColor}[${resetColor} ${text} ${dimColor}]${resetColor}`;
}

/**
 * Render field segments with their field names
 * @param {string[]} fieldList
 * @param {any} context
 * @returns {Array<{ field: string, text: string }>}
 */
function renderFieldSegments(fieldList, context) {
  const parts = [];
  const capsuleStyle = context?.config?.capsuleStyle;
  const dimColor = context?.colors?.DIM || "";
  const resetColor = context?.colors?.RESET || "";

  for (const fieldName of fieldList) {
    const renderer = FIELD_RENDERERS[fieldName.toLowerCase()];
    if (typeof renderer === "function") {
      let part = renderer(context);
      if (part) {
        if (capsuleStyle && capsuleStyle !== "none") {
          part = formatSegmentCapsule(part, capsuleStyle, dimColor, resetColor);
        }
        parts.push({ field: fieldName, text: part });
      }
    }
  }
  return parts;
}

/**
 * Render list of fields into formatted string
 * @param {string[]} fieldList
 * @param {any} context
 * @param {string} delimiter
 * @returns {string}
 */
function renderFieldList(fieldList, context, delimiter) {
  const segments = renderFieldSegments(fieldList, context);
  return segments.map((s) => s.text).join(delimiter);
}

/**
 * Render list of fields using two-stage responsive degradation
 * @param {string[]} fieldList
 * @param {any} context
 * @param {string} delimiter
 * @param {number} cols
 * @returns {string}
 */
function renderFieldListResponsive(fieldList, context, delimiter, cols) {
  const segments = renderFieldSegments(fieldList, context);
  const cfg = context.config || {};
  return applyResponsiveLayout(segments, {
    terminalWidth: cols,
    delimiter,
    prefix: cfg.prefix || "",
    suffix: cfg.suffix || "",
    dimColor: context.colors.DIM,
    resetColor: context.colors.RESET,
    fieldPriorities: cfg.fieldPriorities,
    onSoftCompress: (items) => {
      return items.map((item) => {
        const lower = item.field.toLowerCase();
        if (lower === "git") {
          const minLen = Math.max(6, Number(cfg.responsiveMinBranchLength) || 8);
          let compressed = FIELD_RENDERERS.git({
            ...context,
            maxBranchLengthOverride: minLen,
          });
          if (compressed) {
            if (cfg.capsuleStyle && cfg.capsuleStyle !== "none") {
              compressed = formatSegmentCapsule(compressed, cfg.capsuleStyle, context.colors.DIM, context.colors.RESET);
            }
            return { ...item, text: compressed };
          }
        } else if (lower === "project") {
          let compressed = FIELD_RENDERERS.project({
            ...context,
            maxProjectLengthOverride: 12,
          });
          if (compressed) {
            if (cfg.capsuleStyle && cfg.capsuleStyle !== "none") {
              compressed = formatSegmentCapsule(compressed, cfg.capsuleStyle, context.colors.DIM, context.colors.RESET);
            }
            return { ...item, text: compressed };
          }
        }
        return item;
      });
    },
  });
}

/**
 * Render the statusline string from session input object
 * @param {any} [input]
 * @param {Partial<import("../lib/config.js").StatuslineConfig>} [customConfig]
 * @returns {string}
 */
function renderStatusline(input = {}, customConfig = {}) {
  const config = { ...loadConfig(), ...customConfig };
  const colors = getThemeColors(config.theme);
  const cwd = input.workspace?.current_dir || input.cwd || process.cwd();
  const project = path.basename(cwd) || cwd || "workspace";

  const iconSets = {
    unicode: {
      model: "✦ ",
      context: "\u26a1 ",
      cache: "\u26a1 ",
      cost: "",
      rate: "\u23f1 ",
      git: "\u2387 ",
      mcp: "\ud83d\udd0c ",
    },
    none: {
      model: "",
      context: "",
      cache: "",
      cost: "",
      rate: "",
      git: "",
      mcp: "",
    },
  };

  const icons = iconSets[config.icons || "none"] || iconSets.none;
  const context = { input, config, icons, colors, cwd, project };

  const rawDelimiter = typeof config.delimiter === "string" ? config.delimiter : "|";
  const delimiter = ` ${colors.DIM}${rawDelimiter.trim()}${colors.RESET} `;

  const activeFields = Array.isArray(config.fields) ? config.fields : DEFAULT_FIELDS;

  const cols =
    Number(config.terminalWidth) ||
    Number(input?.terminal_width) ||
    Number(input?.columns) ||
    process.stdout.columns ||
    process.stderr.columns ||
    Number(process.env.COLUMNS) ||
    100;

  const isResponsive =
    config.responsive === true ||
    String(config.responsive).toLowerCase() === "true" ||
    config.responsive === "auto";

  function renderTwoLines() {
    let line1Fields = config.line1;
    let line2Fields = config.line2;

    if (!Array.isArray(line1Fields) || !Array.isArray(line2Fields)) {
      const splitIdx = activeFields.indexOf("project");
      if (splitIdx > 0) {
        line1Fields = activeFields.slice(0, splitIdx);
        line2Fields = activeFields.slice(splitIdx);
      } else {
        const mid = Math.ceil(activeFields.length / 2);
        line1Fields = activeFields.slice(0, mid);
        line2Fields = activeFields.slice(mid);
      }
    }

    const line1Str = isResponsive
      ? renderFieldListResponsive(line1Fields, context, delimiter, cols)
      : renderFieldList(line1Fields, context, delimiter);
    const line2Str = isResponsive
      ? renderFieldListResponsive(line2Fields, context, delimiter, cols)
      : renderFieldList(line2Fields, context, delimiter);

    if (line1Str && line2Str) {
      return `${line1Str}\n${line2Str}`;
    }
    return line1Str || line2Str || "";
  }

  const isAuto = config.lines === "auto" || String(config.lines).toLowerCase() === "auto";
  const numLines = Number(config.lines);

  let result = "";
  if (numLines === 2) {
    result = renderTwoLines();
  } else if (isAuto) {
    const singleLine = isResponsive
      ? renderFieldListResponsive(activeFields, context, delimiter, cols)
      : renderFieldList(activeFields, context, delimiter);

    if (getStringWidth(singleLine) > cols) {
      result = renderTwoLines();
    } else {
      result = singleLine;
    }
  } else if (isResponsive) {
    result = renderFieldListResponsive(activeFields, context, delimiter, cols);
  } else {
    result = renderFieldList(activeFields, context, delimiter);
  }

  // Apply prefix & suffix for non-responsive rendering (responsive handles it internally)
  if (!isResponsive) {
    const p = config.prefix || "";
    const s = config.suffix || "";
    if (p || s) {
      result = result
        .split("\n")
        .map((line) => (line ? `${p}${line}${s}` : line))
        .join("\n");
    }
  }

  let titlePrefix = "";
  if (config.syncTerminalTitle) {
    const titleParts = [];
    if (context.project) {
      titleParts.push(context.project);
    }
    const sname = input.session_name || input.sessionTitle || input.session_title;
    if (sname && typeof sname === "string" && sname.trim()) {
      titleParts.push(`[${sname.trim()}]`);
    } else if (input.session_id && typeof input.session_id === "string") {
      titleParts.push(`[${input.session_id.trim().slice(0, 8)}]`);
    }
    const gitOut = readGitStatus(context.cwd, config.gitCacheTtl);
    if (gitOut) {
      const branchMatch = (gitOut.split("\n")[0] || "").match(/^## (?:No commits yet on )?(\S+?)(?:\.\.\.|\s|$)/);
      if (branchMatch && branchMatch[1] && branchMatch[1] !== "HEAD") {
        titleParts.push(`(${branchMatch[1]})`);
      }
    }
    const fullTitle = `Claude: ${titleParts.join(" ")}`;
    titlePrefix = `\x1b]0;${fullTitle}\x07`;
  }

  const useColor =
    config.colors !== false &&
    config.colors !== "false" &&
    config.color !== false &&
    config.color !== "false" &&
    !process.env.NO_COLOR;

  if (!useColor) {
    return stripAnsi(result);
  }
  return titlePrefix ? `${titlePrefix}${result}` : result;
}

/**
 * Main execution reading from stdin
 */
function run() {
  let raw = "";
  let finished = false;
  process.stdin.setEncoding("utf8");

  const complete = () => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdogTimer);

    let input = {};
    if (raw.trim()) {
      try {
        input = JSON.parse(raw);
      } catch (err) {
        // Silently proceed with empty input object
      }
    }

    const output = renderStatusline(input);
    if (output) {
      process.stdout.write(output + "\n");
    }
  };

  // Non-blocking safety watchdog: if pipe hangs without EOF for >1500ms, proceed safely with received data
  const watchdogTimer = setTimeout(complete, 1500);
  if (typeof watchdogTimer.unref === "function") {
    watchdogTimer.unref();
  }

  process.stdin.on("data", (chunk) => {
    raw += chunk;
  });

  process.stdin.on("end", complete);
}

if (require.main === module) {
  run();
}

module.exports = {
  renderFieldSegments,
  renderFieldList,
  renderStatusline,
  loadConfig,
  formatCountdown,
  formatDuration,
  getMcpServerCount,
  readGitStatus,
  makeProgressBar,
  readLastUsageFromTranscript,
  stripAnsi,
  getStringWidth,
  THEMES,
  getThemeColors,
  DEFAULT_FIELDS,
  DEFAULT_RATE_LIMIT_WINDOWS,
  GIT_TIMEOUT_MS,
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_TEMPLATE,
  UI_PRESETS,
  parseJsonWithComments,
  FIELD_RENDERERS,
  run,
};
