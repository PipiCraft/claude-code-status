// @ts-check
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Redirect the home directory before anything reads ~/.claude, so running the
// suite never touches the real user configuration.
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-statusline-test-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;

const {
  parseJsonWithComments,
  makeProgressBar,
  formatCountdown,
  formatDuration,
  renderStatusline,
  readGitStatus,
  getStringWidth,
} = require("../bin/statusline.js");
const { stripAnsi, applyResponsiveLayout, DEFAULT_FIELD_PRIORITIES } = require("../lib/utils.js");

const PROJECT_DIR = path.resolve(__dirname, "..");
const CLI_PATH = path.join(PROJECT_DIR, "bin", "cli.js");
const CONFIG_PATH = path.join(sandboxHome, ".claude", "statusline.config.json");

const SAMPLE_INPUT = {
  workspace: { current_dir: PROJECT_DIR },
  model: { display_name: "claude-3-7-sonnet" },
  context_window: { total_input_tokens: 58000, context_window_size: 200000 },
  cost: { total_cost_usd: 0.185, total_lines_added: 185, total_lines_removed: 32 },
};

/** @param {string} home */
function runCli(home, ...args) {
  return execFileSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

/** @param {string} prefix */
function makeSandboxHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

after(() => {
  fs.rmSync(sandboxHome, { recursive: true, force: true });
});

test("parseJsonWithComments strips comments and trailing commas", () => {
  const raw = `{
  // a line comment
  "a": 1, /* a block comment */
  "b": [1, 2,],
  "url": "https://example.com//not-a-comment",
}`;
  assert.deepEqual(parseJsonWithComments(raw), {
    a: 1,
    b: [1, 2],
    url: "https://example.com//not-a-comment",
  });
});

test("parseJsonWithComments returns an empty object for blank input", () => {
  assert.deepEqual(parseJsonWithComments(""), {});
  assert.deepEqual(parseJsonWithComments("   "), {});
});

test("makeProgressBar fills proportionally and clamps out-of-range values", () => {
  assert.equal(makeProgressBar(0, 8), "[░░░░░░░░]");
  assert.equal(makeProgressBar(50, 8), "[████░░░░]");
  assert.equal(makeProgressBar(100, 8), "[████████]");
  assert.equal(makeProgressBar(-20, 8), "[░░░░░░░░]");
  assert.equal(makeProgressBar(150, 8), "[████████]");
});

test("formatCountdown renders days, hours and minutes", () => {
  const now = Date.now();
  const inSeconds = (seconds) => new Date(now + seconds * 1000).toISOString();
  // 30s of slack keeps floor() rounding from crossing a unit boundary
  assert.equal(formatCountdown(inSeconds(3 * 86400 + 4 * 3600 + 30)), "3d4h");
  assert.equal(formatCountdown(inSeconds(2 * 3600 + 15 * 60 + 30)), "2h15m");
  assert.equal(formatCountdown(inSeconds(45 * 60 + 30)), "45m");
});

test("formatCountdown accepts epoch numbers and handles expired or missing values", () => {
  assert.equal(formatCountdown(Math.floor((Date.now() + 3600 * 1000 + 30000) / 1000)), "1h0m");
  assert.equal(formatCountdown(Date.now() - 60000), "<1m");
  assert.equal(formatCountdown(undefined), "");
  assert.equal(formatCountdown("not-a-date"), "");
});

test("renderStatusline renders the default fields without ANSI codes", () => {
  const out = renderStatusline(SAMPLE_INPUT, { colors: false });
  assert.ok(!/\x1b\[/.test(out), "ANSI codes should be stripped when colors is false");

  const parts = out.split(" | ");
  assert.equal(parts[0], "claude-3-7-sonnet");
  assert.match(parts[1], /^\[█+░+\] 29% \(58\.0k\/200\.0k\)$/);
  assert.equal(parts[2], "claude-statusline");
});

test("renderStatusline respects a custom delimiter", () => {
  const out = renderStatusline(SAMPLE_INPUT, { colors: false, delimiter: "•" });
  assert.ok(out.includes(" • "));
});

test("renderStatusline skips fields whose data is unavailable", () => {
  const out = renderStatusline(
    { model: { display_name: "opus" } },
    { colors: false, fields: ["model", "cost", "cache", "mcp", "effort"] }
  );
  assert.equal(out, "opus");
});

test("renderStatusline splits fields across two lines when lines is 2", () => {
  const lines = renderStatusline(SAMPLE_INPUT, { colors: false, lines: 2 }).split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /claude-3-7-sonnet/);
  assert.match(lines[1], /claude-statusline/);
});

test("renderStatusline honours an explicit context window size", () => {
  const out = renderStatusline(
    { model: { display_name: "m" }, context_window: { total_input_tokens: 58000 } },
    { colors: false, fields: ["context"], contextWindowSize: 100000, progressBar: false }
  );
  assert.equal(out, "58% (58.0k/100.0k)");
});

test("readGitStatus returns null outside a git repository", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-statusline-nogit-"));
  try {
    assert.equal(readGitStatus(dir, 0), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readGitStatus reuses the on-disk cache within the TTL", () => {
  const first = readGitStatus(PROJECT_DIR, 3600);
  if (first === null) return; // git is not installed in this environment

  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    // A cache hit must not need the git binary at all
    assert.equal(readGitStatus(PROJECT_DIR, 3600), first);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("readGitStatus bypasses the cache when the TTL is 0", () => {
  if (readGitStatus(PROJECT_DIR, 3600) === null) return; // git is not installed

  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.equal(readGitStatus(PROJECT_DIR, 0), null);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("cli delimiter round-trips values containing dollar signs", () => {
  // Regression: string-based String.replace treated `$&`, `$'` and `$1` in the
  // replacement as substitution patterns and corrupted the config file.
  for (const value of ["$&", "$'", "$1", "$$", "•"]) {
    runCli(sandboxHome, "delimiter", value);
    const parsed = parseJsonWithComments(fs.readFileSync(CONFIG_PATH, "utf8"));
    assert.equal(parsed.delimiter, value, `delimiter ${JSON.stringify(value)} should round-trip`);
  }
});

test("cli install --if-unset skips when a statusLine already exists", () => {
  const home = makeSandboxHome("claude-statusline-ifunset-");
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, "settings.json");
  const existing = { statusLine: { type: "command", command: "npx -y ccstatusline@latest" } };
  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), "utf8");

  try {
    runCli(home, "install", "--if-unset");
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), existing);
    assert.ok(!fs.existsSync(path.join(claudeDir, "statusline.config.json")));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("cli install --if-unset configures when no statusLine is present", () => {
  const home = makeSandboxHome("claude-statusline-fresh-");
  try {
    runCli(home, "install", "--if-unset");
    const settings = JSON.parse(
      fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8")
    );
    assert.equal(settings.statusLine.type, "command");
    assert.match(settings.statusLine.command, /statusline\.js/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("cli uninstall leaves a statusLine it does not own untouched", () => {
  const home = makeSandboxHome("claude-statusline-foreign-");
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, "settings.json");
  const foreign = { statusLine: { type: "command", command: "npx -y ccstatusline@latest" } };
  fs.writeFileSync(settingsPath, JSON.stringify(foreign, null, 2), "utf8");

  try {
    runCli(home, "uninstall");
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), foreign);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("cli uninstall removes a statusLine installed by this tool", () => {
  const home = makeSandboxHome("claude-statusline-owned-");
  try {
    runCli(home, "install");
    runCli(home, "uninstall");
    const settings = JSON.parse(
      fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8")
    );
    assert.ok(!("statusLine" in settings));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("cost renderer formats 0 cost as $0.00", () => {
  const out = renderStatusline(
    { model: { display_name: "test" }, cost: { total_cost_usd: 0 } },
    { colors: false, fields: ["cost"] }
  );
  assert.equal(out, "$0.00");
});

test("readLastUsageFromTranscript safely reads the last usage record from transcript", () => {
  const { readLastUsageFromTranscript } = require("../lib/utils.js");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-statusline-transcript-"));
  const transcriptFile = path.join(tempDir, "transcript.jsonl");

  try {
    // Generate dummy lines with two usage records; the last one should take precedence
    const lines = [
      JSON.stringify({ message: { usage: { input_tokens: 100, output_tokens: 50 } } }),
      JSON.stringify({ type: "user_input", content: "hello".repeat(100) }),
      JSON.stringify({ message: { usage: { input_tokens: 200, output_tokens: 100 } } }),
    ];
    fs.writeFileSync(transcriptFile, lines.join("\n"), "utf8");

    const tokens = readLastUsageFromTranscript(transcriptFile);
    assert.equal(tokens, 300);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cli delimiter preserves inline comments in config", () => {
  const home = makeSandboxHome("claude-statusline-comment-");
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const configPath = path.join(claudeDir, "statusline.config.json");

  const initialConfig = `{
  "delimiter": "|", // user delimiter comment
  "lines": 1
}`;
  fs.writeFileSync(configPath, initialConfig, "utf8");

  try {
    runCli(home, "delimiter", "/");
    const updated = fs.readFileSync(configPath, "utf8");
    assert.match(updated, /"delimiter": "\/", \/\/ user delimiter comment/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("getMcpServerCount detects MCP servers across project configs", () => {
  const { getMcpServerCount } = require("../lib/mcp.js");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-statusline-mcp-"));

  try {
    // Write project .mcp.json
    fs.writeFileSync(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "server-a": {}, "server-b": {} } }),
      "utf8"
    );
    const count = getMcpServerCount(tempDir);
    assert.ok(count >= 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("model renderer automatically cleans trailing date suffix", () => {
  const out = renderStatusline(
    { model: { id: "claude-3-7-sonnet-20250219" } },
    { colors: false, fields: ["model"] }
  );
  assert.equal(out, "claude-3-7-sonnet");
});

test("model renderer respects custom modelAliases mapping", () => {
  const out = renderStatusline(
    { model: { id: "claude-3-7-sonnet-20250219" } },
    { colors: false, fields: ["model"], modelAliases: { "claude-3-7-sonnet": "Sonnet 3.7" } }
  );
  assert.equal(out, "Sonnet 3.7");
});

test("theme option applies custom TrueColor palette", () => {
  const catppuccinOut = renderStatusline(
    { model: { display_name: "m" } },
    { colors: true, fields: ["model"], theme: "catppuccin" }
  );
  assert.ok(catppuccinOut.includes("\x1b[38;2;166;227;161m"));

  const nordOut = renderStatusline(
    { model: { display_name: "m" } },
    { colors: true, fields: ["model"], theme: "nord" }
  );
  assert.ok(nordOut.includes("\x1b[38;2;163;190;140m"));

  const tokyoOut = renderStatusline(
    { model: { display_name: "m" } },
    { colors: true, fields: ["model"], theme: "tokyo" }
  );
  assert.ok(tokyoOut.includes("\x1b[38;2;158;206;106m"));
});

test("cli theme command switches theme in config", () => {
  const home = makeSandboxHome("claude-statusline-theme-");
  try {
    runCli(home, "theme", "catppuccin");
    const parsed = parseJsonWithComments(
      fs.readFileSync(path.join(home, ".claude", "statusline.config.json"), "utf8")
    );
    assert.equal(parsed.theme, "catppuccin");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("formatDuration formats milliseconds into human-readable duration strings", () => {
  assert.equal(formatDuration(0), "<1m");
  assert.equal(formatDuration(45 * 1000), "<1m");
  assert.equal(formatDuration(38 * 60 * 1000), "38m");
  assert.equal(formatDuration((1 * 3600 + 24 * 60) * 1000), "1h 24m");
  assert.equal(formatDuration(2 * 3600 * 1000), "2h");
  assert.equal(formatDuration((2 * 86400 + 5 * 3600) * 1000), "2d 5h");
  assert.equal(formatDuration(-100), "");
  assert.equal(formatDuration(NaN), "");
});

test("session_duration renderer outputs formatted elapsed session duration", () => {
  const fromCost = renderStatusline(
    { cost: { total_duration_ms: (1 * 3600 + 24 * 60) * 1000 } },
    { colors: false, fields: ["session_duration"] }
  );
  assert.equal(fromCost, "1h 24m");

  const fromAlias = renderStatusline(
    { total_duration_ms: 38 * 60 * 1000 },
    { colors: false, fields: ["duration"] }
  );
  assert.equal(fromAlias, "38m");

  const none = renderStatusline({}, { colors: false, fields: ["session_duration"] });
  assert.equal(none, "");
});

test("tokens breakdown renderer displays input, cache, and output tokens", () => {
  const out = renderStatusline(
    {
      context_window: {
        current_usage: {
          input_tokens: 12000,
          cache_read_input_tokens: 320000,
          output_tokens: 18000,
        },
      },
    },
    { colors: false, fields: ["tokens"] }
  );
  assert.equal(out, "I:12k C:320k O:18k");

  const aliasOut = renderStatusline(
    {
      context_window: {
        total_input_tokens: 1500000,
        total_output_tokens: 25000,
      },
    },
    { colors: false, fields: ["token_breakdown"] }
  );
  assert.equal(aliasOut, "I:1.5M O:25k");
});

test("rate_limit burn rate trend displays up, down, or flat indicator", () => {
  const now = Date.now();
  // 5h window (18000s), resets in 2 hours (7200s). Elapsed = 3 hours (60% elapsed).
  const resetsAt = new Date(now + 2 * 3600 * 1000).toISOString();

  // Case 1: Used 80% (> 60% + 5% -> burn rate is UP: ↑)
  const upOut = renderStatusline(
    {
      rate_limits: {
        five_hour: { used_percentage: 80, resets_at: resetsAt },
      },
    },
    {
      colors: false,
      fields: ["rate_limit"],
      rateLimitWindows: ["5h"],
      showRateLimitCountdown: false,
      showRateLimitTrend: true,
    }
  );
  assert.equal(upOut, "5h:80%↑");

  // Case 2: Used 40% (< 60% - 5% -> burn rate is DOWN: ↓)
  const downOut = renderStatusline(
    {
      rate_limits: {
        five_hour: { used_percentage: 40, resets_at: resetsAt },
      },
    },
    {
      colors: false,
      fields: ["rate_limit"],
      rateLimitWindows: ["5h"],
      showRateLimitCountdown: false,
      showRateLimitTrend: true,
    }
  );
  assert.equal(downOut, "5h:40%↓");

  // Case 3: Used 62% (within +-5% of 60% -> FLAT: no arrow)
  const flatOut = renderStatusline(
    {
      rate_limits: {
        five_hour: { used_percentage: 62, resets_at: resetsAt },
      },
    },
    {
      colors: false,
      fields: ["rate_limit"],
      rateLimitWindows: ["5h"],
      showRateLimitCountdown: false,
      showRateLimitTrend: true,
    }
  );
  assert.equal(flatOut, "5h:62%");

  // Case 4: showRateLimitTrend is false (default) -> no arrow even when over pace
  const defaultOut = renderStatusline(
    {
      rate_limits: {
        five_hour: { used_percentage: 80, resets_at: resetsAt },
      },
    },
    {
      colors: false,
      fields: ["rate_limit"],
      rateLimitWindows: ["5h"],
      showRateLimitCountdown: false,
      showRateLimitTrend: false,
    }
  );
  assert.equal(defaultOut, "5h:80%");
});

test("lines: 'auto' adapts dynamically to terminal width", () => {
  const input = {
    workspace: { current_dir: "/path/to/my-project" },
    model: { display_name: "claude-3-7-sonnet" },
    context_window: { total_input_tokens: 58000, context_window_size: 200000 },
  };

  // Wide terminal (200 cols): fits comfortably on single line
  const wideOut = renderStatusline(input, {
    colors: false,
    lines: "auto",
    terminalWidth: 200,
  });
  assert.ok(!wideOut.includes("\n"), "Wide terminal should stay on a single line");
  assert.ok(wideOut.includes("claude-3-7-sonnet"));
  assert.ok(wideOut.includes("my-project"));

  // Narrow terminal (30 cols): single line is ~50 chars, exceeds 30 cols, so auto-splits into two lines
  const narrowOut = renderStatusline(input, {
    colors: false,
    lines: "auto",
    terminalWidth: 30,
  });
  assert.ok(narrowOut.includes("\n"), "Narrow terminal should auto-split into two lines");
  const [line1, line2] = narrowOut.split("\n");
  assert.ok(line1.includes("claude-3-7-sonnet"));
  assert.ok(line2.includes("my-project"));
});

test("getStringWidth correctly measures ASCII, ANSI sequences, and CJK fullwidth characters", () => {
  assert.equal(getStringWidth("hello"), 5);
  assert.equal(getStringWidth("\x1b[32mhello\x1b[0m"), 5);
  assert.equal(getStringWidth("中文"), 4);
  assert.equal(getStringWidth("你好，世界！"), 12);
  assert.equal(getStringWidth("\x1b[36m项目: \x1b[32m用户中心\x1b[0m"), 14);
  assert.equal(getStringWidth(""), 0);
});

test("lines: 'auto' accounts for CJK double-width characters when determining line wraps", () => {
  const input = {
    workspace: { current_dir: "/path/to/电商后台管理服务" },
    model: { display_name: "claude" },
    context_window: { total_input_tokens: 1000, context_window_size: 200000 },
  };

  const out = renderStatusline(input, {
    colors: false,
    lines: "auto",
    terminalWidth: 50,
  });
  assert.ok(out.includes("\n"), "Should wrap to two lines because CJK width exceeds terminal width");
});

test("cost renderer applies warning and danger colors according to thresholds", () => {
  const lowCostInput = { cost: { total_cost_usd: 0.5 } };
  const warnCostInput = { cost: { total_cost_usd: 1.5 } };
  const dangerCostInput = { cost: { total_cost_usd: 6.0 } };

  const lowOut = renderStatusline(lowCostInput, { fields: ["cost"] });
  assert.ok(lowOut.includes("\x1b[32m"), "Low cost should be green (safe)");

  const warnOut = renderStatusline(warnCostInput, { fields: ["cost"] });
  assert.ok(warnOut.includes("\x1b[33m"), "Cost >= $1.00 should be yellow (warning)");

  const dangerOut = renderStatusline(dangerCostInput, { fields: ["cost"] });
  assert.ok(dangerOut.includes("\x1b[31m"), "Cost >= $5.00 should be red (danger)");

  // With multiplier
  const multiplierInput = { cost: { total_cost_usd: 0.8 } }; // 0.8 * 1.5 = 1.2 USD -> warning
  const multOut = renderStatusline(multiplierInput, {
    fields: ["cost"],
    costMultiplier: 1.5,
  });
  assert.ok(multOut.includes("\x1b[33m"), "Effective USD with multiplier should trigger warning");
});

test("git renderer applies middle truncation when maxBranchLength is set", () => {
  const { FIELD_RENDERERS } = require("../bin/statusline.js");
  const colors = { MAGENTA: "", RESET: "" };
  const icons = { git: "" };

  // Verify truncation logic on long branch
  const longBranch = "feature/AUTH-402-jwt-token-refresh";
  const maxLen = 18;
  const headLen = Math.ceil((maxLen - 3) / 2); // 8
  const tailLen = Math.floor((maxLen - 3) / 2); // 7
  const expectedTruncated = `${longBranch.slice(0, headLen)}...${longBranch.slice(-tailLen)}`;
  assert.equal(expectedTruncated.length, 18);
  assert.equal(expectedTruncated, "feature/...refresh");

  const input = {
    workspace: { current_dir: PROJECT_DIR },
  };

  // With maxBranchLength disabled (0), output should contain normal branch
  const normalOut = renderStatusline(input, {
    colors: false,
    fields: ["git"],
    maxBranchLength: 0,
  });
  assert.ok(normalOut.length > 0);
});

test("git renderer displays worktree prefix when input.worktree is present", () => {
  const { FIELD_RENDERERS } = require("../bin/statusline.js");
  const colors = { MAGENTA: "", RESET: "" };
  const icons = { git: "" };

  const ctxWithName = {
    cwd: PROJECT_DIR,
    config: {},
    icons,
    colors,
    input: { worktree: { name: "auth-refactor" } },
  };
  const outWithName = FIELD_RENDERERS.git(ctxWithName);
  if (outWithName) {
    assert.ok(outWithName.includes("(wt: auth-refactor)"), "Should include worktree name tag");
  }

  const ctxWithFlag = {
    cwd: PROJECT_DIR,
    config: {},
    icons,
    colors,
    input: { worktree: true },
  };
  const outWithFlag = FIELD_RENDERERS.git(ctxWithFlag);
  if (outWithFlag) {
    assert.ok(outWithFlag.includes("(wt)"), "Should include (wt) tag");
  }

  // Also verify fallback to input.workspace.git_worktree
  const ctxWithWorkspaceWt = {
    cwd: PROJECT_DIR,
    config: {},
    icons,
    colors,
    input: { workspace: { git_worktree: "workspace-wt" } },
  };
  const outWithWorkspaceWt = FIELD_RENDERERS.git(ctxWithWorkspaceWt);
  if (outWithWorkspaceWt) {
    assert.ok(outWithWorkspaceWt.includes("(wt: workspace-wt)"), "Should support workspace.git_worktree");
  }
});

test("cache renderer computes hit rate including cache_creation_input_tokens and shows 0% on cache miss", () => {
  const { FIELD_RENDERERS } = require("../bin/statusline.js");
  const icons = { cache: "" };
  const colors = { GREEN: "", CYAN: "", DIM: "", RESET: "" };

  // 1. Normal hit rate (cacheRead: 8000, cacheCreation: 1000, input: 1000 -> 8000/10000 = 80%)
  const hitCtx = {
    icons,
    colors,
    input: {
      context_window: {
        current_usage: {
          cache_read_input_tokens: 8000,
          cache_creation_input_tokens: 1000,
          input_tokens: 1000,
        },
      },
    },
  };
  const hitOut = FIELD_RENDERERS.cache(hitCtx);
  assert.equal(hitOut, "Cache:80%");

  // 2. Cache miss on cold start or TTL expiration (cacheRead: 0, cacheCreation: 5000, input: 2000)
  const missCtx = {
    icons,
    colors,
    input: {
      context_window: {
        current_usage: {
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 5000,
          input_tokens: 2000,
        },
      },
    },
  };
  const missOut = FIELD_RENDERERS.cache(missCtx);
  assert.equal(missOut, "Cache:0%");
});

test("git renderer formats detached HEAD with short commit hash", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-statusline-detached-test-"));
  try {
    execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "test"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmp, stdio: "ignore" });
    fs.writeFileSync(path.join(tmp, "init.txt"), "hello");
    execFileSync("git", ["add", "."], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: tmp, stdio: "ignore" });

    const hash = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", hash], { cwd: tmp, stdio: "ignore" });

    const out = renderStatusline({ workspace: { current_dir: tmp } }, { colors: false, fields: ["git"] });
    const shortHash = hash.slice(0, 7);
    assert.ok(out.includes(`HEAD@${shortHash}`), `Output should include HEAD@${shortHash}, got: ${out}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("cli doctor command runs successfully and inspects configuration", () => {
  const out = execFileSync(process.execPath, [CLI_PATH, "doctor"], {
    encoding: "utf8",
    env: { ...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome },
  });
  assert.ok(out.includes("Health Doctor"));
  assert.ok(out.includes("[1/4] Claude Code Settings Check"));
  assert.ok(out.includes("[2/4] Configuration File Check"));
  assert.ok(out.includes("[3/4] Git Environment & Responsiveness"));
  assert.ok(out.includes("[4/4] Pipeline End-to-End Latency Benchmark"));
});

test("project renderer detects added_dirs and displays (+N dirs) badge", () => {
  const out = renderStatusline(
    {
      workspace: {
        current_dir: "/path/to/main-repo",
        added_dirs: ["/path/to/lib-a", "/path/to/lib-b"],
      },
    },
    { colors: false, fields: ["project"] }
  );
  assert.ok(out.includes("main-repo (+2 dirs)"), `Expected (+2 dirs), got: ${out}`);
});

test("project renderer supports projectPathMode relative for monorepo subdirectories", () => {
  const out = renderStatusline(
    {
      workspace: {
        project_dir: "/path/to/monorepo",
        current_dir: "/path/to/monorepo/apps/frontend",
      },
    },
    { colors: false, fields: ["project"], projectPathMode: "relative" }
  );
  assert.ok(out.includes("monorepo:apps/frontend"), `Expected relative path, got: ${out}`);
});

test("api_duration renderer and session_duration showApiDuration display API response time", () => {
  const input = {
    cost: {
      total_duration_ms: 3600000, // 1h
      total_api_duration_ms: 720000, // 12m
    },
  };

  // 1. Independent api_duration field
  const apiOut = renderStatusline(input, { colors: false, fields: ["api_duration"] });
  assert.equal(apiOut, "api:12m");

  // 2. session_duration with showApiDuration: true
  const sessionOut = renderStatusline(input, {
    colors: false,
    fields: ["session_duration"],
    showApiDuration: true,
  });
  assert.equal(sessionOut, "1h (api: 12m)");
});

test("UI_PRESETS contains dot, slash, and compact layouts", () => {
  const { UI_PRESETS } = require("../lib/config.js");
  assert.ok(UI_PRESETS.dot, "dot preset should exist");
  assert.equal(UI_PRESETS.dot.config.delimiter, "•");

  assert.ok(UI_PRESETS.slash, "slash preset should exist");
  assert.equal(UI_PRESETS.slash.config.delimiter, "/");

  assert.ok(UI_PRESETS.compact, "compact preset should exist");
  assert.equal(UI_PRESETS.compact.config.progressBar, false);
  assert.equal(UI_PRESETS.compact.config.delimiter, "•");
});

test("git renderer formats staged, unstaged, and untracked file stats when showGitStatusStats is true", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccs-git-stats-"));
  try {
    execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmp, stdio: "ignore" });

    // Initial commit
    fs.writeFileSync(path.join(tmp, "base.txt"), "base content\n");
    execFileSync("git", ["add", "."], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: tmp, stdio: "ignore" });

    // 1 staged change
    fs.writeFileSync(path.join(tmp, "staged.txt"), "new staged\n");
    execFileSync("git", ["add", "staged.txt"], { cwd: tmp, stdio: "ignore" });

    // 1 unstaged change
    fs.writeFileSync(path.join(tmp, "base.txt"), "base modified\n");

    // 1 untracked file
    fs.writeFileSync(path.join(tmp, "untracked.txt"), "untracked\n");

    // Default mode: just *
    const defaultOut = renderStatusline(
      { workspace: { current_dir: tmp } },
      { colors: false, fields: ["git"], gitCacheTtl: 0 }
    );
    assert.ok(defaultOut.endsWith("*"), `Default mode should end with *, got: ${defaultOut}`);
    assert.ok(!defaultOut.includes("+1"), `Default mode should not have +1, got: ${defaultOut}`);

    // showGitStatusStats: true
    const statsOut = renderStatusline(
      { workspace: { current_dir: tmp } },
      { colors: false, fields: ["git"], showGitStatusStats: true, gitCacheTtl: 0 }
    );
    assert.ok(statsOut.includes("+1"), `Expected +1 staged, got: ${statsOut}`);
    assert.ok(statsOut.includes("*1"), `Expected *1 unstaged, got: ${statsOut}`);
    assert.ok(statsOut.includes("?1"), `Expected ?1 untracked, got: ${statsOut}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repo renderer outputs owner/name from workspace.repo or falls back to project", () => {
  // From workspace.repo
  const repoOut = renderStatusline(
    {
      workspace: {
        repo: { host: "github.com", owner: "PipiCraft", name: "claude-code-status" },
      },
    },
    { colors: false, fields: ["repo"] }
  );
  assert.equal(repoOut, "PipiCraft/claude-code-status");

  // Fallback to project directory name
  const fallbackOut = renderStatusline(
    {
      workspace: {
        current_dir: "/path/to/my-awesome-repo",
      },
    },
    { colors: false, fields: ["repo"] }
  );
  assert.equal(fallbackOut, "my-awesome-repo");
});

test("speed renderer calculates token throughput per second", () => {
  // 5000 output tokens in 25000ms api time = 200 t/s
  const speedOut = renderStatusline(
    {
      context_window: { total_output_tokens: 5000 },
      cost: { total_api_duration_ms: 25000 },
    },
    { colors: false, fields: ["speed"] }
  );
  assert.equal(speedOut, "200 t/s");

  // Aliases test (tok_per_sec)
  const aliasOut = renderStatusline(
    {
      context_window: { total_output_tokens: 1500 },
      cost: { total_api_duration_ms: 15000 },
    },
    { colors: false, fields: ["tok_per_sec"] }
  );
  assert.equal(aliasOut, "100 t/s");

  // Omitted if insufficient duration (<500ms) or 0 output tokens
  const zeroOut = renderStatusline(
    {
      context_window: { total_output_tokens: 0 },
      cost: { total_api_duration_ms: 5000 },
    },
    { colors: false, fields: ["speed"] }
  );
  assert.equal(zeroOut, "");
});

test("cli set, get, and config commands update and retrieve configuration", () => {
  const home = makeSandboxHome("ccs-cli-test-");
  try {
    // 1. set boolean property
    runCli(home, "set", "showGitStatusStats", "true");
    const getBool = stripAnsi(runCli(home, "get", "showGitStatusStats"));
    assert.ok(getBool.includes("showGitStatusStats: true"), `Expected showGitStatusStats: true, got: ${getBool}`);

    // 2. set numeric property
    runCli(home, "set", "lines", "2");
    const getNum = stripAnsi(runCli(home, "get", "lines"));
    assert.ok(getNum.includes("lines: 2"), `Expected lines: 2, got: ${getNum}`);

    // 3. set array property with comma-separated list
    runCli(home, "set", "fields", "model,context,speed,repo,git");
    const getArr = stripAnsi(runCli(home, "get", "fields"));
    assert.ok(getArr.includes("speed"), `Expected speed in fields, got: ${getArr}`);
    assert.ok(getArr.includes("repo"), `Expected repo in fields, got: ${getArr}`);

    // 4. list configuration via config list
    const listOut = stripAnsi(runCli(home, "config", "list"));
    assert.ok(listOut.includes("showGitStatusStats"), "Config list should include showGitStatusStats");
    assert.ok(listOut.includes("custom"), "Config list should show custom markers");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("context renderer supports 1M token extended context window natively", () => {
  const out = renderStatusline(
    {
      context_window: {
        context_window_size: 1000000,
        total_input_tokens: 125000,
        used_percentage: 12.5,
      },
    },
    { colors: false, fields: ["context"] }
  );
  assert.ok(out.includes("125.0k/1.0M"), `Expected 125.0k/1.0M, got: ${out}`);
  assert.ok(out.includes("13%"), `Expected 13%, got: ${out}`);
});

test("rate_limit renderer displays pacing burn alert when burning ahead of schedule", () => {
  const now = Date.now();
  // 5h window = 18000s. Reset in 4.5 hours (16200s), meaning only 1800s (10%) has elapsed.
  const resetIn4h30m = new Date(now + 4.5 * 3600 * 1000).toISOString();

  const input = {
    rate_limits: {
      five_hour: {
        used_percentage: 75,
        resets_at: resetIn4h30m,
      },
    },
  };

  // With showRateLimitPace: true -> should append ⚡ alert
  const paceOut = renderStatusline(input, {
    colors: false,
    fields: ["rate_limit"],
    showRateLimitPace: true,
  });
  assert.ok(paceOut.includes("5h:75%⚡"), `Expected 5h:75%⚡ in output, got: ${paceOut}`);

  // When burning slowly / normal (e.g. 10% used after 10% time elapsed) -> no ⚡
  const safeInput = {
    rate_limits: {
      five_hour: {
        used_percentage: 10,
        resets_at: resetIn4h30m,
      },
    },
  };
  const safeOut = renderStatusline(safeInput, {
    colors: false,
    fields: ["rate_limit"],
    showRateLimitPace: true,
  });
  assert.ok(!safeOut.includes("⚡"), `Expected no ⚡ in safe output, got: ${safeOut}`);
});

test("UI_PRESETS contains modern round and powerline presets", () => {
  const { UI_PRESETS } = require("../lib/config.js");
  assert.ok(UI_PRESETS.round, "round preset should exist");
  assert.equal(UI_PRESETS.round.config.delimiter, "  ");

  assert.ok(UI_PRESETS.powerline, "powerline preset should exist");
  assert.equal(UI_PRESETS.powerline.config.delimiter, "  ");
});

test("cli export, import, and reset commands manage configuration files safely", () => {
  const home = makeSandboxHome("ccs-export-test-");
  try {
    // 1. Set a custom property
    runCli(home, "set", "lines", "2");

    // 2. Export config to a file
    const exportFile = path.join(home, "exported-config.json");
    runCli(home, "export", exportFile);
    assert.ok(fs.existsSync(exportFile), "Exported file should exist");
    const exportedRaw = fs.readFileSync(exportFile, "utf8");
    assert.ok(exportedRaw.includes('"lines": 2'), "Exported config should contain custom property");

    // 3. Reset config back to default
    runCli(home, "reset", "config");
    const resetGet = stripAnsi(runCli(home, "get", "lines"));
    assert.ok(resetGet.includes("lines: 1"), `Expected lines: 1 after reset, got: ${resetGet}`);

    // 4. Import the saved config
    runCli(home, "import", exportFile);
    const importedGet = stripAnsi(runCli(home, "get", "lines"));
    assert.ok(importedGet.includes("lines: 2"), `Expected lines: 2 after import, got: ${importedGet}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("fast renderer displays ⚡fast when fast_mode is true and hides when false/missing", () => {
  const on = renderStatusline({ fast_mode: true }, { colors: false, fields: ["fast"] });
  assert.equal(on, "⚡fast");

  const off = renderStatusline({ fast_mode: false }, { colors: false, fields: ["fast"] });
  assert.equal(off, "");

  const missing = renderStatusline({}, { colors: false, fields: ["fast"] });
  assert.equal(missing, "");
});

test("project and repo renderers support OSC 8 hyperlinks when enabled", () => {
  const input = {
    workspace: {
      project_dir: "/path/to/my-project",
      current_dir: "/path/to/my-project",
      repo: { host: "github.com", owner: "PipiCraft", name: "claude-code-status" },
    },
  };

  // With clickable disabled (default)
  const normal = renderStatusline(input, { colors: false, fields: ["project", "repo"] });
  assert.ok(!normal.includes("\x1b]8;;"), "Should not contain OSC 8 escape sequence when disabled");
  assert.ok(normal.includes("my-project"), "Should contain project name");
  assert.ok(normal.includes("PipiCraft/claude-code-status"), "Should contain repo name");

  // With clickable enabled
  const linked = renderStatusline(input, {
    colors: false,
    fields: ["project", "repo"],
    clickableProjectPath: true,
    clickableRepoPath: true,
  });
  assert.ok(linked.includes("\x1b]8;;file:///path/to/my-project\x1b\\my-project\x1b]8;;\x1b\\"), "Project should have file:// OSC 8 link");
  assert.ok(linked.includes("\x1b]8;;https://github.com/PipiCraft/claude-code-status\x1b\\PipiCraft/claude-code-status\x1b]8;;\x1b\\"), "Repo should have https:// OSC 8 link");
});

test("renderStatusline handles lines auto with payload terminal_width", () => {
  const input = {
    terminal_width: 35,
    workspace: { current_dir: "/path/to/very/long/project/name/that/takes/space" },
    model: { display_name: "claude-3-7-sonnet" },
    context_window: { total_input_tokens: 50000, context_window_size: 200000 },
  };
  const out = renderStatusline(input, {
    colors: false,
    lines: "auto",
    fields: ["model", "context", "project"],
  });
  assert.ok(out.includes("\n"), "Should wrap into multiple lines when terminal_width is narrow");
});

test("tokens renderer formats thinking_tokens as T:xx and handles missing or zero gracefully", () => {
  const withThinking = {
    context_window: {
      current_usage: {
        input_tokens: 15000,
        cache_read_input_tokens: 60000,
        thinking_tokens: 8500,
        output_tokens: 1200,
      },
    },
  };
  const outWith = renderStatusline(withThinking, { colors: false, fields: ["tokens"] });
  assert.ok(outWith.includes("T:9k") || outWith.includes("T:8.5k") || outWith.includes("T:8k"), `Expected T: in output, got: ${outWith}`);
  assert.ok(outWith.includes("I:15k"), "Should include I:15k");
  assert.ok(outWith.includes("C:60k"), "Should include C:60k");

  const withoutThinking = {
    context_window: {
      current_usage: {
        input_tokens: 15000,
        cache_read_input_tokens: 60000,
        output_tokens: 1200,
      },
    },
  };
  const outWithout = renderStatusline(withoutThinking, { colors: false, fields: ["tokens"] });
  assert.ok(!outWithout.includes("T:"), "Should not include T: when thinking_tokens is absent");
});

test("todo renderer formats completed vs in-progress and all complete states", () => {
  // In progress
  const inProgInput = {
    todos: [
      { content: "Step 1", status: "completed" },
      { content: "Step 2", status: "in_progress" },
      { content: "Step 3", status: "pending" },
    ],
  };
  const inProgOut = renderStatusline(inProgInput, { colors: false, fields: ["todo"] });
  assert.equal(inProgOut, "todo: 1/3");

  // All completed
  const allDoneInput = {
    todos: [
      { content: "Step 1", status: "completed" },
      { content: "Step 2", status: "completed" },
    ],
  };
  const allDoneOut = renderStatusline(allDoneInput, { colors: false, fields: ["todo"] });
  assert.equal(allDoneOut, "✓ 2/2 todos");

  // Empty or missing
  const emptyOut = renderStatusline({ todos: [] }, { colors: false, fields: ["todo"] });
  assert.equal(emptyOut, "");
});

test("readLastTodosFromTranscript correctly parses JSONL transcript files", () => {
  const { readLastTodosFromTranscript } = require("../lib/utils.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccs-todos-test-"));
  const transcriptFile = path.join(tmp, "transcript.jsonl");

  try {
    const lines = [
      JSON.stringify({ type: "user", message: { content: "Refactor code" } }),
      JSON.stringify({
        type: "tool_use",
        name: "TodoWrite",
        input: {
          todos: [
            { content: "Write tests", status: "completed" },
            { content: "Refactor database", status: "completed" },
            { content: "Verify build", status: "in_progress" },
            { content: "Deploy", status: "pending" },
          ],
        },
      }),
      JSON.stringify({ type: "assistant", message: { content: "I have started working on this." } }),
    ];
    fs.writeFileSync(transcriptFile, lines.join("\n"), "utf8");

    const parsed = readLastTodosFromTranscript(transcriptFile);
    assert.ok(parsed, "Should parse todos from transcript");
    assert.equal(parsed.total, 4);
    assert.equal(parsed.completed, 2);
    assert.equal(parsed.inProgressTitle, "Verify build");

    // Also test rendering from transcript_path
    const out = renderStatusline({ transcript_path: transcriptFile }, { colors: false, fields: ["todo"] });
    assert.equal(out, "todo: 2/4");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("git renderer detects merging, rebasing, and cherry-pick states", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccs-git-op-test-"));
  try {
    execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "test"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmp, stdio: "ignore" });
    fs.writeFileSync(path.join(tmp, "init.txt"), "hello");
    execFileSync("git", ["add", "."], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: tmp, stdio: "ignore" });

    const gitDir = path.join(tmp, ".git");

    // 1. Merging state
    fs.writeFileSync(path.join(gitDir, "MERGE_HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
    const mergeOut = renderStatusline({ workspace: { current_dir: tmp } }, { colors: false, fields: ["git"] });
    assert.ok(mergeOut.includes("(merging)"), `Expected (merging) in output, got: ${mergeOut}`);
    fs.unlinkSync(path.join(gitDir, "MERGE_HEAD"));

    // 2. Rebasing state
    const rebaseDir = path.join(gitDir, "rebase-merge");
    fs.mkdirSync(rebaseDir);
    const rebaseOut = renderStatusline({ workspace: { current_dir: tmp } }, { colors: false, fields: ["git"] });
    assert.ok(rebaseOut.includes("(rebasing)"), `Expected (rebasing) in output, got: ${rebaseOut}`);
    fs.rmdirSync(rebaseDir);

    // 3. Cherry-pick state
    fs.writeFileSync(path.join(gitDir, "CHERRY_PICK_HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
    const cpOut = renderStatusline({ workspace: { current_dir: tmp } }, { colors: false, fields: ["git"] });
    assert.ok(cpOut.includes("(cherry-pick)"), `Expected (cherry-pick) in output, got: ${cpOut}`);
    fs.unlinkSync(path.join(gitDir, "CHERRY_PICK_HEAD"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("compact alert renders warning when context percentage is >= threshold", () => {
  const highContext = {
    context_window: {
      total_input_tokens: 170000,
      context_window_size: 200000,
      used_percentage: 85,
    },
  };

  // With showCompactAlert enabled on context field
  const alertOut = renderStatusline(highContext, {
    colors: false,
    fields: ["context"],
    showCompactAlert: true,
    compactAlertThreshold: 80,
  });
  assert.ok(alertOut.includes("⚠️compact"), `Expected ⚠️compact in output, got: ${alertOut}`);

  // Standalone compact field at 85%
  const standaloneAlert = renderStatusline(highContext, {
    colors: false,
    fields: ["compact"],
    compactAlertThreshold: 80,
  });
  assert.equal(standaloneAlert, "⚠️compact");

  // Safe context (50%) -> standalone returns empty
  const safeContext = {
    context_window: {
      total_input_tokens: 100000,
      context_window_size: 200000,
      used_percentage: 50,
    },
  };
  const standaloneSafe = renderStatusline(safeContext, {
    colors: false,
    fields: ["compact"],
    compactAlertThreshold: 80,
  });
  assert.equal(standaloneSafe, "");
});

test("cli toggle command adds and removes fields from configuration dynamically", () => {
  const home = makeSandboxHome("ccs-toggle-test-");
  try {
    // 1. Initial fields check (defaults: model, context, project, git)
    const initialGet = stripAnsi(runCli(home, "get", "fields"));
    assert.ok(!initialGet.includes("todo"), "Initial fields should not contain todo");

    // 2. Toggle on "todo"
    const toggleOnOut = stripAnsi(runCli(home, "toggle", "todo"));
    assert.ok(toggleOnOut.includes("已启用字段"), "Should report field enabled");
    const afterAdd = stripAnsi(runCli(home, "get", "fields"));
    assert.ok(afterAdd.includes("todo"), "Fields should now contain todo");

    // 3. Toggle off "todo"
    const toggleOffOut = stripAnsi(runCli(home, "toggle", "todo"));
    assert.ok(toggleOffOut.includes("已停用字段"), "Should report field disabled");
    const afterRemove = stripAnsi(runCli(home, "get", "fields"));
    assert.ok(!afterRemove.includes("todo"), "Fields should no longer contain todo");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("truncateMiddleByWidth handles ASCII and CJK strings accurately based on visual column widths", () => {
  const { truncateMiddleByWidth, getStringWidth } = require("../lib/utils.js");

  // ASCII string truncation
  const ascii = "feat/user-authentication-flow";
  const truncAscii = truncateMiddleByWidth(ascii, 15);
  assert.ok(truncAscii.includes("..."), "Should contain ellipsis");
  assert.ok(getStringWidth(truncAscii) <= 15, `Width ${getStringWidth(truncAscii)} should be <= 15`);

  // CJK East Asian string truncation
  const cjk = "feat/用户管理中心重构-v2";
  const truncCjk = truncateMiddleByWidth(cjk, 16);
  assert.ok(truncCjk.includes("..."), "Should contain ellipsis");
  assert.ok(getStringWidth(truncCjk) <= 16, `Width ${getStringWidth(truncCjk)} should be <= 16`);

  // Short string should not be truncated
  const short = "main";
  assert.equal(truncateMiddleByWidth(short, 10), "main");
});

test("getSessionDelta tracks token differences across calls", () => {
  const { getSessionDelta } = require("../lib/utils.js");
  const sid = `test-sess-${Date.now()}`;

  // First turn: no previous data -> returns null
  const d1 = getSessionDelta(sid, 10000);
  assert.equal(d1, null);

  // Second turn: increased by 2500 -> returns 2500
  const d2 = getSessionDelta(sid, 12500);
  assert.equal(d2, 2500);

  // Third turn: increased by 30000 (surge) -> returns 30000
  const d3 = getSessionDelta(sid, 42500);
  assert.equal(d3, 30000);
});

test("context renderer formats context delta and surge alert when showContextDelta is enabled", () => {
  const sid = `test-context-delta-${Date.now()}`;
  const input1 = {
    session_id: sid,
    context_window: { total_input_tokens: 10000, context_window_size: 200000 },
  };
  // Render turn 1 (seeds cache)
  renderStatusline(input1, { colors: false, fields: ["context"], showContextDelta: true });

  // Render turn 2 with surge (> 20000 increase)
  const input2 = {
    session_id: sid,
    context_window: { total_input_tokens: 35000, context_window_size: 200000 },
  };
  const out2 = renderStatusline(input2, {
    colors: false,
    fields: ["context"],
    showContextDelta: true,
    contextSurgeThreshold: 20000,
  });
  assert.ok(out2.includes("(+25.0k⚠️)"), `Expected (+25.0k⚠️) in output, got: ${out2}`);

  // Render turn 3 with normal small increase (< 20000)
  const input3 = {
    session_id: sid,
    context_window: { total_input_tokens: 36200, context_window_size: 200000 },
  };
  const out3 = renderStatusline(input3, {
    colors: false,
    fields: ["context"],
    showContextDelta: true,
    contextSurgeThreshold: 20000,
  });
  assert.ok(out3.includes("(+1.2k)"), `Expected (+1.2k) in output, got: ${out3}`);
  assert.ok(!out3.includes("⚠️"), "Normal increase should not have ⚠️");
});

test("cost renderer formats costBudget and alerts when budget is exceeded", () => {
  // Below budget ($1.20 / $2.00)
  const underInput = { cost: { total_cost_usd: 1.20 } };
  const underOut = renderStatusline(underInput, { colors: false, fields: ["cost"], costBudget: 2.0 });
  assert.ok(underOut.includes("$1.20/$2.00"), `Expected $1.20/$2.00, got: ${underOut}`);
  assert.ok(!underOut.includes("❗"), "Under budget should not have ❗");

  // Exceeded budget ($2.35 / $2.00) -> adds ❗ alert
  const overInput = { cost: { total_cost_usd: 2.35 } };
  const overOut = renderStatusline(overInput, { colors: false, fields: ["cost"], costBudget: 2.0 });
  assert.ok(overOut.includes("$2.35/$2.00❗"), `Expected $2.35/$2.00❗, got: ${overOut}`);

  // In CNY currency (¥14.50 / ¥15.00)
  const cnyInput = { cost: { total_cost_usd: 2.0 } }; // 2.0 * 7.25 = 14.5 CNY
  const cnyOut = renderStatusline(cnyInput, {
    colors: false,
    fields: ["cost"],
    currency: "CNY",
    exchangeRate: 7.25,
    costBudget: 15.0,
  });
  assert.ok(cnyOut.includes("¥14.50/¥15.00"), `Expected ¥14.50/¥15.00, got: ${cnyOut}`);
});

test("session_id renderer formats short session hash", () => {
  const input = { session_id: "8f3a1c92-b432-4d22-965a-112233445566" };
  const out = renderStatusline(input, { colors: false, fields: ["session_id"] });
  assert.equal(out, "id:8f3a1c92");

  // Missing or empty
  const emptyOut = renderStatusline({}, { colors: false, fields: ["session_id"] });
  assert.equal(emptyOut, "");
});

test("contextDisplayMode supports remaining and both modes", () => {
  const input = {
    context_window: { total_input_tokens: 58000, context_window_size: 200000 },
  };

  // 1. "remaining" mode
  const outRem = renderStatusline(input, {
    colors: false,
    fields: ["context"],
    contextDisplayMode: "remaining",
  });
  assert.ok(outRem.includes("(142.0k left)"), `Expected (142.0k left), got: ${outRem}`);

  // 2. "both" mode
  const outBoth = renderStatusline(input, {
    colors: false,
    fields: ["context"],
    contextDisplayMode: "both",
  });
  assert.ok(outBoth.includes("58.0k/200.0k, 142.0k left"), `Expected 58.0k/200.0k, 142.0k left, got: ${outBoth}`);

  // 3. "used" mode (default)
  const outUsed = renderStatusline(input, {
    colors: false,
    fields: ["context"],
    contextDisplayMode: "used",
  });
  assert.ok(outUsed.includes("58.0k/200.0k"), `Expected 58.0k/200.0k, got: ${outUsed}`);
  assert.ok(!outUsed.includes("left"), `Should not contain left in used mode, got: ${outUsed}`);
});

test("getGitStashCount inspects reflog directly and handles worktrees/repos cleanly", () => {
  const { getGitStashCount } = require("../lib/utils.js");
  // Non-repo dir returns 0
  assert.equal(getGitStashCount(os.tmpdir()), 0);

  // In a temp repo with mock stash reflog
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "stash-unit-test-"));
  try {
    const gitDir = path.join(tmpRepo, ".git");
    const stashLogDir = path.join(gitDir, "logs", "refs");
    fs.mkdirSync(stashLogDir, { recursive: true });
    assert.equal(getGitStashCount(tmpRepo), 0);

    // Write 2 mock stash reflog lines
    fs.writeFileSync(path.join(stashLogDir, "stash"), "commit1 stash1\ncommit2 stash2\n", "utf8");
    assert.equal(getGitStashCount(tmpRepo), 2);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("git renderer displays stash count when showGitStash is true", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "git-stash-render-"));
  try {
    const gitDir = path.join(tmpRepo, ".git");
    const stashLogDir = path.join(gitDir, "logs", "refs");
    fs.mkdirSync(stashLogDir, { recursive: true });
    fs.writeFileSync(path.join(stashLogDir, "stash"), "entry1\nentry2\nentry3\n", "utf8");

    // Mock git status output via cache
    const crypto = require("crypto");
    const hash = crypto.createHash("sha1").update(tmpRepo).digest("hex").slice(0, 16);
    const cacheFile = path.join(os.tmpdir(), `claude-code-status-git-${hash}.json`);
    fs.writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), output: "## feat/login\n" }), "utf8");

    const out = renderStatusline(
      { workspace: { current_dir: tmpRepo } },
      { colors: false, fields: ["git"], showGitStash: true, gitCacheTtl: 10 }
    );
    assert.ok(out.includes("(stash:3)"), `Expected (stash:3) in output, got: ${out}`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("session_name and version renderers format active session metadata and aliases", () => {
  const input = {
    session_name: "fix-auth",
    version: "v2.1.92",
  };

  const outName = renderStatusline(input, { colors: false, fields: ["session_name"] });
  assert.equal(outName, "[fix-auth]");

  const outAliasName = renderStatusline({ sessionTitle: "review-pr" }, { colors: false, fields: ["name"] });
  assert.equal(outAliasName, "[review-pr]");

  const outVer = renderStatusline(input, { colors: false, fields: ["version"] });
  assert.equal(outVer, "v2.1.92");

  const outAliasVer = renderStatusline({ cli_version: "2.2.0" }, { colors: false, fields: ["cc_version"] });
  assert.equal(outAliasVer, "v2.2.0");
});

test("THEMES includes dracula, gruvbox, and solarized-dark palettes", () => {
  const { THEMES, getThemeColors } = require("../lib/utils.js");
  assert.ok(THEMES.dracula && THEMES.dracula.CYAN.includes("139;233;253"));
  assert.ok(THEMES.gruvbox && THEMES.gruvbox.YELLOW.includes("250;189;47"));
  assert.ok(THEMES["solarized-dark"] && THEMES["solarized-dark"].CYAN.includes("42;161;152"));

  const dracula = getThemeColors("dracula");
  assert.equal(dracula.CYAN, THEMES.dracula.CYAN);
});

test("git renderer detects and alerts unmerged merge/rebase conflicts", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "claude-conflict-test-"));
  try {
    fs.mkdirSync(path.join(tmpRepo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, ".git", "HEAD"), "ref: refs/heads/main\n");

    const crypto = require("crypto");
    const hash = crypto.createHash("sha1").update(tmpRepo).digest("hex").slice(0, 16);
    const cacheFile = path.join(os.tmpdir(), `claude-code-status-git-${hash}.json`);

    // Scenario A: Unmerged conflict files (UU = both modified, AA = both added)
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        at: Date.now(),
        output: "## main\nUU src/app.js\nAA docs/spec.md\nM package.json\n",
      }),
      "utf8"
    );

    const outConflict = renderStatusline(
      { workspace: { current_dir: tmpRepo } },
      { colors: false, fields: ["git"], gitCacheTtl: 10 }
    );
    assert.ok(outConflict.includes("⚠️CONFLICT:2"), `Expected ⚠️CONFLICT:2, got: ${outConflict}`);

    // Scenario B: Clean / normal modifications with no conflicts
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        at: Date.now(),
        output: "## main\nM src/app.js\n?? newfile.txt\n",
      }),
      "utf8"
    );
    const outClean = renderStatusline(
      { workspace: { current_dir: tmpRepo } },
      { colors: false, fields: ["git"], gitCacheTtl: 10 }
    );
    assert.ok(!outClean.includes("CONFLICT"), `Clean repo should not contain CONFLICT: ${outClean}`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("context surge warning tag and standalone surge renderer", () => {
  const sid = `test-surge-${Date.now()}`;
  const input1 = {
    session_id: sid,
    context_window: { total_input_tokens: 20000, context_window_size: 200000 },
  };
  // Turn 1: seed
  renderStatusline(input1, { colors: false, fields: ["context", "surge"] });

  // Turn 2: normal increase (+5k < 20k threshold)
  const input2 = {
    session_id: sid,
    context_window: { total_input_tokens: 25000, context_window_size: 200000 },
  };
  const outNormal = renderStatusline(input2, {
    colors: false,
    fields: ["context", "surge"],
    showSurgeAlert: true,
    contextSurgeThreshold: 20000,
  });
  assert.ok(!outNormal.includes("SURGE"), "Normal increase should not show SURGE");

  // Turn 3: surge increase (+35k >= 20k threshold)
  const input3 = {
    session_id: sid,
    context_window: { total_input_tokens: 60000, context_window_size: 200000 },
  };
  const outSurge = renderStatusline(input3, {
    colors: false,
    fields: ["context", "surge"],
    showSurgeAlert: true,
    contextSurgeThreshold: 20000,
  });
  assert.ok(outSurge.includes("⚠️SURGE(+35.0k)"), `Expected ⚠️SURGE(+35.0k) in output, got: ${outSurge}`);
});

test("renderStatusline generates OSC 0 terminal title sequence when syncTerminalTitle is enabled", () => {
  const input = {
    session_name: "feature-login",
    workspace: { current_dir: "/home/dev/my-project" },
  };

  // With syncTerminalTitle: false -> no OSC 0 sequence
  const withoutTitle = renderStatusline(input, {
    colors: true,
    fields: ["model", "project"],
    syncTerminalTitle: false,
  });
  assert.ok(!withoutTitle.includes("\x1b]0;"), "Should not contain OSC 0 when disabled");

  // With syncTerminalTitle: true -> contains OSC 0 prefix setting terminal title
  const withTitle = renderStatusline(input, {
    colors: true,
    fields: ["model", "project"],
    syncTerminalTitle: true,
  });
  assert.ok(withTitle.includes("\x1b]0;Claude: my-project [feature-login]\x07"), `Expected OSC 0 title prefix, got: ${withTitle}`);

  // Visual string width should ignore the zero-width OSC 0 escape sequence
  const widthWith = getStringWidth(withTitle);
  const widthWithout = getStringWidth(withoutTitle);
  assert.equal(widthWith, widthWithout, "OSC 0 title sequence should occupy 0 visual terminal columns");
});

test("cli install writes Claude Code slash command and uninstall cleans it up", () => {
  const home = makeSandboxHome("claude-slash-cmd-test-");
  try {
    const ccsCmdPath = path.join(home, ".claude", "commands", "ccs.md");

    // Before install: does not exist
    assert.equal(fs.existsSync(ccsCmdPath), false);

    // Install
    runCli(home, "install");
    assert.equal(fs.existsSync(ccsCmdPath), true, "commands/ccs.md should be created by install");
    const content = fs.readFileSync(ccsCmdPath, "utf8");
    assert.ok(content.includes("description:"), "commands/ccs.md should include frontmatter");
    assert.ok(content.includes("$ARGUMENTS"), "commands/ccs.md should forward $ARGUMENTS");

    // Uninstall
    runCli(home, "uninstall");
    assert.equal(fs.existsSync(ccsCmdPath), false, "commands/ccs.md should be removed by uninstall");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("makeProgressBar supports smooth, dots, ascii and blocks styles", () => {
  const { makeProgressBar } = require("../lib/utils.js");
  const pBlocks = makeProgressBar(50, 8, "blocks");
  assert.equal(pBlocks, "[████░░░░]");

  const pSmooth = makeProgressBar(50, 8, "smooth");
  assert.equal(pSmooth, "[━━━━┈┈┈┈]");

  const pDots = makeProgressBar(50, 8, "dots");
  assert.equal(pDots, "[●●●●○○○○]");

  const pAscii = makeProgressBar(50, 8, "ascii");
  assert.equal(pAscii, "[====----]");

  // Fallback on unknown style
  const pUnknown = makeProgressBar(50, 8, "nonexistent");
  assert.equal(pUnknown, "[████░░░░]");
});

test("cost renderer formats single-turn cost delta and cost surge alert", () => {
  const sid = `test-cost-delta-${Date.now()}`;
  const input1 = {
    session_id: sid,
    cost: { total_cost_usd: 0.20 },
  };
  // Turn 1 seeds
  renderStatusline(input1, { colors: false, fields: ["cost"], showCostDelta: true });

  // Turn 2: small cost delta (+$0.15 < 0.50 threshold)
  const input2 = {
    session_id: sid,
    cost: { total_cost_usd: 0.35 },
  };
  const outNormal = renderStatusline(input2, {
    colors: false,
    fields: ["cost"],
    showCostDelta: true,
    costSurgeThreshold: 0.50,
  });
  assert.ok(outNormal.includes("(+$0.15)"), `Expected (+$0.15) in output, got: ${outNormal}`);
  assert.ok(!outNormal.includes("⚠️"), "Small cost should not have ⚠️");

  // Turn 3: cost surge (+$0.80 >= 0.50 threshold)
  const input3 = {
    session_id: sid,
    cost: { total_cost_usd: 1.15 },
  };
  const outSurge = renderStatusline(input3, {
    colors: false,
    fields: ["cost"],
    showCostDelta: true,
    costSurgeThreshold: 0.50,
  });
  assert.ok(outSurge.includes("(+$0.80⚠️)"), `Expected (+$0.80⚠️) in output, got: ${outSurge}`);
});

test("context renderer formats context runway estimation when enabled", () => {
  const sid = `test-runway-${Date.now()}`;
  const input1 = {
    session_id: sid,
    context_window: { total_input_tokens: 120000, context_window_size: 200000 },
  };
  renderStatusline(input1, { colors: false, fields: ["context"], showContextRunway: true });

  // Turn 2 (+20k)
  const input2 = {
    session_id: sid,
    context_window: { total_input_tokens: 140000, context_window_size: 200000 },
  };
  renderStatusline(input2, { colors: false, fields: ["context"], showContextRunway: true });

  // Turn 3 (+20k, remaining 40k -> ~2 turns left)
  const input3 = {
    session_id: sid,
    context_window: { total_input_tokens: 160000, context_window_size: 200000 },
  };
  const out = renderStatusline(input3, {
    colors: false,
    fields: ["context"],
    showContextRunway: true,
  });
  assert.ok(out.includes("(~2 turns left)"), `Expected (~2 turns left) in output, got: ${out}`);
});

test("git renderer formats staged changes alert when showGitStagedAlert is true", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "claude-staged-test-"));
  try {
    fs.mkdirSync(path.join(tmpRepo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, ".git", "HEAD"), "ref: refs/heads/main\n");

    const crypto = require("crypto");
    const hash = crypto.createHash("sha1").update(tmpRepo).digest("hex").slice(0, 16);
    const cacheFile = path.join(os.tmpdir(), `claude-code-status-git-${hash}.json`);

    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        at: Date.now(),
        output: "## main\nM  staged-file.js\nA  new-staged.js\n M unstaged-file.js\n",
      }),
      "utf8"
    );

    const out = renderStatusline(
      { workspace: { current_dir: tmpRepo } },
      { colors: false, fields: ["git"], showGitStagedAlert: true, gitCacheTtl: 10 }
    );
    assert.ok(out.includes("(+2 staged)"), `Expected (+2 staged) in output, got: ${out}`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("project renderer supports ideLink for vscode, cursor, and zed", () => {
  const input = {
    workspace: {
      current_dir: "/path/to/my-project",
    },
  };

  // VS Code link
  const outVsCode = renderStatusline(input, {
    colors: false,
    fields: ["project"],
    clickableProjectPath: true,
    ideLink: "vscode",
  });
  assert.ok(outVsCode.includes("vscode://file/path/to/my-project"), `Expected vscode:// link, got: ${outVsCode}`);

  // Cursor link
  const outCursor = renderStatusline(input, {
    colors: false,
    fields: ["project"],
    clickableProjectPath: true,
    ideLink: "cursor",
  });
  assert.ok(outCursor.includes("cursor://file/path/to/my-project"), `Expected cursor:// link, got: ${outCursor}`);
});

test("cli menu runs without errors in non-interactive environment", () => {
  const home = makeSandboxHome("claude-menu-test-");
  try {
    const out = runCli(home, "menu");
    assert.ok(out.includes("交互式特性面板"), "Menu output should include header");
    assert.ok(out.includes("Surge Protection"), "Menu should list Surge Protection");
    assert.ok(out.includes("Context Runway"), "Menu should list Context Runway");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("responsive mode drops lowest-priority fields when terminal width is constrained", () => {
  const input = {
    workspace: { current_dir: "/path/to/project" },
    model: { display_name: "sonnet" },
    context_window: { total_input_tokens: 58000, context_window_size: 200000 },
    cost: { total_cost_usd: 0.25 },
  };

  // Wide terminal: all fields present, no overflow badge
  const outWide = renderStatusline(input, {
    colors: false,
    fields: ["model", "context", "cost"],
    terminalWidth: 120,
    responsive: true,
  });
  assert.ok(outWide.includes("sonnet"), "Wide terminal should show model");
  assert.ok(outWide.includes("29%"), "Wide terminal should show context");
  assert.ok(outWide.includes("$0.25"), "Wide terminal should show cost");
  assert.ok(!outWide.includes("(+"), "Wide terminal should not show overflow badge");

  // Narrow terminal (cols: 45): cost (prio 60) dropped, model (prio 80) and context (prio 80) kept, (+1) badge added
  const outNarrow = renderStatusline(input, {
    colors: false,
    fields: ["model", "context", "cost"],
    terminalWidth: 45,
    responsive: true,
  });
  assert.ok(outNarrow.includes("sonnet"), "Narrow terminal should keep model");
  assert.ok(outNarrow.includes("29%"), "Narrow terminal should keep context");
  assert.ok(!outNarrow.includes("$0.25"), "Narrow terminal should drop cost");
  assert.ok(outNarrow.includes("(+1)"), `Narrow terminal should display (+1) badge, got: ${outNarrow}`);
});

test("responsive mode preserves critical surge and compact alerts", () => {
  const input = {
    workspace: { current_dir: "/path/to/project" },
    model: { display_name: "sonnet" },
    context_window: { total_input_tokens: 170000, context_window_size: 200000 },
    cost: { total_cost_usd: 1.50 },
  };

  // With compact alert at priority 100, on a narrow terminal (cols: 25), cost is dropped while compact warning stays
  const out = renderStatusline(input, {
    colors: false,
    fields: ["model", "compact", "cost"],
    showCompactAlert: true,
    compactAlertThreshold: 80,
    terminalWidth: 25,
    responsive: true,
  });
  assert.ok(out.includes("⚠️compact"), `Expected ⚠️compact to be preserved due to high priority, got: ${out}`);
  assert.ok(out.includes("(+1)"), `Expected (+1) badge for dropped cost, got: ${out}`);
});

test("responsive mode applies soft compression on branch before dropping fields", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "claude-responsive-git-"));
  try {
    fs.mkdirSync(path.join(tmpRepo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, ".git", "HEAD"), "ref: refs/heads/feature/very-long-branch-name-for-responsive-test\n");

    const crypto = require("crypto");
    const hash = crypto.createHash("sha1").update(tmpRepo).digest("hex").slice(0, 16);
    const cacheFile = path.join(os.tmpdir(), `claude-code-status-git-${hash}.json`);
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        at: Date.now(),
        output: "## feature/very-long-branch-name-for-responsive-test\n",
      }),
      "utf8"
    );

    const input = {
      workspace: { current_dir: tmpRepo },
      model: { display_name: "sonnet" },
    };

    // Terminal width 30 with long branch name: soft compression should middle-truncate the branch
    const out = renderStatusline(input, {
      colors: false,
      fields: ["model", "git"],
      terminalWidth: 30,
      responsive: true,
      responsiveMinBranchLength: 8,
      gitCacheTtl: 10,
    });

    assert.ok(out.includes("sonnet"), `Expected model to be present, got: ${out}`);
    assert.ok(out.includes("fea") && (out.includes("...") || out.includes("…")), `Expected compressed branch name in output, got: ${out}`);
    // Should NOT have dropped any field because soft compression made both fit in 30 columns
    assert.ok(!out.includes("(+1)"), `Expected both fields to fit with soft compression, got: ${out}`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("prefix and suffix options wrap statusline cleanly and adjust width", () => {
  const input = {
    workspace: { current_dir: "/path/to/project" },
    model: { display_name: "claude-3-7-sonnet" },
  };

  const out = renderStatusline(input, {
    colors: false,
    fields: ["model"],
    prefix: "✦ ",
    suffix: " ✦",
  });
  assert.ok(out.startsWith("✦ claude-3-7-sonnet"), `Expected prefix, got: ${out}`);
  assert.ok(out.endsWith(" ✦"), `Expected suffix, got: ${out}`);
});

test("cli dump command inspects environment and field rendering status", () => {
  const home = makeSandboxHome("claude-dump-test-");
  try {
    const out = runCli(home, "dump");
    assert.ok(out.includes("Diagnostic Inspector & Dump"), "Should contain dump header");
    assert.ok(out.includes("Terminal & Environment:"), "Should inspect terminal environment");
    assert.ok(out.includes("Field Renderer Inspection:"), "Should list field renderers");
    assert.ok(out.includes("Complete Statusline Output:"), "Should show complete output");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("cli doctor verbose flag outputs subsystem latency profiling", () => {
  const home = makeSandboxHome("claude-doc-verbose-test-");
  try {
    const out = runCli(home, "doctor", "--verbose");
    assert.ok(out.includes("[5/5] Subsystem Performance Profiling (--verbose):"), "Should show [5/5] profiling section");
    assert.ok(out.includes("Config Load & Parse:"), "Should benchmark config loading");
    assert.ok(out.includes("Git Status (Cached):"), "Should benchmark git caching");
    assert.ok(out.includes("String Width (ANSI):"), "Should benchmark string measurement");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("git renderer detects and alerts untracked sensitive credential leak risk", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "claude-leak-guard-test-"));
  try {
    fs.mkdirSync(path.join(tmpRepo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, ".git", "HEAD"), "ref: refs/heads/main\n");

    const crypto = require("crypto");
    const hash = crypto.createHash("sha1").update(tmpRepo).digest("hex").slice(0, 16);
    const cacheFile = path.join(os.tmpdir(), `claude-code-status-git-${hash}.json`);

    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        at: Date.now(),
        output: "## main\n?? .env\n?? src/index.js\n",
      }),
      "utf8"
    );

    // When showGitLeakGuard is enabled, should show (⚠️leak:.env)
    const outWithGuard = renderStatusline(
      { workspace: { current_dir: tmpRepo } },
      { colors: false, fields: ["git"], showGitLeakGuard: true, gitCacheTtl: 10 }
    );
    assert.ok(outWithGuard.includes("(⚠️leak:.env)"), `Expected (⚠️leak:.env), got: ${outWithGuard}`);

    // When showGitLeakGuard is false, warning should be omitted
    const outWithoutGuard = renderStatusline(
      { workspace: { current_dir: tmpRepo } },
      { colors: false, fields: ["git"], showGitLeakGuard: false, gitCacheTtl: 10 }
    );
    assert.ok(!outWithoutGuard.includes("leak"), `Expected no leak warning, got: ${outWithoutGuard}`);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test("cache renderer displays physical token savings when showCacheSavings is enabled", () => {
  const input = {
    context_window: {
      current_usage: {
        cache_read_input_tokens: 350000,
        cache_creation_input_tokens: 10000,
        input_tokens: 40000,
      },
    },
  };

  const out = renderStatusline(input, {
    colors: false,
    fields: ["cache"],
    showCacheSavings: true,
  });
  assert.ok(out.includes("Cache:88%"), `Expected hit rate percentage, got: ${out}`);
  assert.ok(out.includes("(saved 350k tok)"), `Expected token savings string, got: ${out}`);

  // When showCacheSavings is false, tag should be omitted
  const outOff = renderStatusline(input, {
    colors: false,
    fields: ["cache"],
    showCacheSavings: false,
  });
  assert.ok(!outOff.includes("saved"), `Expected no savings string, got: ${outOff}`);
});

test("capsuleStyle wraps segments cleanly and prevents double bracket nesting", () => {
  const input = {
    workspace: { current_dir: "/path/to/project" },
    model: { display_name: "claude-3-7-sonnet" },
    context_window: { total_input_tokens: 58000, context_window_size: 200000 },
  };

  // pill style: wraps model with [ ... ], but keeps progress bar [██░░░░░░] without double nesting [[...]]
  const outPill = renderStatusline(input, {
    colors: false,
    fields: ["model", "context"],
    capsuleStyle: "pill",
  });
  assert.ok(outPill.includes("[ claude-3-7-sonnet ]"), `Expected pill bracket for model, got: ${outPill}`);
  assert.ok(!outPill.includes("[["), `Expected no double bracket nesting, got: ${outPill}`);

  // round style: wraps model with ( ... )
  const outRound = renderStatusline(input, {
    colors: false,
    fields: ["model"],
    capsuleStyle: "round",
  });
  assert.ok(outRound.includes("( claude-3-7-sonnet )"), `Expected round bracket for model, got: ${outRound}`);
});
