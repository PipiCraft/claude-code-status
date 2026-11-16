#!/usr/bin/env node
// @ts-check

/**
 * Claude Code Statusline CLI
 * Management tool for installing, previewing and configuring statusline.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  renderStatusline,
  run,
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_TEMPLATE,
  UI_PRESETS,
  parseJsonWithComments,
  readGitStatus,
} = require("./statusline.js");

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function getClaudeSettingsPath() {
  const home = os.homedir();
  const claudeDir = path.join(home, ".claude");
  const settingsPath = path.join(claudeDir, "settings.json");
  const configPath = path.join(claudeDir, "statusline.config.json");
  return { claudeDir, settingsPath, configPath };
}

function install(ifUnset = false) {
  const { claudeDir, settingsPath } = getClaudeSettingsPath();
  const statuslinePath = path.resolve(__dirname, "statusline.js").replace(/\\/g, "/");

  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  if (statuslinePath.includes("_npx") || statuslinePath.includes("npm-cache")) {
    console.log(`${YELLOW}⚠️  提示: 检测到当前正通过 npx 临时运行。${RESET}`);
    console.log(`${YELLOW}   为避免 npm 清理临时缓存后状态栏失效，建议全局安装：${CYAN}npm install -g claude-statusline${RESET}\n`);
  }

  let settings = {};
  let rawSettings = "";
  if (fs.existsSync(settingsPath)) {
    try {
      rawSettings = fs.readFileSync(settingsPath, "utf8");
      settings = JSON.parse(rawSettings || "{}");
    } catch (e) {
      console.error(`${RED}Failed to parse existing settings.json: ${e.message}${RESET}`);
      return;
    }
  }

  // postinstall path: never overwrite a statusLine the user already has
  if (ifUnset && settings.statusLine) {
    console.log(`${DIM}  Existing statusLine detected — skipping auto-configuration.${RESET}`);
    console.log(`${DIM}  Run "claude-code-status install" (or "ccs install") to overwrite it.${RESET}`);
    return;
  }

  if (rawSettings) {
    // Backup original settings
    const backupPath = path.join(claudeDir, "settings.json.bak");
    fs.writeFileSync(backupPath, rawSettings, "utf8");
    console.log(`${DIM}  Backup saved to ${backupPath}${RESET}`);
  }

  // Auto-generate annotated configuration file if it doesn't exist
  initConfig(false);

  settings.statusLine = {
    command: `node "${statuslinePath}"`,
    type: "command",
  };

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  console.log(`${GREEN}${BOLD}✔ Successfully configured claude-code-status (ccs)!${RESET}`);
  console.log(`  Target:  ${CYAN}${settingsPath}${RESET}`);
  console.log(`  Command: ${DIM}node "${statuslinePath}"${RESET}\n`);
  console.log(`Default fields enabled: ${GREEN}model, context, project, git${RESET}`);
  console.log(`Custom config created at: ${CYAN}${getClaudeSettingsPath().configPath}${RESET}`);
  console.log(`You can uncomment optional features (cost, rate_limit, cache, lines, mcp) anytime in this file.\n`);
  console.log(`Restart Claude Code to see your new statusline.`);
}

function uninstall() {
  const { settingsPath } = getClaudeSettingsPath();
  const statuslinePath = path.resolve(__dirname, "statusline.js").replace(/\\/g, "/");

  if (!fs.existsSync(settingsPath)) {
    console.log(`${YELLOW}settings.json not found, nothing to uninstall.${RESET}`);
    return;
  }

  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(raw || "{}");

    if (!settings.statusLine) {
      console.log(`${YELLOW}statusLine was not configured in settings.json.${RESET}`);
      return;
    }

    // Only remove a statusLine this tool installed; leave anyone else's alone
    const command = typeof settings.statusLine.command === "string" ? settings.statusLine.command : "";
    if (!command.includes(statuslinePath)) {
      console.log(`${YELLOW}statusLine is not managed by claude-code-status, leaving it untouched.${RESET}`);
      return;
    }

    delete settings.statusLine;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
    console.log(`${GREEN}${BOLD}✔ Successfully removed statusLine configuration from settings.json!${RESET}`);
  } catch (e) {
    console.error(`${RED}Failed to update settings.json: ${e.message}${RESET}`);
    process.exit(1);
  }
}

function initConfig(verbose = true) {
  const { claudeDir, configPath } = getClaudeSettingsPath();
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  if (fs.existsSync(configPath)) {
    if (verbose) {
      console.log(`${YELLOW}Config file already exists at ${configPath}${RESET}`);
    }
    return;
  }

  fs.writeFileSync(configPath, DEFAULT_CONFIG_TEMPLATE, "utf8");
  if (verbose) {
    console.log(`${GREEN}${BOLD}✔ Created annotated default config at:${RESET} ${CYAN}${configPath}${RESET}`);
    console.log(`Default fields enabled: ${GREEN}model, context, project, git${RESET}`);
    console.log(`Optional features (cost, rate_limit, cache, lines, mcp) are commented and ready to enable.`);
  }
}

function applyPreset(presetKey) {
  const preset = UI_PRESETS[presetKey];
  if (!preset) {
    console.log(`${RED}Unknown preset: ${presetKey}${RESET}`);
    console.log(`Available presets: ${Object.keys(UI_PRESETS).join(", ")}`);
    return;
  }

  const { configPath } = getClaudeSettingsPath();
  initConfig(false);

  try {
    let raw = fs.readFileSync(configPath, "utf8");

    // Update keys in the config string while preserving existing fields & comments.
    // The replacement must be a function: with a string replacement, `$&`, `$'`
    // or `$1` occurring inside the serialized value would be treated as
    // substitution patterns and corrupt the file.
    for (const [k, v] of Object.entries(preset.config)) {
      const reg = new RegExp(`("${k}"\\s*:\\s*)(true|false|\\d+|"(?:\\\\.|[^"\\\\])*"|[^,\\s]+)(\\s*,?)([^\\n]*)`);
      if (reg.test(raw)) {
        raw = raw.replace(reg, (_match, prefix, _val, comma, trailing) => `${prefix}${JSON.stringify(v)}${comma}${trailing}`);
      } else {
        raw = raw.replace(/(\n\s*)}(\s*)$/, (_match, indent, tail) => `,\n  "${k}": ${JSON.stringify(v)}${indent}}${tail}`);
      }
    }

    fs.writeFileSync(configPath, raw, "utf8");
    console.log(`${GREEN}${BOLD}✔ Successfully applied preset: ${preset.name}!${RESET}`);
    console.log(`${DIM}  Description: ${preset.description}${RESET}\n`);

    const sample = {
      workspace: { current_dir: path.resolve(__dirname, "..") },
      model: { display_name: "claude-3-7-sonnet" },
      context_window: { total_input_tokens: 58000, context_window_size: 200000 },
    };
    console.log(`${BOLD}Live preview with this UI preset:${RESET}`);
    console.log("  " + renderStatusline(sample).split("\n").join("\n  ") + "\n");
  } catch (e) {
    console.error(`${RED}Failed to update config: ${e.message}${RESET}`);
  }
}

function setDelimiter(newDelimiter) {
  if (typeof newDelimiter !== "string") {
    console.log(`${YELLOW}请提供分割符号，例如: claude-statusline delimiter / 或 claude-statusline delimiter "•"${RESET}`);
    return;
  }

  const { configPath } = getClaudeSettingsPath();
  initConfig(false);

  try {
    let raw = fs.readFileSync(configPath, "utf8");
    const reg = /("delimiter"\s*:\s*)(true|false|\d+|"(?:\\.|[^"\\])*"|[^,\s]+)(\s*,?)([^\n]*)/;
    if (reg.test(raw)) {
      raw = raw.replace(reg, (_match, prefix, _val, comma, trailing) => `${prefix}${JSON.stringify(newDelimiter)}${comma}${trailing}`);
    } else {
      raw = raw.replace(/(\n\s*)}(\s*)$/, (_match, indent, tail) => `,\n  "delimiter": ${JSON.stringify(newDelimiter)}${indent}}${tail}`);
    }

    fs.writeFileSync(configPath, raw, "utf8");
    console.log(`${GREEN}${BOLD}✔ 分割符号已成功设置为: ${JSON.stringify(newDelimiter)}！${RESET}\n`);

    const sample = {
      workspace: { current_dir: path.resolve(__dirname, "..") },
      model: { display_name: "claude-3-7-sonnet" },
      context_window: { total_input_tokens: 58000, context_window_size: 200000 },
    };
    console.log(`${BOLD}当前效果预览:${RESET}`);
    console.log("  " + renderStatusline(sample).split("\n").join("\n  ") + "\n");
  } catch (e) {
    console.error(`${RED}更新配置文件失败: ${e.message}${RESET}`);
  }
}

function parseTypedValue(key, val) {
  if (typeof val !== "string") return val;
  const trimmed = val.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;

  const arrayKeys = ["fields", "line2", "rateLimitWindows"];
  if (arrayKeys.includes(key)) {
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        return JSON.parse(trimmed);
      } catch {}
    }
    return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  }

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    try {
      return JSON.parse(trimmed);
    } catch {}
  }

  return trimmed;
}

function replaceJsoncProperty(raw, key, newVal) {
  // Check if key exists in raw
  const keyPattern = new RegExp(`"${key}"\\s*:`);
  const match = keyPattern.exec(raw);

  if (match) {
    const startIdx = match.index;
    const colonIdx = raw.indexOf(":", startIdx);
    let valStart = colonIdx + 1;
    while (valStart < raw.length && /\s/.test(raw[valStart])) {
      valStart++;
    }

    const firstChar = raw[valStart];
    if (firstChar === "[" || firstChar === "{") {
      const openChar = firstChar;
      const closeChar = openChar === "[" ? "]" : "}";
      let depth = 0;
      let inString = false;
      let inLineComment = false;
      let inBlockComment = false;
      let valEnd = -1;

      for (let i = valStart; i < raw.length; i++) {
        const ch = raw[i];
        const next = raw[i + 1];

        if (inString) {
          if (ch === "\\" && next) {
            i++; // skip escaped char
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }

        if (inLineComment) {
          if (ch === "\n") inLineComment = false;
          continue;
        }

        if (inBlockComment) {
          if (ch === "*" && next === "/") {
            inBlockComment = false;
            i++;
          }
          continue;
        }

        if (ch === '"') {
          inString = true;
          continue;
        }

        if (ch === "/" && next === "/") {
          inLineComment = true;
          i++;
          continue;
        }

        if (ch === "/" && next === "*") {
          inBlockComment = true;
          i++;
          continue;
        }

        if (ch === openChar) {
          depth++;
        } else if (ch === closeChar) {
          depth--;
          if (depth === 0) {
            valEnd = i + 1;
            break;
          }
        }
      }

      if (valEnd !== -1) {
        const formatted = Array.isArray(newVal)
          ? JSON.stringify(newVal, null, 2)
              .split("\n")
              .map((line, idx) => (idx === 0 ? line : `  ${line}`))
              .join("\n")
          : JSON.stringify(newVal);

        return raw.slice(0, valStart) + formatted + raw.slice(valEnd);
      }
    } else {
      // Scalar value (boolean, number, string)
      const scalarReg = new RegExp(
        `("${key}"\\s*:\\s*)(true|false|-?\\d+(?:\\.\\d+)?|"(?:\\\\.|[^"\\\\])*"|[^,\\r\\n]+)(\\s*,?)([^\\r\\n]*)`
      );
      if (scalarReg.test(raw)) {
        return raw.replace(
          scalarReg,
          (_match, prefix, _val, comma, trailing) => `${prefix}${JSON.stringify(newVal)}${comma}${trailing}`
        );
      }
    }
  }

  // If not found, append before closing }
  return raw.replace(
    /(\r?\n\s*)}(\s*)$/,
    (_match, indent, tail) => `,\n  "${key}": ${JSON.stringify(newVal)}${indent}}${tail}`
  );
}

function setConfig(key, rawValue) {
  if (!key || rawValue === undefined) {
    console.log(`${YELLOW}用法: ccs set <配置项> <值>${RESET}`);
    console.log(`例如: ccs set showGitStatusStats true`);
    console.log(`      ccs set lines 2`);
    console.log(`      ccs set delimiter " / "`);
    console.log(`      ccs set fields model,context,cost,git`);
    return;
  }

  const { configPath } = getClaudeSettingsPath();
  initConfig(false);

  const val = parseTypedValue(key, rawValue);

  try {
    let raw = fs.readFileSync(configPath, "utf8");
    raw = replaceJsoncProperty(raw, key, val);

    // Validate that the output is still valid JSONC
    parseJsonWithComments(raw);

    fs.writeFileSync(configPath, raw, "utf8");
    console.log(`${GREEN}${BOLD}✔ 配置更新成功:${RESET} ${CYAN}${key}${RESET} = ${GREEN}${JSON.stringify(val)}${RESET}\n`);

    const sample = {
      workspace: { current_dir: path.resolve(__dirname, "..") },
      model: { display_name: "claude-3-7-sonnet" },
      context_window: { total_input_tokens: 58000, context_window_size: 200000 },
      cost: { total_cost_usd: 0.185 },
    };
    console.log(`${BOLD}当前效果预览:${RESET}`);
    console.log("  " + renderStatusline(sample).split("\n").join("\n  ") + "\n");
  } catch (e) {
    console.error(`${RED}更新配置文件失败: ${e.message}${RESET}`);
  }
}

function toggleField(targetField) {
  if (!targetField) {
    console.log(`${YELLOW}用法: ccs toggle <字段名称>${RESET}`);
    console.log(`例如: ccs toggle todo, ccs toggle cost, ccs toggle fast`);
    console.log(`运行 ${CYAN}ccs help${RESET} 查看所有支持的字段列表。`);
    return;
  }

  const field = targetField.trim().toLowerCase();
  const { configPath } = getClaudeSettingsPath();
  initConfig(false);

  try {
    let raw = fs.readFileSync(configPath, "utf8");
    const parsed = parseJsonWithComments(raw);
    const currentFields = Array.isArray(parsed?.fields) ? [...parsed.fields] : [...DEFAULT_CONFIG.fields];

    const idx = currentFields.indexOf(field);
    let action = "enabled";
    if (idx >= 0) {
      currentFields.splice(idx, 1);
      action = "disabled";
    } else {
      currentFields.push(field);
      action = "enabled";
    }

    raw = replaceJsoncProperty(raw, "fields", currentFields);
    parseJsonWithComments(raw);

    fs.writeFileSync(configPath, raw, "utf8");
    const actionText = action === "enabled" ? `${GREEN}${BOLD}✔ 已启用字段:${RESET}` : `${YELLOW}${BOLD}✖ 已停用字段:${RESET}`;
    console.log(`\n${actionText} ${CYAN}${field}${RESET}`);
    console.log(`  当前生效字段 (${currentFields.length}): ${CYAN}${currentFields.join(", ")}${RESET}\n`);

    const sample = {
      workspace: { current_dir: path.resolve(__dirname, "..") },
      model: { display_name: "claude-3-7-sonnet" },
      context_window: {
        total_input_tokens: 58000,
        context_window_size: 200000,
        current_usage: { input_tokens: 10000, thinking_tokens: 4000, output_tokens: 2000 },
      },
      cost: { total_cost_usd: 0.185 },
      fast_mode: true,
      todos: [{ status: "completed" }, { status: "in_progress" }],
    };
    console.log(`${BOLD}当前效果预览:${RESET}`);
    console.log("  " + renderStatusline(sample).split("\n").join("\n  ") + "\n");
  } catch (e) {
    console.error(`${RED}切换字段失败: ${e.message}${RESET}`);
  }
}

function getConfig(key) {
  if (!key) {
    listConfig();
    return;
  }
  const { configPath } = getClaudeSettingsPath();
  let userConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      userConfig = parseJsonWithComments(fs.readFileSync(configPath, "utf8")) || {};
    } catch {}
  }

  if (Object.prototype.hasOwnProperty.call(userConfig, key)) {
    console.log(`${BOLD}${key}${RESET}: ${CYAN}${JSON.stringify(userConfig[key])}${RESET}`);
  } else if (Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) {
    console.log(`${BOLD}${key}${RESET}: ${DIM}${JSON.stringify(DEFAULT_CONFIG[key])} (default)${RESET}`);
  } else {
    console.log(`${YELLOW}未知配置项: ${key}${RESET}`);
    console.log(`运行 ${CYAN}ccs config list${RESET} 查看所有可用配置项。`);
  }
}

function listConfig() {
  const { configPath } = getClaudeSettingsPath();
  let userConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      userConfig = parseJsonWithComments(fs.readFileSync(configPath, "utf8")) || {};
    } catch {}
  }

  console.log(`\n${BOLD}Claude Code Statusline 配置 (${configPath}):${RESET}\n`);
  const keys = Array.from(new Set([...Object.keys(DEFAULT_CONFIG), ...Object.keys(userConfig)]));
  for (const k of keys) {
    const isCustom = Object.prototype.hasOwnProperty.call(userConfig, k);
    const val = isCustom ? userConfig[k] : DEFAULT_CONFIG[k];
    const marker = isCustom ? `${GREEN}✔ custom${RESET}` : `${DIM}default${RESET}`;
    console.log(`  ${BOLD}${k.padEnd(24)}${RESET} ${CYAN}${JSON.stringify(val)}${RESET}  [${marker}]`);
  }
  console.log(`\n使用 ${CYAN}ccs set <key> <value>${RESET} 修改任意配置项。\n`);
}

function exportConfig(targetPath) {
  const { configPath } = getClaudeSettingsPath();
  let content = "";
  if (fs.existsSync(configPath)) {
    content = fs.readFileSync(configPath, "utf8");
  } else {
    content = DEFAULT_CONFIG_TEMPLATE;
  }

  if (targetPath) {
    const resolved = path.resolve(process.cwd(), targetPath);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resolved, content, "utf8");
    console.log(`${GREEN}${BOLD}✔ 配置已成功导出至:${RESET} ${CYAN}${resolved}${RESET}`);
  } else {
    process.stdout.write(content + "\n");
  }
}

function importConfig(srcPath) {
  if (!srcPath) {
    console.log(`${YELLOW}用法: ccs import <配置文件路径>${RESET}`);
    console.log(`例如: ccs import my-statusline-config.json`);
    return;
  }

  const resolved = path.resolve(process.cwd(), srcPath);
  if (!fs.existsSync(resolved)) {
    console.log(`${RED}文件不存在: ${resolved}${RESET}`);
    return;
  }

  try {
    const raw = fs.readFileSync(resolved, "utf8");
    const parsed = parseJsonWithComments(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.log(`${RED}无效的配置文件: 根对象必须为 JSON 对象${RESET}`);
      return;
    }

    const { claudeDir, configPath } = getClaudeSettingsPath();
    if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });

    if (fs.existsSync(configPath)) {
      const backupPath = `${configPath}.bak`;
      fs.copyFileSync(configPath, backupPath);
      console.log(`${DIM}  原配置已备份至: ${backupPath}${RESET}`);
    }

    fs.writeFileSync(configPath, raw, "utf8");
    console.log(`${GREEN}${BOLD}✔ 配置文件导入成功！${RESET}`);
    console.log(`  目标路径: ${CYAN}${configPath}${RESET}\n`);

    const sample = {
      workspace: { current_dir: path.resolve(__dirname, "..") },
      model: { display_name: "claude-3-7-sonnet" },
      context_window: { total_input_tokens: 58000, context_window_size: 200000 },
    };
    console.log(`${BOLD}当前效果预览:${RESET}`);
    console.log("  " + renderStatusline(sample).split("\n").join("\n  ") + "\n");
  } catch (e) {
    console.error(`${RED}导入配置失败: ${e.message}${RESET}`);
  }
}

function resetConfig(type) {
  const { claudeDir, configPath } = getClaudeSettingsPath();
  const sub = String(type || "").toLowerCase();

  if (sub === "cache") {
    const cacheFile = path.join(claudeDir, ".git_cache.json");
    if (fs.existsSync(cacheFile)) {
      fs.unlinkSync(cacheFile);
      console.log(`${GREEN}${BOLD}✔ Git 状态缓存已清除。${RESET}`);
    } else {
      console.log(`${DIM}未发现残留的 Git 状态缓存文件。${RESET}`);
    }
    return;
  }

  if (sub === "config" || !sub || sub === "all") {
    if (fs.existsSync(configPath)) {
      const backupPath = `${configPath}.bak`;
      fs.copyFileSync(configPath, backupPath);
      console.log(`${DIM}  当前配置已备份至: ${backupPath}${RESET}`);
    }
    fs.writeFileSync(configPath, DEFAULT_CONFIG_TEMPLATE, "utf8");
    console.log(`${GREEN}${BOLD}✔ 配置已重置为默认模板！${RESET}`);
    console.log(`  配置文件: ${CYAN}${configPath}${RESET}\n`);

    const cacheFile = path.join(claudeDir, ".git_cache.json");
    if (fs.existsSync(cacheFile)) {
      try { fs.unlinkSync(cacheFile); } catch {}
    }
  } else {
    console.log(`${YELLOW}用法: ccs reset [config | cache | all]${RESET}`);
  }
}

function setTheme(newTheme) {
  const validThemes = ["default", "catppuccin", "nord", "tokyo"];
  if (!newTheme || !validThemes.includes(newTheme.toLowerCase())) {
    console.log(`${YELLOW}请指定有效的主题名称: ${validThemes.join(", ")}${RESET}`);
    console.log(`例如: claude-statusline theme catppuccin`);
    return;
  }

  const themeName = newTheme.toLowerCase();
  const { configPath } = getClaudeSettingsPath();
  initConfig(false);

  try {
    let raw = fs.readFileSync(configPath, "utf8");
    const reg = /("theme"\s*:\s*)(true|false|\d+|"(?:\\.|[^"\\])*"|[^,\s]+)(\s*,?)([^\n]*)/;
    if (reg.test(raw)) {
      raw = raw.replace(
        reg,
        (_match, prefix, _val, comma, trailing) =>
          `${prefix}${JSON.stringify(themeName)}${comma}${trailing}`
      );
    } else {
      raw = raw.replace(
        /(\n\s*)}(\s*)$/,
        (_match, indent, tail) => `,\n  "theme": ${JSON.stringify(themeName)}${indent}}${tail}`
      );
    }

    fs.writeFileSync(configPath, raw, "utf8");
    console.log(`${GREEN}${BOLD}✔ 主题已成功切换为: ${themeName}！${RESET}\n`);

    const sample = {
      workspace: { current_dir: path.resolve(__dirname, "..") },
      model: { display_name: "claude-3-7-sonnet" },
      context_window: { total_input_tokens: 58000, context_window_size: 200000 },
    };
    console.log(`${BOLD}当前主题效果预览:${RESET}`);
    console.log("  " + renderStatusline(sample).split("\n").join("\n  ") + "\n");
  } catch (e) {
    console.error(`${RED}更新配置文件失败: ${e.message}${RESET}`);
  }
}

function showUiPicker(targetArg) {
  const presetKeys = Object.keys(UI_PRESETS);

  if (targetArg) {
    const matched = presetKeys.find(
      (k, idx) => k.toLowerCase() === targetArg.toLowerCase() || String(idx + 1) === targetArg
    );
    if (matched) {
      applyPreset(matched);
      return;
    }
  }

  console.log(`\n${BOLD}Claude Code Statusline UI Presets (风格挑选):${RESET}\n`);

  const sample = {
    workspace: { current_dir: path.resolve(__dirname, "..") },
    model: { display_name: "claude-3-7-sonnet" },
    context_window: { total_input_tokens: 58000, context_window_size: 200000 },
  };

  presetKeys.forEach((key, idx) => {
    const p = UI_PRESETS[key];
    const previewLines = renderStatusline(sample, p.config).split("\n");
    console.log(`${CYAN}[${idx + 1}] ${BOLD}${p.name}${RESET} - ${DIM}${p.description}${RESET}`);
    console.log(previewLines.map((l) => `    ${l}`).join("\n") + "\n");
  });

  const { configPath } = getClaudeSettingsPath();
  let currentDelimiter = "|";
  try {
    if (fs.existsSync(configPath)) {
      const cfg = parseJsonWithComments(fs.readFileSync(configPath, "utf8"));
      if (typeof cfg.delimiter === "string") currentDelimiter = cfg.delimiter;
    }
  } catch {}

  const delimiterOptionIdx = presetKeys.length + 1;
  console.log(`${CYAN}[${delimiterOptionIdx}] ${BOLD}自定义分割符号 (当前: ${JSON.stringify(currentDelimiter)})${RESET} - ${DIM}输入任意分割符号 (如 /, •, ::, - 等)${RESET}\n`);

  if (process.stdin.isTTY) {
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${BOLD}请输入选项编号 [1-${delimiterOptionIdx}] 或名称: ${RESET}`, (answer) => {
      const trimmed = answer.trim();
      if (!trimmed) {
        rl.close();
        return;
      }
      if (trimmed === String(delimiterOptionIdx) || trimmed.toLowerCase() === "delimiter" || trimmed.toLowerCase() === "sep") {
        rl.question(`${BOLD}请输入新的分割符号 (回车确认): ${RESET}`, (newSep) => {
          rl.close();
          if (newSep) {
            setDelimiter(newSep);
          }
        });
        return;
      }
      rl.close();
      const chosen = presetKeys.find(
        (k, idx) => String(idx + 1) === trimmed || k.toLowerCase() === trimmed.toLowerCase()
      );
      if (chosen) {
        applyPreset(chosen);
      } else {
        console.log(`${YELLOW}未找到对应风格，保持原样。${RESET}`);
      }
    });
  } else {
    console.log(`${DIM}使用命令切换风格: claude-statusline ui <编号或名称>${RESET}`);
    console.log(`${DIM}使用命令修改分割符号: claude-statusline delimiter <符号>${RESET}`);
    console.log(`例如: claude-statusline delimiter / 或 claude-statusline delimiter "•"\n`);
  }
}

function preview() {
  console.log(`\n${BOLD}Claude Code Statusline Preview (Full Suite Showcase)${RESET}\n`);

  const repoDir = path.resolve(__dirname, "..");
  const now = Date.now();
  const resetIn2h15m = new Date(now + 2 * 3600 * 1000 + 15 * 60 * 1000).toISOString();
  const resetIn3d4h = new Date(now + (3 * 86400 + 4 * 3600) * 1000).toISOString();

  const sampleInput = {
    workspace: { current_dir: repoDir },
    model: { display_name: "claude-3-7-sonnet" },
    context_window: {
      total_input_tokens: 58000,
      context_window_size: 200000,
      current_usage: {
        input_tokens: 4640,
        cache_read_input_tokens: 53360,
      },
    },
    cost: {
      total_cost_usd: 0.185,
      total_lines_added: 185,
      total_lines_removed: 32,
      total_duration_ms: (1 * 3600 + 24 * 60) * 1000,
    },
    rate_limits: {
      five_hour: { used_percentage: 78, resets_at: resetIn2h15m },
      seven_day: { used_percentage: 42, resets_at: resetIn3d4h },
    },
    effort: { level: "high" },
  };

  const scenarios = [
    {
      title: "1. Default Out-of-the-Box Mode (Model, Context, Project, Git *)",
      input: sampleInput,
      config: {},
    },
    {
      title: "2. All Features Enabled (Cost, Multi-Quota, Cache Hit Rate, Velocity, MCP)",
      input: sampleInput,
      config: {
        fields: ["model", "context", "cost", "rate_limit", "cache", "project", "git", "lines", "mcp", "effort"],
        currency: "BOTH",
        showGitAheadBehind: false,
      },
    },
    {
      title: "3. Git Remote Sync (showGitAheadBehind: true -> main ↑2 ↓1*)",
      input: sampleInput,
      config: {
        fields: ["model", "context", "cost", "rate_limit", "cache", "project", "git", "lines", "mcp"],
        currency: "CNY",
        showGitAheadBehind: true,
      },
    },
    {
      title: "4. Dual-Line Layout (lines: 2) - Perfect for narrow/split terminals!",
      input: sampleInput,
      config: {
        fields: ["model", "context", "cost", "rate_limit", "cache", "project", "git", "lines", "mcp"],
        lines: 2,
        currency: "CNY",
        costMultiplier: 1.5,
        showCostMultiplier: true,
      },
    },
    {
      title: "5. Unicode Icons Mode (免字体通用符号: ✦, ⚡, ⎇, ⏱)",
      input: sampleInput,
      config: {
        fields: ["model", "context", "cost", "rate_limit", "cache", "project", "git", "lines", "mcp", "effort"],
        icons: "unicode",
        currency: "CNY",
      },
    },
    {
      title: "6. Catppuccin Theme + Model Alias (theme: 'catppuccin', modelAliases: Sonnet 3.7)",
      input: {
        ...sampleInput,
        model: { id: "claude-3-7-sonnet-20250219" },
      },
      config: {
        theme: "catppuccin",
        modelAliases: { "claude-3-7-sonnet": "Sonnet 3.7" },
        fields: ["model", "context", "cost", "project", "git"],
        currency: "BOTH",
      },
    },
    {
      title: "7. Tokyo Night Theme (theme: 'tokyo')",
      input: sampleInput,
      config: {
        theme: "tokyo",
        fields: ["model", "context", "cost", "rate_limit", "project", "git"],
        currency: "CNY",
      },
    },
    {
      title: "8. Extended Metrics (Tokens breakdown, Session duration, Rate limit burn rate ↑)",
      input: sampleInput,
      config: {
        fields: [
          "model",
          "context",
          "tokens",
          "session_duration",
          "rate_limit",
          "project",
          "git",
        ],
        showRateLimitTrend: true,
      },
    },
    {
      title: "9. Dot Minimalist Preset (ccs ui dot -> clean dot separators)",
      input: sampleInput,
      config: {
        delimiter: "•",
        fields: ["model", "context", "cost", "project", "git"],
        currency: "CNY",
      },
    },
    {
      title: "10. Compact Nano Preset (ccs ui compact -> ultra-narrow 60-col split terminals)",
      input: sampleInput,
      config: {
        delimiter: "•",
        progressBar: false,
        fields: ["model", "context", "cost", "project", "git"],
      },
    },
    {
      title: "11. Monorepo & Multi-Directory Workspace (+2 dirs & API calculation time)",
      input: {
        ...sampleInput,
        workspace: {
          project_dir: "/Users/dev/my-monorepo",
          current_dir: "/Users/dev/my-monorepo/packages/client",
          added_dirs: ["/Users/dev/shared-libs", "/Users/dev/docs"],
        },
        cost: {
          ...sampleInput.cost,
          total_duration_ms: 105 * 60 * 1000,
          total_api_duration_ms: 8 * 60 * 1000 + 35 * 1000,
        },
      },
      config: {
        fields: ["model", "context", "session_duration", "project", "git"],
        projectPathMode: "relative",
        showApiDuration: true,
      },
    },
    {
      title: "12. Git Detailed Stats & Speed Throughput (showGitStatusStats + speed + repo)",
      input: {
        ...sampleInput,
        workspace: {
          ...sampleInput.workspace,
          repo: { host: "github.com", owner: "PipiCraft", name: "claude-code-status" },
        },
        context_window: {
          ...sampleInput.context_window,
          total_output_tokens: 12500,
        },
        cost: {
          ...sampleInput.cost,
          total_api_duration_ms: 147000,
        },
      },
      config: {
        fields: ["model", "context", "speed", "repo", "git"],
        showGitStatusStats: true,
      },
    },
    {
      title: "13. Modern 1M Context & Rate Limit Pacing (1.0M window + ⚡burn pace alert)",
      input: {
        ...sampleInput,
        context_window: {
          context_window_size: 1000000,
          total_input_tokens: 185000,
          used_percentage: 18.5,
        },
        rate_limits: {
          five_hour: { used_percentage: 82, resets_at: new Date(now + 4 * 3600 * 1000).toISOString() },
        },
      },
      config: {
        fields: ["model", "context", "rate_limit", "project", "git"],
        showRateLimitPace: true,
      },
    },
    {
      title: "14. Round Bubble Preset (ccs ui round -> modern Nerd Font bubble style)",
      input: sampleInput,
      config: {
        ...UI_PRESETS.round.config,
        fields: ["model", "context", "cost", "project", "git"],
      },
    },
    {
      title: "15. Fast Mode & Hyperlinks (fast_mode: true + clickable paths)",
      input: {
        ...sampleInput,
        fast_mode: true,
        workspace: {
          ...sampleInput.workspace,
          repo: { host: "github.com", owner: "PipiCraft", name: "claude-code-status" },
        },
      },
      config: {
        fields: ["model", "fast", "context", "cost", "project", "repo", "git"],
        clickableProjectPath: true,
        clickableRepoPath: true,
      },
    },
    {
      title: "16. Todo Tracker, Thinking Tokens & Compact Alert (todo + T:8.5k + ⚠️compact)",
      input: {
        ...sampleInput,
        todos: [
          { content: "Setup database", status: "completed" },
          { content: "Add migration", status: "completed" },
          { content: "Run unit tests", status: "in_progress" },
        ],
        context_window: {
          ...sampleInput.context_window,
          context_window_size: 200000,
          total_input_tokens: 168000,
          current_usage: {
            input_tokens: 12000,
            cache_read_input_tokens: 140000,
            thinking_tokens: 8500,
            output_tokens: 2500,
          },
        },
      },
      config: {
        fields: ["model", "context", "todo", "tokens", "cost", "project", "git"],
        showCompactAlert: true,
      },
    },
  ];

  scenarios.forEach(({ title, input, config }) => {
    console.log(`${DIM}${title}${RESET}`);
    console.log(renderStatusline(input, config).split("\n").map(l => "  " + l).join("\n"));
    console.log();
  });
}

function doctor() {
  console.log(`\n${BOLD}claude-code-status (ccs) Health Doctor${RESET}\n`);
  let hasError = false;

  const { claudeDir, settingsPath, configPath } = getClaudeSettingsPath();
  const statuslinePath = path.resolve(__dirname, "statusline.js").replace(/\\/g, "/");

  // 1. Settings check
  console.log(`${BOLD}[1/4] Claude Code Settings Check (~/.claude/settings.json):${RESET}`);
  if (!fs.existsSync(settingsPath)) {
    console.log(`  ${YELLOW}⚠️  settings.json not found at ${settingsPath}${RESET}`);
    console.log(`     Run ${CYAN}ccs install${RESET} to configure it.`);
    hasError = true;
  } else {
    try {
      const raw = fs.readFileSync(settingsPath, "utf8");
      const settings = JSON.parse(raw || "{}");
      if (settings.statusLine && typeof settings.statusLine.command === "string") {
        const cmd = settings.statusLine.command;
        if (cmd.includes(statuslinePath) || cmd.includes("ccs") || cmd.includes("claude-code-status")) {
          console.log(`  ${GREEN}✔ statusLine is properly configured:${RESET} ${DIM}${cmd}${RESET}`);
        } else {
          console.log(`  ${YELLOW}⚠️  statusLine is configured with another command:${RESET} ${cmd}`);
          console.log(`     Run ${CYAN}ccs install${RESET} to switch to this tool.`);
        }
      } else {
        console.log(`  ${YELLOW}⚠️  statusLine is missing from settings.json${RESET}`);
        console.log(`     Run ${CYAN}ccs install${RESET} to enable statusline.`);
        hasError = true;
      }
    } catch (e) {
      console.log(`  ${RED}✖ Failed to parse settings.json: ${e.message}${RESET}`);
      hasError = true;
    }
  }

  // 2. Configuration check
  console.log(`\n${BOLD}[2/4] Configuration File Check (~/.claude/statusline.config.json):${RESET}`);
  if (!fs.existsSync(configPath)) {
    console.log(`  ${YELLOW}⚠️  statusline.config.json not found (using defaults)${RESET}`);
    console.log(`     Run ${CYAN}ccs init-config${RESET} to generate one with full comments.`);
  } else {
    try {
      const raw = fs.readFileSync(configPath, "utf8");
      const cfg = parseJsonWithComments(raw);
      if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
        console.log(`  ${GREEN}✔ statusline.config.json is valid JSONC${RESET}`);
        const activeFields = Array.isArray(cfg.fields) ? cfg.fields : DEFAULT_CONFIG.fields;
        console.log(`    Active fields (${activeFields.length}): ${CYAN}${activeFields.join(", ")}${RESET}`);
        console.log(`    Theme: ${CYAN}${cfg.theme || "default"}${RESET} | Delimiter: ${CYAN}${JSON.stringify(cfg.delimiter || "|")}${RESET}`);
      } else {
        console.log(`  ${RED}✖ Configuration file root must be a JSON object${RESET}`);
        hasError = true;
      }
    } catch (e) {
      console.log(`  ${RED}✖ Failed to parse statusline.config.json: ${e.message}${RESET}`);
      hasError = true;
    }
  }

  // 3. Git Environment & Response Check
  console.log(`\n${BOLD}[3/4] Git Environment & Responsiveness:${RESET}`);
  const startGit = Date.now();
  const gitOut = readGitStatus(process.cwd(), 0);
  const gitMs = Date.now() - startGit;
  if (gitOut === null) {
    console.log(`  ${DIM}ℹ Current directory is not a Git repository or Git is unavailable (skipped).${RESET}`);
  } else {
    console.log(`  ${GREEN}✔ Git status responded in ${gitMs}ms${RESET}`);
    const firstLine = gitOut.split("\n")[0] || "";
    console.log(`    Branch state: ${DIM}${firstLine}${RESET}`);
  }

  // 4. Pipeline End-to-End Latency Benchmark
  console.log(`\n${BOLD}[4/4] Pipeline End-to-End Latency Benchmark:${RESET}`);
  const benchPayload = {
    workspace: { current_dir: process.cwd() },
    model: { display_name: "claude-3-7-sonnet" },
    context_window: { total_input_tokens: 58000, context_window_size: 200000 },
    cost: { total_cost_usd: 0.125 },
    rate_limits: { five_hour: { used_percentage: 45 } },
  };
  renderStatusline(benchPayload);
  const benchRuns = 10;
  const startHr = process.hrtime.bigint();
  for (let i = 0; i < benchRuns; i++) {
    renderStatusline(benchPayload);
  }
  const endHr = process.hrtime.bigint();
  const avgMs = Number(endHr - startHr) / (benchRuns * 1_000_000);
  const formattedAvg = avgMs.toFixed(2);
  let speedRating = `${GREEN}⚡ Ultra-fast (< 3ms)${RESET}`;
  if (avgMs > 10) {
    speedRating = `${YELLOW}Moderate (${formattedAvg}ms)${RESET}`;
  } else if (avgMs > 5) {
    speedRating = `${CYAN}Fast (${formattedAvg}ms)${RESET}`;
  }
  console.log(`  ${GREEN}✔ Render latency:${RESET} ~${formattedAvg}ms/op (avg of ${benchRuns} runs) - ${speedRating}`);

  console.log();
  if (hasError) {
    console.log(`${YELLOW}${BOLD}Doctor detected potential issues.${RESET} Run ${CYAN}ccs install${RESET} to repair.`);
  } else {
    console.log(`${GREEN}${BOLD}✔ All systems healthy!${RESET} Claude Code Statusline is ready to go.`);
  }
  console.log();
}

function showHelp() {
  console.log(`
${BOLD}claude-code-status (ccs)${RESET}
A clean, ultra-fast and zero-dependency statusline and observability suite for Claude Code.

${BOLD}USAGE:${RESET}
  claude-code-status [command]
  ccs [command]

${BOLD}COMMANDS:${RESET}
  ${CYAN}install${RESET}          Configure ~/.claude/settings.json (or repair: ccs fix)
                      Add ${DIM}--if-unset${RESET} to skip when a statusLine already exists
  ${CYAN}uninstall${RESET}        Remove statusline from ~/.claude/settings.json
  ${CYAN}doctor${RESET}           Check installation health, settings and config integrity
  ${CYAN}set <key> <val>${RESET}  Set configuration property (e.g. ccs set showGitStatusStats true)
  ${CYAN}get [key]${RESET}        Read configuration property (e.g. ccs get theme)
  ${CYAN}toggle <field>${RESET}   Toggle a field on/off in configuration (e.g. ccs toggle todo)
  ${CYAN}config [list]${RESET}    List all configuration properties and their state
  ${CYAN}export [file]${RESET}    Export configuration to file or stdout
  ${CYAN}import <file>${RESET}    Import and apply configuration file (with automatic backup)
  ${CYAN}reset [target]${RESET}   Reset configuration (config) or clear cache (cache)
  ${CYAN}ui [name]${RESET}        Interactive UI style picker & switcher (or apply by name/number)
  ${CYAN}theme <name>${RESET}     Set color theme (default, catppuccin, nord, tokyo)
  ${CYAN}delimiter <s>${RESET}    Set delimiter symbol (default: "|", e.g. "/" or "•")
  ${CYAN}preview${RESET}          Preview statusline styles and layouts
  ${CYAN}init-config${RESET}      Generate ~/.claude/statusline.config.json with full annotations
  ${CYAN}help${RESET}             Show this help message

${BOLD}DEFAULT FIELDS:${RESET}
  ${GREEN}model${RESET}            AI Model name (e.g. claude-3-7-sonnet)
  ${GREEN}context${RESET}          Token usage and progress bar (e.g. [██░░░░░░] 29% (58k/200k))
  ${GREEN}project${RESET}          Current project directory
  ${GREEN}git${RESET}              Git branch and dirty marker (*)

${BOLD}OPTIONAL FIELDS (Uncomment in ~/.claude/statusline.config.json or use ccs set fields ...):${RESET}
  ${CYAN}fast${RESET}                 Fast mode indicator (⚡fast, toggled by /fast)
  ${CYAN}todo${RESET}                 Task / Todo checklist progress (e.g. todo: 2/5 or ✓ 5/5)
  ${CYAN}compact${RESET}              Auto-compact alert badge (⚠️compact when context >= 80%)
  ${CYAN}cost${RESET}                 Session cost in USD / CNY (with custom pricing multiplier)
  ${CYAN}rate_limit${RESET}           5-hour, 7-day, and monthly quota with reset countdown
  ${CYAN}cache${RESET}                Prompt cache hit rate (e.g. Cache:92%)
  ${CYAN}session_duration${RESET}     Elapsed session duration (e.g. 1h 24m)
  ${CYAN}api_duration${RESET}         Pure API response generation time (e.g. api:12m)
  ${CYAN}speed${RESET}                Model generation throughput (e.g. 85 t/s)
  ${CYAN}repo${RESET}                 Canonical remote repository (e.g. owner/repo)
  ${CYAN}tokens${RESET}               Input, Cache and Output token breakdown
  ${CYAN}lines${RESET}                Code velocity (+lines/-lines added and removed)
  ${CYAN}mcp${RESET}                  Configured MCP servers count (e.g. MCP:2)
  ${CYAN}effort${RESET}               Claude 3.7 reasoning effort level
  ${CYAN}output_style${RESET}         Output style tag (e.g. [concise])

${BOLD}PIPED USAGE:${RESET}
  cat session.json | ccs
`);
}

const arg = (process.argv[2] || "").toLowerCase();
const subArg = (process.argv[3] || "").toLowerCase();

if (arg === "install" || arg === "i" || arg === "fix" || arg === "repair") {
  install(process.argv.includes("--if-unset"));
} else if (arg === "uninstall" || arg === "remove") {
  uninstall();
} else if (arg === "doctor" || arg === "check") {
  doctor();
} else if (arg === "theme" || arg === "color") {
  setTheme(process.argv[3]);
} else if (arg === "ui" || arg === "preset") {
  showUiPicker(process.argv[3]);
} else if (arg === "delimiter" || arg === "sep") {
  setDelimiter(process.argv[3]);
} else if (arg === "preview" || arg === "p") {
  preview();
} else if (arg === "set") {
  setConfig(process.argv[3], process.argv[4]);
} else if (arg === "get") {
  getConfig(process.argv[3]);
} else if (arg === "toggle" || arg === "t") {
  toggleField(process.argv[3]);
} else if (arg === "export") {
  exportConfig(process.argv[3]);
} else if (arg === "import") {
  importConfig(process.argv[3]);
} else if (arg === "reset") {
  resetConfig(process.argv[3]);
} else if (arg === "list" || arg === "ls") {
  listConfig();
} else if (arg === "config") {
  if (subArg === "set") {
    setConfig(process.argv[4], process.argv[5]);
  } else if (subArg === "get") {
    getConfig(process.argv[4]);
  } else if (subArg === "toggle" || subArg === "t") {
    toggleField(process.argv[4]);
  } else if (subArg === "export") {
    exportConfig(process.argv[4]);
  } else if (subArg === "import") {
    importConfig(process.argv[4]);
  } else if (subArg === "reset") {
    resetConfig(process.argv[4]);
  } else if (subArg === "init") {
    initConfig();
  } else if (subArg === "list" || subArg === "ls" || !subArg) {
    listConfig();
  } else {
    getConfig(process.argv[3]);
  }
} else if (arg === "init-config") {
  initConfig();
} else if (arg === "--help" || arg === "-h" || arg === "help") {
  showHelp();
} else {
  if (!process.stdin.isTTY) {
    run();
  } else {
    showHelp();
  }
}
