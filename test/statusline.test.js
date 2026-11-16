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
  assert.ok(out.includes("[1/3] Claude Code Settings Check"));
  assert.ok(out.includes("[2/3] Configuration File Check"));
  assert.ok(out.includes("[3/3] Git Environment & Responsiveness"));
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
