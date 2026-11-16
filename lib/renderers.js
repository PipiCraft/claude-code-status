// @ts-check
"use strict";

const fs = require("fs");
const path = require("path");
const {
  DIM,
  CYAN,
  GREEN,
  YELLOW,
  RED,
  MAGENTA,
  RESET,
  makeProgressBar,
  formatCountdown,
  formatDuration,
  readLastUsageFromTranscript,
  readLastTodosFromTranscript,
} = require("./utils.js");
const { readGitStatus } = require("./git.js");
const { getMcpServerCount } = require("./mcp.js");
const { DEFAULT_RATE_LIMIT_WINDOWS } = require("./config.js");

const fallbackColors = { DIM, CYAN, GREEN, YELLOW, RED, MAGENTA, RESET };

/**
 * Resolve colors palette from context
 * @param {any} ctx
 * @returns {typeof fallbackColors}
 */
function getColors(ctx) {
  return ctx?.colors || fallbackColors;
}

/**
 * Field Renderers Map
 */
const FIELD_RENDERERS = {
  /**
   * Model name renderer with auto date cleaning and custom alias mapping
   */
  model: (context) => {
    const { input, config, icons } = context;
    const clr = getColors(context);
    const modelRaw =
      typeof input.model === "string"
        ? input.model
        : input.model?.display_name || input.model?.id || "Claude";
    let model = String(modelRaw).replace(/\[.*\]$/, "").trim();

    // 1. Direct match with user aliases
    if (config?.modelAliases && typeof config.modelAliases[model] === "string") {
      model = config.modelAliases[model];
    } else {
      // 2. Auto clean trailing date suffix (e.g. -20250219, -20241022)
      const cleaned = model.replace(/-\d{8}$/, "");
      if (config?.modelAliases && typeof config.modelAliases[cleaned] === "string") {
        model = config.modelAliases[cleaned];
      } else {
        model = cleaned;
      }
    }

    return `${clr.GREEN}${icons.model}${model}${clr.RESET}`;
  },

  /**
   * Context tokens & progress bar renderer
   */
  context: (context) => {
    const { input, config, icons } = context;
    const clr = getColors(context);
    let usedTokens = null;
    let totalTokens = null;
    const ctx = input.context_window;

    const parsedCw = Number(config.contextWindowSize);
    if (!isNaN(parsedCw) && parsedCw > 0) {
      totalTokens = parsedCw;
    } else if (
      ctx &&
      typeof ctx === "object" &&
      typeof ctx.context_window_size === "number" &&
      ctx.context_window_size > 0
    ) {
      totalTokens = ctx.context_window_size;
    }

    if (ctx && typeof ctx === "object") {
      if (typeof ctx.total_input_tokens === "number") {
        usedTokens = ctx.total_input_tokens;
      } else if (typeof ctx.used_percentage === "number" && totalTokens) {
        usedTokens = Math.round((ctx.used_percentage / 100) * totalTokens);
      } else if (typeof ctx.used_tokens === "number") {
        usedTokens = ctx.used_tokens;
      }
    }

    if (usedTokens === null && input.transcript_path) {
      usedTokens = readLastUsageFromTranscript(input.transcript_path);
    }

    if (!totalTokens) {
      const modelId = String(input.model?.id || input.model?.display_name || "").toLowerCase();
      if (/(?:\[1m\]|-1m|\b1m\b)/i.test(modelId)) {
        totalTokens = 1000000;
      } else {
        totalTokens = 200000;
      }
    }

    if (typeof usedTokens === "number" && totalTokens > 0) {
      const usedUnit = usedTokens >= 1000000 ? "M" : "k";
      const totalUnit = totalTokens >= 1000000 ? "M" : "k";
      const usedDisplay =
        usedUnit === "M"
          ? (usedTokens / 1000000).toFixed(1)
          : (usedTokens / 1000).toFixed(1);
      const totalDisplay =
        totalUnit === "M"
          ? (totalTokens / 1000000).toFixed(1)
          : (totalTokens / 1000).toFixed(1);
      const pct =
        ctx && typeof ctx.used_percentage === "number"
          ? Math.round(ctx.used_percentage)
          : Math.round((usedTokens / totalTokens) * 100);

      const warnThreshold = Number(config.warningThreshold) || 80;
      const dangerThreshold = Number(config.dangerThreshold) || 90;
      const barLen = Number(config.progressBarLength) || 8;
      const color =
        pct >= dangerThreshold
          ? clr.RED
          : pct >= warnThreshold
          ? clr.YELLOW
          : pct >= 50
          ? clr.CYAN
          : clr.GREEN;

      const barStr = config.progressBar ? `${makeProgressBar(pct, barLen)} ` : "";

      let compactAlertStr = "";
      if (config.showCompactAlert) {
        const compactThreshold = Number(config.compactAlertThreshold) || 80;
        if (pct >= compactThreshold) {
          compactAlertStr = ` ${clr.YELLOW}⚠️compact${clr.RESET}`;
        }
      }

      return `${color}${icons.context}${barStr}${pct}% (${usedDisplay}${usedUnit}/${totalDisplay}${totalUnit})${clr.RESET}${compactAlertStr}`;
    }
    return null;
  },

  /**
   * Prompt Cache Efficiency / Hit Rate (e.g. Cache:92% or Cache:0%)
   */
  cache: (context) => {
    const { input, icons } = context;
    const clr = getColors(context);
    const usage = input.context_window?.current_usage;
    if (usage && typeof usage === "object") {
      const cacheRead =
        typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
      const cacheCreation =
        typeof usage.cache_creation_input_tokens === "number"
          ? usage.cache_creation_input_tokens
          : 0;
      const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
      const total = cacheRead + cacheCreation + inputTokens;

      if (total > 0) {
        if (cacheRead > 0) {
          const hitRate = Math.round((cacheRead / total) * 100);
          const color = hitRate >= 70 ? clr.GREEN : hitRate >= 40 ? clr.CYAN : clr.DIM;
          return `${color}${icons.cache}Cache:${hitRate}%${clr.RESET}`;
        } else if (cacheCreation > 0 || inputTokens > 0) {
          return `${clr.DIM}${icons.cache}Cache:0%${clr.RESET}`;
        }
      }
    }
    return null;
  },

  /**
   * Session cost renderer with USD/CNY currency toggle & multiplier
   */
  cost: (context) => {
    const { input, config, icons } = context;
    const clr = getColors(context);
    if (typeof input.cost?.total_cost_usd === "number") {
      const rawUsd = input.cost.total_cost_usd;
      const numMultiplier = Number(config.costMultiplier);
      const multiplier = !isNaN(numMultiplier) && numMultiplier > 0 ? numMultiplier : 1.0;
      const numRate = Number(config.exchangeRate);
      const rate = !isNaN(numRate) && numRate > 0 ? numRate : 7.25;

      const effectiveUsd = rawUsd * multiplier;
      const effectiveCny = effectiveUsd * rate;

      const fmt = (num) => {
        if (num === 0) return "0.00";
        if (num >= 1) return num.toFixed(2);
        if (num >= 0.01) return num.toFixed(2);
        return num.toFixed(3);
      };

      let costText = "";
      const cur = (config.currency || "USD").toUpperCase();

      if (cur === "CNY") {
        costText = `¥${fmt(effectiveCny)}`;
      } else if (cur === "BOTH") {
        costText = `$${fmt(effectiveUsd)} (¥${fmt(effectiveCny)})`;
      } else {
        costText = `$${fmt(effectiveUsd)}`;
      }

      if (config.showCostMultiplier && multiplier !== 1) {
        costText += ` ${clr.DIM}(x${multiplier})${clr.RESET}`;
      }

      const warnThreshold = Number(config.costWarningThreshold) || 1.0;
      const dangerThreshold = Number(config.costDangerThreshold) || 5.0;
      const costColor =
        effectiveUsd >= dangerThreshold
          ? clr.RED
          : effectiveUsd >= warnThreshold
          ? clr.YELLOW
          : clr.GREEN;

      return `${costColor}${icons.cost}${costText}${clr.RESET}`;
    }
    return null;
  },

  /**
   * Code velocity (lines added / removed e.g. +142/-35)
   */
  lines: (context) => {
    const { input } = context;
    const clr = getColors(context);
    const added = input.cost?.total_lines_added;
    const removed = input.cost?.total_lines_removed;
    if (typeof added === "number" || typeof removed === "number") {
      const a = added || 0;
      const r = removed || 0;
      if (a > 0 || r > 0) {
        return `${clr.GREEN}+${a}${clr.RESET}/${clr.RED}-${r}${clr.RESET}`;
      }
    }
    return null;
  },

  /**
   * Rate Limits quota renderer (configurable cycles e.g. ["5h", "7d", "mo"] + reset countdown)
   */
  rate_limit: (context) => {
    const { input, config, icons } = context;
    const clr = getColors(context);
    const rl = input.rate_limits;
    if (!rl || typeof rl !== "object") return null;

    const requestedWindows = Array.isArray(config.rateLimitWindows)
      ? config.rateLimitWindows
      : DEFAULT_RATE_LIMIT_WINDOWS;

    const items = [];
    const warnThresh = Number(config.warningThreshold) || 80;
    const dangerThresh = Number(config.dangerThreshold) || 90;
    const showCountdown = config.showRateLimitCountdown !== false;

    for (const winKey of requestedWindows) {
      const key = String(winKey).toLowerCase();
      let entry = null;
      let label = "";

      if (key === "5h" || key === "five_hour" || key === "5_hour") {
        entry = rl.five_hour || rl["5h"] || rl["5_hour"];
        label = "5h";
      } else if (key === "7d" || key === "seven_day" || key === "weekly" || key === "7_day") {
        entry = rl.seven_day || rl["7d"] || rl.weekly || rl["7_day"];
        label = "7d";
      } else if (
        key === "mo" ||
        key === "monthly" ||
        key === "month" ||
        key === "30d" ||
        key === "thirty_day"
      ) {
        entry = rl.monthly || rl.month || rl.thirty_day || rl["30d"];
        label = "mo";
      }

      if (entry && typeof entry.used_percentage === "number") {
        const pct = Math.round(entry.used_percentage);
        let trendStr = "";
        let paceStr = "";
        let isBurning = false;

        if (entry.resets_at) {
          let windowMs = 0;
          if (label === "5h") windowMs = 5 * 3600 * 1000;
          else if (label === "7d") windowMs = 7 * 86400 * 1000;
          else if (label === "mo") windowMs = 30 * 86400 * 1000;

          if (windowMs > 0) {
            let targetMs = 0;
            if (typeof entry.resets_at === "number") {
              targetMs = entry.resets_at < 1e11 ? entry.resets_at * 1000 : entry.resets_at;
            } else if (typeof entry.resets_at === "string") {
              const parsed = Date.parse(entry.resets_at);
              if (!isNaN(parsed)) {
                targetMs = parsed;
              } else {
                const num = Number(entry.resets_at);
                if (!isNaN(num)) {
                  targetMs = num < 1e11 ? num * 1000 : num;
                }
              }
            }

            if (targetMs > 0) {
              const remainingMs = Math.max(0, targetMs - Date.now());
              const elapsedMs = Math.max(0, windowMs - remainingMs);
              const timePct = (elapsedMs / windowMs) * 100;
              const usedPct = entry.used_percentage;
              const diff = usedPct - timePct;

              if (config.showRateLimitTrend) {
                if (diff > 5) {
                  trendStr = "↑";
                } else if (diff < -5) {
                  trendStr = "↓";
                }
              }

              if (diff >= 15) {
                isBurning = true;
                if (config.showRateLimitPace) {
                  paceStr = "⚡";
                }
              }
            }
          }
        }

        const color =
          pct >= dangerThresh || (isBurning && pct >= 70)
            ? clr.RED
            : pct >= warnThresh || (isBurning && pct >= 45)
            ? clr.YELLOW
            : clr.DIM;

        let countdownStr = "";
        if (showCountdown && entry.resets_at) {
          const cd = formatCountdown(entry.resets_at);
          if (cd) {
            countdownStr = `(${cd})`;
          }
        }

        items.push(`${color}${icons.rate}${label}:${pct}%${trendStr}${paceStr}${countdownStr}${clr.RESET}`);
      }
    }

    return items.length > 0 ? items.join(" ") : null;
  },

  /**
   * Project directory renderer
   */
  project: (context) => {
    const { project, input, config, cwd } = context;
    const clr = getColors(context);
    let displayName = project;

    if (config?.projectPathMode === "relative" && input?.workspace?.project_dir && cwd) {
      const projDir = input.workspace.project_dir;
      const rel = path.relative(projDir, cwd).replace(/\\/g, "/");
      if (rel && rel !== ".") {
        displayName = `${path.basename(projDir)}:${rel}`;
      }
    }

    if (config?.clickableProjectPath && cwd) {
      const normalizedPath = cwd.replace(/\\/g, "/");
      const fileUri = normalizedPath.startsWith("/") ? `file://${normalizedPath}` : `file:///${normalizedPath}`;
      displayName = `\x1b]8;;${fileUri}\x1b\\${displayName}\x1b]8;;\x1b\\`;
    }

    let addedDirsBadge = "";
    const addedDirs = input?.workspace?.added_dirs;
    if (Array.isArray(addedDirs) && addedDirs.length > 0) {
      addedDirsBadge = ` ${clr.DIM}(+${addedDirs.length} dirs)${clr.RESET}`;
    }

    return `${clr.CYAN}${displayName}${clr.RESET}${addedDirsBadge}`;
  },

  /**
   * Git branch & dirty status (with optional ahead/behind difference)
   */
  git: (context) => {
    const { cwd, config, icons, input } = context;
    const clr = getColors(context);
    const out = readGitStatus(cwd, config.gitCacheTtl);
    if (out === null) return null;

    const lines = out.split("\n");
    const branchMatch = (lines[0] || "").match(/^## (?:No commits yet on )?(\S+?)(?:\.\.\.|\s|$)/);
    let branch = branchMatch ? branchMatch[1] : "";
    if (!branch) return null;

    let gitOpState = "";
    try {
      let gitDir = path.join(cwd, ".git");
      if (fs.existsSync(gitDir)) {
        const stat = fs.statSync(gitDir);
        if (stat.isFile()) {
          const content = fs.readFileSync(gitDir, "utf8").trim();
          const match = content.match(/^gitdir:\s*(.+)$/i);
          if (match) {
            gitDir = path.resolve(cwd, match[1].trim());
          }
        }
        if (branch === "HEAD") {
          const headFile = path.join(gitDir, "HEAD");
          if (fs.existsSync(headFile)) {
            const headContent = fs.readFileSync(headFile, "utf8").trim();
            if (/^[0-9a-f]{40}$/i.test(headContent)) {
              branch = `HEAD@${headContent.slice(0, 7)}`;
            }
          }
        }
        if (
          fs.existsSync(path.join(gitDir, "rebase-merge")) ||
          fs.existsSync(path.join(gitDir, "rebase-apply"))
        ) {
          gitOpState = ` ${clr.YELLOW}(rebasing)${clr.RESET}`;
        } else if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) {
          gitOpState = ` ${clr.YELLOW}(merging)${clr.RESET}`;
        } else if (fs.existsSync(path.join(gitDir, "CHERRY_PICK_HEAD"))) {
          gitOpState = ` ${clr.YELLOW}(cherry-pick)${clr.RESET}`;
        }
      }
    } catch {}

    const maxLen = Number(config?.maxBranchLength);
    if (!isNaN(maxLen) && maxLen > 0 && branch.length > maxLen) {
      const headLen = Math.ceil((maxLen - 3) / 2);
      const tailLen = Math.floor((maxLen - 3) / 2);
      branch = `${branch.slice(0, headLen)}...${branch.slice(-tailLen)}`;
    }

    let worktreePrefix = "";
    const wt = input?.worktree || input?.workspace?.git_worktree;
    if (typeof wt === "string" && wt.trim()) {
      worktreePrefix = `(wt: ${wt.trim()}) `;
    } else if (wt && typeof wt.name === "string" && wt.name.trim()) {
      worktreePrefix = `(wt: ${wt.name.trim()}) `;
    } else if (wt === true) {
      worktreePrefix = "(wt) ";
    }

    let statsMarker = "";
    if (config?.showGitStatusStats) {
      let staged = 0;
      let unstaged = 0;
      let untracked = 0;
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.length < 2) continue;
        const x = line[0];
        const y = line[1];
        if (x === "?" && y === "?") {
          untracked++;
        } else {
          if (x !== " " && x !== "?") staged++;
          if (y !== " " && y !== "?") unstaged++;
        }
      }
      const parts = [];
      if (staged > 0) parts.push(`${clr.GREEN}+${staged}${clr.RESET}`);
      if (unstaged > 0) parts.push(`${clr.YELLOW}*${unstaged}${clr.RESET}`);
      if (untracked > 0) parts.push(`${clr.DIM}?${untracked}${clr.RESET}`);
      if (parts.length > 0) {
        statsMarker = ` ${parts.join(" ")}`;
      }
    } else {
      const dirty = lines.slice(1).some((l) => l.trim().length > 0);
      if (dirty) statsMarker = "*";
    }

    let aheadBehind = "";
    if (config.showGitAheadBehind) {
      const aheadMatch = (lines[0] || "").match(/ahead (\d+)/);
      const behindMatch = (lines[0] || "").match(/behind (\d+)/);
      if (aheadMatch) aheadBehind += ` ↑${aheadMatch[1]}`;
      if (behindMatch) aheadBehind += ` ↓${behindMatch[1]}`;
    }

    return `${clr.MAGENTA}${icons.git}${worktreePrefix}${branch}${aheadBehind}${gitOpState}${statsMarker}${clr.RESET}`;
  },

  /**
   * MCP Server count (e.g. MCP:3)
   */
  mcp: (context) => {
    const { cwd, icons } = context;
    const clr = getColors(context);
    const count = getMcpServerCount(cwd);
    if (count > 0) {
      return `${clr.CYAN}${icons.mcp}MCP:${count}${clr.RESET}`;
    }
    return null;
  },

  /**
   * Reasoning effort renderer (e.g. Claude 3.7)
   */
  effort: (context) => {
    const { input } = context;
    const clr = getColors(context);
    const level = input.effort?.level;
    if (level && level !== "none" && level !== "default") {
      return `${clr.DIM}[effort: ${level}]${clr.RESET}`;
    }
    return null;
  },

  /**
   * Output style tag renderer (e.g. [concise])
   */
  output_style: (context) => {
    const { input } = context;
    const clr = getColors(context);
    const styleName =
      typeof input.output_style === "string" ? input.output_style : input.output_style?.name;
    if (styleName && styleName !== "default") {
      return `${clr.DIM}[${styleName}]${clr.RESET}`;
    }
    return null;
  },

  /**
   * Session duration renderer (e.g. 38m, 1h 24m)
   */
  session_duration: (context) => {
    const { input, config } = context;
    const clr = getColors(context);
    let durationMs = null;

    if (typeof input.cost?.total_duration_ms === "number" && input.cost.total_duration_ms > 0) {
      durationMs = input.cost.total_duration_ms;
    } else if (typeof input.cost?.duration_ms === "number" && input.cost.duration_ms > 0) {
      durationMs = input.cost.duration_ms;
    } else if (typeof input.total_duration_ms === "number" && input.total_duration_ms > 0) {
      durationMs = input.total_duration_ms;
    } else if (typeof input.session_duration_ms === "number" && input.session_duration_ms > 0) {
      durationMs = input.session_duration_ms;
    } else if (input.transcript_path && typeof input.transcript_path === "string") {
      try {
        if (fs.existsSync(input.transcript_path)) {
          const stat = fs.statSync(input.transcript_path);
          const birth = stat.birthtimeMs || stat.ctimeMs;
          if (birth && birth > 0) {
            durationMs = Math.max(0, Date.now() - birth);
          }
        }
      } catch {}
    }

    if (durationMs !== null) {
      let text = formatDuration(durationMs);
      if (text) {
        if (config?.showApiDuration) {
          const apiMs =
            typeof input.cost?.total_api_duration_ms === "number" &&
            input.cost.total_api_duration_ms > 0
              ? input.cost.total_api_duration_ms
              : typeof input.total_api_duration_ms === "number" && input.total_api_duration_ms > 0
              ? input.total_api_duration_ms
              : null;
          if (apiMs !== null) {
            const apiText = formatDuration(apiMs);
            if (apiText) {
              text += ` (api: ${apiText})`;
            }
          }
        }
        return `${clr.DIM}${text}${clr.RESET}`;
      }
    }
    return null;
  },

  /**
   * Pure API response generation duration renderer (e.g. api:12m)
   */
  api_duration: (context) => {
    const { input } = context;
    const clr = getColors(context);
    const apiMs =
      typeof input.cost?.total_api_duration_ms === "number" && input.cost.total_api_duration_ms > 0
        ? input.cost.total_api_duration_ms
        : typeof input.total_api_duration_ms === "number" && input.total_api_duration_ms > 0
        ? input.total_api_duration_ms
        : typeof input.cost?.api_duration_ms === "number" && input.cost.api_duration_ms > 0
        ? input.cost.api_duration_ms
        : null;

    if (apiMs !== null) {
      const text = formatDuration(apiMs);
      if (text) {
        return `${clr.DIM}api:${text}${clr.RESET}`;
      }
    }
    return null;
  },

  /**
   * Token breakdown renderer (e.g. I:12k C:320k O:18k)
   */
  tokens: (context) => {
    const { input } = context;
    const clr = getColors(context);
    const ctx = input.context_window;
    if (!ctx || typeof ctx !== "object") return null;

    const usage = ctx.current_usage;
    let inTok = null;
    let outTok = null;
    let cacheTok = null;
    let thinkTok = null;

    if (usage && typeof usage === "object") {
      if (typeof usage.input_tokens === "number") inTok = usage.input_tokens;
      if (typeof usage.output_tokens === "number") outTok = usage.output_tokens;
      if (typeof usage.thinking_tokens === "number") thinkTok = usage.thinking_tokens;
      const cacheRead =
        typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
      const cacheCreation =
        typeof usage.cache_creation_input_tokens === "number"
          ? usage.cache_creation_input_tokens
          : 0;
      if (cacheRead > 0 || cacheCreation > 0) {
        cacheTok = cacheRead + cacheCreation;
      }
    }

    if (inTok === null && typeof ctx.total_input_tokens === "number") {
      inTok = ctx.total_input_tokens;
    }
    if (outTok === null && typeof ctx.total_output_tokens === "number") {
      outTok = ctx.total_output_tokens;
    }
    if (thinkTok === null && typeof ctx.thinking_tokens === "number") {
      thinkTok = ctx.thinking_tokens;
    } else if (thinkTok === null && typeof ctx.total_thinking_tokens === "number") {
      thinkTok = ctx.total_thinking_tokens;
    }

    if (inTok === null && outTok === null && cacheTok === null && thinkTok === null) return null;

    const fmt = (num) => {
      if (typeof num !== "number") return "0";
      if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
      if (num >= 1000) return `${Math.round(num / 1000)}k`;
      return String(num);
    };

    const parts = [];
    if (inTok !== null) parts.push(`I:${fmt(inTok)}`);
    if (cacheTok !== null) parts.push(`C:${fmt(cacheTok)}`);
    if (thinkTok !== null && thinkTok > 0) parts.push(`T:${fmt(thinkTok)}`);
    if (outTok !== null) parts.push(`O:${fmt(outTok)}`);

    if (parts.length === 0) return null;
    return `${clr.DIM}${parts.join(" ")}${clr.RESET}`;
  },

  /**
   * Remote Git repository identifier (e.g. owner/repo)
   */
  repo: (context) => {
    const { input, project, config } = context;
    const clr = getColors(context);
    const r = input?.workspace?.repo;
    let repoName = "";
    let repoUrl = "";
    if (r && typeof r === "object") {
      if (r.owner && r.name) {
        repoName = `${r.owner}/${r.name}`;
        const host = r.host || "github.com";
        repoUrl = `https://${host}/${r.owner}/${r.name}`;
      } else if (r.name) {
        repoName = r.name;
      }
    }
    if (!repoName) {
      repoName = project;
    }
    if (config?.clickableRepoPath && repoUrl) {
      repoName = `\x1b]8;;${repoUrl}\x1b\\${repoName}\x1b]8;;\x1b\\`;
    }
    return `${clr.CYAN}${repoName}${clr.RESET}`;
  },

  /**
   * Claude Code Fast Mode indicator (e.g. ⚡fast)
   */
  fast: (context) => {
    const { input } = context;
    const clr = getColors(context);
    if (input?.fast_mode === true || input?.fast === true) {
      return `${clr.YELLOW}⚡fast${clr.RESET}`;
    }
    return null;
  },

  /**
   * Token generation speed / throughput (e.g. 85 t/s)
   */
  speed: (context) => {
    const { input } = context;
    const clr = getColors(context);
    const outTok = input?.context_window?.total_output_tokens;
    const apiMs =
      typeof input?.cost?.total_api_duration_ms === "number" && input.cost.total_api_duration_ms > 0
        ? input.cost.total_api_duration_ms
        : typeof input?.total_api_duration_ms === "number" && input.total_api_duration_ms > 0
        ? input.total_api_duration_ms
        : null;

    if (typeof outTok === "number" && outTok > 0 && apiMs !== null && apiMs >= 500) {
      const tokPerSec = Math.round(outTok / (apiMs / 1000));
      if (tokPerSec > 0) {
        return `${clr.DIM}${tokPerSec} t/s${clr.RESET}`;
      }
    }
    return null;
  },

  /**
   * Todo / Task progress tracker (e.g. todo: 2/5 or ✓ 5/5)
   */
  todo: (context) => {
    const { input, icons } = context;
    const clr = getColors(context);
    let total = 0;
    let completed = 0;

    // 1. Direct input payload (input.todos or input.tasks)
    const rawList = Array.isArray(input.todos)
      ? input.todos
      : Array.isArray(input.tasks)
      ? input.tasks
      : null;

    if (rawList && rawList.length > 0) {
      total = rawList.length;
      for (const item of rawList) {
        if (!item || typeof item !== "object") continue;
        const status = String(item.status || "").toLowerCase();
        if (status === "completed" || status === "done" || item.completed === true) {
          completed++;
        }
      }
    } else if (input.transcript_path) {
      // 2. Fallback to ultra-fast reverse scan of transcript
      const parsed = readLastTodosFromTranscript(input.transcript_path);
      if (parsed && parsed.total > 0) {
        total = parsed.total;
        completed = parsed.completed;
      }
    }

    if (total > 0) {
      const todoIcon = icons.todo || "";
      if (completed >= total) {
        return `${clr.GREEN}${todoIcon}✓ ${completed}/${total} todos${clr.RESET}`;
      }
      return `${clr.CYAN}${todoIcon}todo: ${completed}/${total}${clr.RESET}`;
    }
    return null;
  },

  /**
   * Standalone Auto-Compact Warning Alert (e.g. ⚠️compact when context >= 80%)
   */
  compact: (context) => {
    const { input, config } = context;
    const clr = getColors(context);
    let usedTokens = null;
    let totalTokens = null;
    const ctx = input.context_window;

    const parsedCw = Number(config.contextWindowSize);
    if (!isNaN(parsedCw) && parsedCw > 0) {
      totalTokens = parsedCw;
    } else if (ctx && typeof ctx.context_window_size === "number" && ctx.context_window_size > 0) {
      totalTokens = ctx.context_window_size;
    }

    if (ctx && typeof ctx === "object") {
      if (typeof ctx.total_input_tokens === "number") {
        usedTokens = ctx.total_input_tokens;
      } else if (typeof ctx.used_percentage === "number" && totalTokens) {
        usedTokens = Math.round((ctx.used_percentage / 100) * totalTokens);
      } else if (typeof ctx.used_tokens === "number") {
        usedTokens = ctx.used_tokens;
      }
    }

    if (usedTokens === null && input.transcript_path) {
      usedTokens = readLastUsageFromTranscript(input.transcript_path);
    }

    if (!totalTokens) {
      const modelId = String(input.model?.id || input.model?.display_name || "").toLowerCase();
      totalTokens = /(?:\[1m\]|-1m|\b1m\b)/i.test(modelId) ? 1000000 : 200000;
    }

    if (typeof usedTokens === "number" && totalTokens > 0) {
      const pct =
        ctx && typeof ctx.used_percentage === "number"
          ? Math.round(ctx.used_percentage)
          : Math.round((usedTokens / totalTokens) * 100);

      const threshold = Number(config.compactAlertThreshold) || 80;
      if (pct >= threshold) {
        const alertColor = pct >= 90 ? clr.RED : clr.YELLOW;
        return `${alertColor}⚠️compact${clr.RESET}`;
      }
    }
    return null;
  },
};

