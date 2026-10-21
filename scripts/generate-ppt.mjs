/**
 * Generate MarioCode introduction PPT via Windows COM (PowerPoint.Application)
 * - Opens PowerPoint window (Visible = true) so user can watch the generation
 * - No Python, pure Node.js + win32com
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = join(__dirname, "..", "MarioCode-介绍.pptx");

// VBScript that calls PowerPoint COM and saves the file
const vbsCode = `
Option Explicit
Dim pptApp, pres, slide, shape, textFrame, textRange
Dim outputPath
outputPath = WScript.Arguments(0)

' Create PowerPoint application (visible)
Set pptApp = CreateObject("PowerPoint.Application")
pptApp.Visible = 1

' Create presentation (16:9)
Set pres = pptApp.Presentations.Add(1)
pres.PageSetup.SlideWidth = 960
pres.PageSetup.SlideHeight = 540

' === Slide 1: Title ===
Set slide = pres.Slides.Add(1, 1)
slide.Shapes(1).TextFrame.TextRange.Text = "MarioCode"
slide.Shapes(1).TextFrame.TextRange.Font.Size = 66
slide.Shapes(1).TextFrame.TextRange.Font.Bold = 1
slide.Shapes(1).TextFrame.TextRange.Font.Color.RGB = RGB(15, 23, 42)
slide.Shapes(2).TextFrame.TextRange.Text = "Free, Open-Source Desktop GUI for Coding Agents" & vbCrLf & _
  "Claude Code · Codex · Pi in One App"
slide.Shapes(2).TextFrame.TextRange.Font.Size = 20
slide.Shapes(2).TextFrame.TextRange.Font.Color.RGB = RGB(71, 85, 105)
slide.Background.Fill.ForeColor.RGB = RGB(248, 250, 252)

' === Slide 2: What is MarioCode ===
Set slide = pres.Slides.Add(2, 2)
slide.Shapes(1).TextFrame.TextRange.Text = "What is MarioCode?"
slide.Shapes(1).TextFrame.TextRange.Font.Size = 44
slide.Shapes(1).TextFrame.TextRange.Font.Bold = 1
slide.Shapes(1).TextFrame.TextRange.Font.Color.RGB = RGB(15, 23, 42)

Set shape = slide.Shapes.AddTextbox(1, 80, 150, 800, 320)
Set textFrame = shape.TextFrame
textFrame.WordWrap = 1
Set textRange = textFrame.TextRange
textRange.Text = "A three-pane AI IDE built on official Agent SDKs:" & vbCrLf & vbCrLf & _
  "• Claude Agent SDK (@anthropic-ai/claude-agent-sdk)" & vbCrLf & _
  "• OpenAI Codex SDK (@openai/codex)" & vbCrLf & _
  "• Pi Coding Agent SDK (@earendil-works/pi-coding-agent)" & vbCrLf & vbCrLf & _
  "Does NOT reimplement the agent — provides the complete interaction surface:" & vbCrLf & _
  "Real-time streaming, tool approval, plan mode, Monaco editor, git, terminal, embedded browser, LSP, and mobile remote control."
textRange.Font.Size = 18
textRange.Font.Color.RGB = RGB(51, 65, 85)
slide.Background.Fill.ForeColor.RGB = RGB(248, 250, 252)

' === Slide 3: Key Highlights ===
Set slide = pres.Slides.Add(3, 2)
slide.Shapes(1).TextFrame.TextRange.Text = "Key Highlights"
slide.Shapes(1).TextFrame.TextRange.Font.Size = 44
slide.Shapes(1).TextFrame.TextRange.Font.Bold = 1
slide.Shapes(1).TextFrame.TextRange.Font.Color.RGB = RGB(15, 23, 42)

Set shape = slide.Shapes.AddTextbox(1, 80, 150, 800, 320)
Set textFrame = shape.TextFrame
textFrame.WordWrap = 1
Set textRange = textFrame.TextRange
textRange.Text = "🎛 Multi-provider — Claude, Codex, Pi in one app" & vbCrLf & _
  "⚡ Real-time streaming — token-by-token live output" & vbCrLf & _
  "✅ Tool approval UI — allow / always-allow / deny with queue" & vbCrLf & _
  "📋 Plan mode — research → approval → execute" & vbCrLf & _
  "🧩 Plugins & MCP — skills, commands, MCP servers for all engines" & vbCrLf & _
  "🌿 Worktree sessions — parallel sessions in isolated git worktrees" & vbCrLf & _
  "🧰 Full IDE — Monaco, diff, multi-repo git, terminal" & vbCrLf & _
  "🌐 Embedded browser — agent automation + element picking" & vbCrLf & _
  "📱 Mobile remote — LAN or SSH tunnel, full control from phone" & vbCrLf & _
  "🆓 MIT licensed — free forever, no tracking"
textRange.Font.Size = 16
textRange.Font.Color.RGB = RGB(51, 65, 85)
slide.Background.Fill.ForeColor.RGB = RGB(248, 250, 252)

' === Slide 4: Tech Stack ===
Set slide = pres.Slides.Add(4, 2)
slide.Shapes(1).TextFrame.TextRange.Text = "Tech Stack"
slide.Shapes(1).TextFrame.TextRange.Font.Size = 44
slide.Shapes(1).TextFrame.TextRange.Font.Bold = 1
slide.Shapes(1).TextFrame.TextRange.Font.Color.RGB = RGB(15, 23, 42)

Set shape = slide.Shapes.AddTextbox(1, 80, 150, 800, 320)
Set textFrame = shape.TextFrame
textFrame.WordWrap = 1
Set textRange = textFrame.TextRange
textRange.Text = "Shell: Electron 33, electron-vite, electron-builder 25" & vbCrLf & vbCrLf & _
  "Frontend: React 19, Zustand 5, Tailwind CSS 3, @base-ui/react" & vbCrLf & vbCrLf & _
  "Editor / Terminal: Monaco Editor, xterm.js + node-pty" & vbCrLf & vbCrLf & _
  "Agent: @anthropic-ai/claude-agent-sdk, @openai/codex," & vbCrLf & _
  "            @earendil-works/pi-coding-agent" & vbCrLf & vbCrLf & _
  "Persistence: better-sqlite3 (synchronous SQLite)" & vbCrLf & vbCrLf & _
  "Tooling: pnpm 11, Turbo, TypeScript 5 (strict)"
textRange.Font.Size = 18
textRange.Font.Color.RGB = RGB(51, 65, 85)
slide.Background.Fill.ForeColor.RGB = RGB(248, 250, 252)

' === Slide 5: Architecture ===
Set slide = pres.Slides.Add(5, 2)
slide.Shapes(1).TextFrame.TextRange.Text = "Architecture"
slide.Shapes(1).TextFrame.TextRange.Font.Size = 44
slide.Shapes(1).TextFrame.TextRange.Font.Bold = 1
slide.Shapes(1).TextFrame.TextRange.Font.Color.RGB = RGB(15, 23, 42)

Set shape = slide.Shapes.AddTextbox(1, 80, 150, 800, 320)
Set textFrame = shape.TextFrame
textFrame.WordWrap = 1
Set textRange = textFrame.TextRange
textRange.Text = "Three-pane layout:" & vbCrLf & vbCrLf & _
  "📂 Left — Projects & session sidebar (tree or stream mode)" & vbCrLf & vbCrLf & _
  "💬 Center — Real-time conversation with structured cards:" & vbCrLf & _
  "      • Streaming text, thinking, tool calls, tool results" & vbCrLf & _
  "      • Tool approval prompts (inline)" & vbCrLf & _
  "      • Plan mode review panel" & vbCrLf & vbCrLf & _
  "📁 Right — File tree, Monaco editor (Edit/Diff/Preview)," & vbCrLf & _
  "      multi-repo git, embedded browser" & vbCrLf & vbCrLf & _
  "🖥 Bottom — Multi-tab terminal (xterm.js + node-pty)"
textRange.Font.Size = 16
textRange.Font.Color.RGB = RGB(51, 65, 85)
slide.Background.Fill.ForeColor.RGB = RGB(248, 250, 252)

' === Slide 6: Multi-Provider ===
Set slide = pres.Slides.Add(6, 2)
slide.Shapes(1).TextFrame.TextRange.Text = "Multi-Provider Design"
slide.Shapes(1).TextFrame.TextRange.Font.Size = 44
slide.Shapes(1).TextFrame.TextRange.Font.Bold = 1
slide.Shapes(1).TextFrame.TextRange.Font.Color.RGB = RGB(15, 23, 42)

Set shape = slide.Shapes.AddTextbox(1, 80, 150, 800, 320)
Set textFrame = shape.TextFrame
textFrame.WordWrap = 1
Set textRange = textFrame.TextRange
textRange.Text = "Provider abstraction layer (AgentProvider interface):" & vbCrLf & vbCrLf & _
  "• Claude provider → @anthropic-ai/claude-agent-sdk" & vbCrLf & _
  "   Uses Anthropic API key, supports all Claude models" & vbCrLf & vbCrLf & _
  "• Codex provider → @openai/codex app-server" & vbCrLf & _
  "   OpenAI-compatible / Responses API endpoints" & vbCrLf & _
  "   Third-party gateways, custom context windows" & vbCrLf & vbCrLf & _
  "• Pi provider → @earendil-works/pi-coding-agent" & vbCrLf & _
  "   Configured via Settings → Models" & vbCrLf & vbCrLf & _
  "Each declares capabilities → UI adapts automatically" & vbCrLf & _
  "(thinking levels, permission modes, built-in models)"
textRange.Font.Size = 16
textRange.Font.Color.RGB = RGB(51, 65, 85)
slide.Background.Fill.ForeColor.RGB = RGB(248, 250, 252)

' === Slide 7: Mobile Remote Control ===
Set slide = pres.Slides.Add(7, 2)
slide.Shapes(1).TextFrame.TextRange.Text = "Mobile Remote Control"
slide.Shapes(1).TextFrame.TextRange.Font.Size = 44
slide.Shapes(1).TextFrame.TextRange.Font.Bold = 1
slide.Shapes(1).TextFrame.TextRange.Font.Color.RGB = RGB(15, 23, 42)

Set shape = slide.Shapes.AddTextbox(1, 80, 150, 800, 320)
Set textFrame = shape.TextFrame
textFrame.WordWrap = 1
Set textRange = textFrame.TextRange
textRange.Text = "Full remote control from your phone:" & vbCrLf & vbCrLf & _
  "📱 LAN access" & vbCrLf & _
  "   • Desktop serves a companion web app" & vbCrLf & _
  "   • Scan QR code to pair (device-token auth)" & vbCrLf & vbCrLf & _
  "🌍 Remote access from anywhere" & vbCrLf & _
  "   • SSH reverse tunnel through your own VPS" & vbCrLf & _
  "   • No third-party tunneling service" & vbCrLf & vbCrLf & _
  "Features:" & vbCrLf & _
  "   • Watch sessions stream live" & vbCrLf & _
  "   • Send messages, interrupt/rewind turns" & vbCrLf & _
  "   • Approve tool calls" & vbCrLf & _
  "   • Browse files & diffs, run git operations"
textRange.Font.Size = 16
textRange.Font.Color.RGB = RGB(51, 65, 85)
slide.Background.Fill.ForeColor.RGB = RGB(248, 250, 252)

' === Slide 8: Why MarioCode ===
Set slide = pres.Slides.Add(8, 2)
slide.Shapes(1).TextFrame.TextRange.Text = "Why MarioCode?"
slide.Shapes(1).TextFrame.TextRange.Font.Size = 44
slide.Shapes(1).TextFrame.TextRange.Font.Bold = 1
slide.Shapes(1).TextFrame.TextRange.Font.Color.RGB = RGB(15, 23, 42)

Set shape = slide.Shapes.AddTextbox(1, 80, 150, 800, 320)
Set textFrame = shape.TextFrame
textFrame.WordWrap = 1
Set textRange = textFrame.TextRange
textRange.Text = "✅ Unified interface for three agent platforms" & vbCrLf & vbCrLf & _
  "✅ Full desktop IDE experience (not a web wrapper)" & vbCrLf & vbCrLf & _
  "✅ Real control — approve/deny every tool call, review plans" & vbCrLf & vbCrLf & _
  "✅ Mobile companion — work from anywhere" & vbCrLf & vbCrLf & _
  "✅ Worktree sessions — parallel work without conflicts" & vbCrLf & vbCrLf & _
  "✅ Open source, MIT licensed — free forever" & vbCrLf & vbCrLf & _
  "✅ No tracking, no account required"
textRange.Font.Size = 20
textRange.Font.Color.RGB = RGB(51, 65, 85)
slide.Background.Fill.ForeColor.RGB = RGB(248, 250, 252)

' === Slide 9: Get Started ===
Set slide = pres.Slides.Add(9, 2)
slide.Shapes(1).TextFrame.TextRange.Text = "Get Started"
slide.Shapes(1).TextFrame.TextRange.Font.Size = 44
slide.Shapes(1).TextFrame.TextRange.Font.Bold = 1
slide.Shapes(1).TextFrame.TextRange.Font.Color.RGB = RGB(15, 23, 42)

Set shape = slide.Shapes.AddTextbox(1, 80, 150, 800, 320)
Set textFrame = shape.TextFrame
textFrame.WordWrap = 1
Set textRange = textFrame.TextRange
textRange.Text = "📦 Download pre-built installers:" & vbCrLf & _
  "    GitHub Releases — macOS (dmg), Windows (exe)" & vbCrLf & _
  "    github.com/maxiaopang123/MarioCode/releases" & vbCrLf & vbCrLf & _
  "🛠 Build from source:" & vbCrLf & _
  "    pnpm install" & vbCrLf & _
  "    pnpm dev" & vbCrLf & vbCrLf & _
  "📋 Requirements:" & vbCrLf & _
  "    • Node.js ≥ 22.13, pnpm ≥ 9" & vbCrLf & _
  "    • Claude: ANTHROPIC_API_KEY" & vbCrLf & _
  "    • Codex/Pi: configure in Settings → Models" & vbCrLf & vbCrLf & _
  "⭐ Star on GitHub — share with others!"
textRange.Font.Size = 18
textRange.Font.Color.RGB = RGB(51, 65, 85)
slide.Background.Fill.ForeColor.RGB = RGB(248, 250, 252)

' Save and close
pres.SaveAs outputPath
pres.Close
pptApp.Quit

WScript.Echo "✓ PPT saved: " & outputPath

Set textRange = Nothing
Set textFrame = Nothing
Set shape = Nothing
Set slide = Nothing
Set pres = Nothing
Set pptApp = Nothing
`.trim();

console.log("Generating MarioCode introduction PPT via COM...");
console.log("PowerPoint window will open — you can watch the slides being created.\n");

const vbs = spawn("cscript.exe", ["//Nologo", "//E:vbscript"], {
  stdio: ["pipe", "inherit", "inherit"],
  cwd: __dirname,
});

vbs.stdin.write(vbsCode);
vbs.stdin.end();

vbs.on("close", (code) => {
  if (code === 0) {
    console.log(`\n✓ Done. Output: ${outputPath}`);
  } else {
    console.error(`\n✗ VBScript exited with code ${code}`);
    process.exit(code);
  }
});