// Aliases
FIELD_RENDERERS.rate_limits = FIELD_RENDERERS.rate_limit;
FIELD_RENDERERS.velocity = FIELD_RENDERERS.lines;
FIELD_RENDERERS.code_velocity = FIELD_RENDERERS.lines;
FIELD_RENDERERS.cache_efficiency = FIELD_RENDERERS.cache;
FIELD_RENDERERS.style = FIELD_RENDERERS.output_style;
FIELD_RENDERERS.duration = FIELD_RENDERERS.session_duration;
FIELD_RENDERERS.session = FIELD_RENDERERS.session_duration;
FIELD_RENDERERS.api = FIELD_RENDERERS.api_duration;
FIELD_RENDERERS.api_time = FIELD_RENDERERS.api_duration;
FIELD_RENDERERS.tok_per_sec = FIELD_RENDERERS.speed;
FIELD_RENDERERS.token_speed = FIELD_RENDERERS.speed;
FIELD_RENDERERS.fast_mode = FIELD_RENDERERS.fast;
FIELD_RENDERERS.repository = FIELD_RENDERERS.repo;
FIELD_RENDERERS.token_breakdown = FIELD_RENDERERS.tokens;
FIELD_RENDERERS.tasks = FIELD_RENDERERS.todo;
FIELD_RENDERERS.checklist = FIELD_RENDERERS.todo;
FIELD_RENDERERS.todo_progress = FIELD_RENDERERS.todo;
FIELD_RENDERERS.compact_alert = FIELD_RENDERERS.compact;

module.exports = {
  FIELD_RENDERERS,
};
