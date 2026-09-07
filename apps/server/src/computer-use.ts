import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ToolError } from './errors.js';
import { mcpImageResult } from './mcp-content.js';
import type { ToolSpec } from './tools.js';

const execFileAsync = promisify(execFile);
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;
const MAX_TEXT = 20_000;
const MAX_BATCH_STEPS = 8;
const MAX_OUTPUT_PIXELS = 24_000_000;

type ScreenGeometry = { left: number; top: number; width: number; height: number };
type MouseButton = 'left' | 'right' | 'middle';
type ComputerAction = 'move' | 'click' | 'drag' | 'type' | 'key' | 'hotkey' | 'hold_key' | 'scroll' | 'wait';

const WINDOWS_INPUT_TYPE = `
using System;
using System.Runtime.InteropServices;
public static class PilotInput {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint nInputs, INPUT[] inputs, int cbSize);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extraInfo);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  public static void Text(string text) {
    foreach (char c in text) {
      var down = new INPUT { type = 1, U = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = 0x0004 } } };
      var up = new INPUT { type = 1, U = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = 0x0004 | 0x0002 } } };
      var inputs = new INPUT[] { down, up };
      if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2) throw new InvalidOperationException("SendInput failed");
    }
  }
  public static void KeyDown(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); }
  public static void KeyUp(byte vk) { keybd_event(vk, 0, 0x0002, UIntPtr.Zero); }
}
`;

function stringArg(value: unknown, name: string, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new ToolError('INVALID_ARGUMENT', `"${name}" is required.`);
    return undefined;
  }
  if (typeof value !== 'string' || (required && value.length === 0)) throw new ToolError('INVALID_ARGUMENT', `"${name}" must be a string.`);
  return value;
}

function integerArg(value: unknown, name: string, minimum: number, maximum: number, fallback?: number): number | undefined {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ToolError('INVALID_ARGUMENT', `"${name}" must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function requiredIntegerArg(value: unknown, name: string, minimum: number, maximum: number): number {
  const resolved = integerArg(value, name, minimum, maximum);
  if (resolved === undefined) throw new ToolError('INVALID_ARGUMENT', `"${name}" is required.`);
  return resolved;
}

function enumArg<T extends string>(value: unknown, name: string, values: readonly T[], fallback?: T): T {
  const resolved = value ?? fallback;
  if (typeof resolved !== 'string' || !values.includes(resolved as T)) throw new ToolError('INVALID_ARGUMENT', `"${name}" must be one of: ${values.join(', ')}.`);
  return resolved as T;
}

async function powershell(script: string, env: Record<string, string> = {}, timeoutMs = 15_000, maxBuffer = MAX_SCREENSHOT_BYTES * 3): Promise<string> {
  if (process.platform !== 'win32') throw new ToolError('DEPENDENCY_MISSING', 'Computer use currently has a Windows desktop driver only.', 'Add a macOS/Linux ComputerDriver implementation or run this capability on Windows.');
  try {
    const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer,
      env: { ...process.env, ...env },
    });
    return result.stdout.trim();
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown }).stderr === 'string' ? (error as { stderr: string }).stderr : '';
    if (stderr.includes('PILOT_BOUNDS')) throw new ToolError('INVALID_ARGUMENT', 'The requested desktop coordinate or region is outside the current virtual screen.');
    throw new ToolError('INTERNAL', `Windows desktop automation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function geometry(): Promise<ScreenGeometry> {
  const raw = await powershell(`Add-Type -AssemblyName System.Windows.Forms; $r=[System.Windows.Forms.SystemInformation]::VirtualScreen; Write-Output ("{0}|{1}|{2}|{3}" -f $r.Left,$r.Top,$r.Width,$r.Height)`);
  const [left, top, width, height] = raw.split('|').map(Number);
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new ToolError('INTERNAL', 'Could not determine virtual screen geometry.');
  return { left, top, width, height };
}

function validatePoint(geom: ScreenGeometry, x: number, y: number, label = 'Coordinate'): void {
  if (x < 0 || y < 0 || x >= geom.width || y >= geom.height) {
    throw new ToolError('INVALID_ARGUMENT', `${label} (${x}, ${y}) is outside screenshot bounds ${geom.width}x${geom.height}.`);
  }
}

function mouseFlags(button: MouseButton): [number, number] {
  return button === 'left' ? [0x0002, 0x0004] : button === 'right' ? [0x0008, 0x0010] : [0x0020, 0x0040];
}

function keyCode(name: string): number {
  const upper = name.trim().toUpperCase();
  const table: Record<string, number> = {
    BACKSPACE: 0x08, TAB: 0x09, ENTER: 0x0D, RETURN: 0x0D, SHIFT: 0x10, CTRL: 0x11, CONTROL: 0x11,
    ALT: 0x12, ESC: 0x1B, ESCAPE: 0x1B, SPACE: 0x20, PAGEUP: 0x21, PAGEDOWN: 0x22, END: 0x23, HOME: 0x24,
    LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28, INSERT: 0x2D, DELETE: 0x2E, WIN: 0x5B, META: 0x5B,
    F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75, F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7A, F12: 0x7B,
  };
  if (upper.length === 1 && /[A-Z0-9]/.test(upper)) return upper.charCodeAt(0);
  const code = table[upper];
  if (code === undefined) throw new ToolError('INVALID_ARGUMENT', `Unsupported key: ${name}.`, 'Use A-Z, 0-9, arrows, Enter, Tab, Escape, Ctrl, Shift, Alt, Win, Home/End/PageUp/PageDown/Insert/Delete, or F1-F12.');
  return code;
}

async function captureRegion(x: number, y: number, width: number, height: number, scale: number): Promise<{ buffer: Buffer; screen: ScreenGeometry; region: { x: number; y: number; width: number; height: number; scale: number } }> {
  const screen = await geometry();
  if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > screen.width || y + height > screen.height) {
    throw new ToolError('INVALID_ARGUMENT', `Capture region (${x}, ${y}, ${width}, ${height}) is outside screenshot bounds ${screen.width}x${screen.height}.`);
  }
  const outputPixels = width * height * scale * scale;
  if (outputPixels > MAX_OUTPUT_PIXELS) throw new ToolError('TOO_LARGE', `Requested desktop capture would produce ${outputPixels} pixels.`, `Keep scaled captures at or below ${MAX_OUTPUT_PIXELS} pixels.`);
  const raw = await powershell(`
Add-Type -AssemblyName System.Drawing
$src=New-Object System.Drawing.Bitmap ([int]$env:PILOT_W),([int]$env:PILOT_H)
$g=[System.Drawing.Graphics]::FromImage($src)
try {
  $g.CopyFromScreen([int]$env:PILOT_X,[int]$env:PILOT_Y,0,0,$src.Size)
  $scale=[int]$env:PILOT_SCALE
  $out=$src
  $og=$null
  if($scale -gt 1) {
    $out=New-Object System.Drawing.Bitmap ($src.Width*$scale),($src.Height*$scale)
    $og=[System.Drawing.Graphics]::FromImage($out)
    $og.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $og.DrawImage($src,0,0,$out.Width,$out.Height)
  }
  $ms=New-Object System.IO.MemoryStream
  try {
    $out.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output ([Convert]::ToBase64String($ms.ToArray()))
  } finally {
    $ms.Dispose()
    if($og){$og.Dispose()}
    if($out -ne $src){$out.Dispose()}
  }
} finally { $g.Dispose(); $src.Dispose() }
`, {
    PILOT_X: String(screen.left + x), PILOT_Y: String(screen.top + y), PILOT_W: String(width), PILOT_H: String(height), PILOT_SCALE: String(scale),
  }, 30_000, MAX_SCREENSHOT_BYTES * 3);
  const buffer = Buffer.from(raw, 'base64');
  if (buffer.byteLength > MAX_SCREENSHOT_BYTES) throw new ToolError('TOO_LARGE', `Desktop screenshot exceeded ${MAX_SCREENSHOT_BYTES} bytes.`, 'Capture a smaller region or use a lower zoom scale.');
  return { buffer, screen, region: { x, y, width, height, scale } };
}

async function cursorPosition(): Promise<{ x: number; y: number; screen: ScreenGeometry }> {
  const screen = await geometry();
  const raw = await powershell(`
Add-Type @'
${WINDOWS_INPUT_TYPE}
'@
[PilotInput]::SetProcessDPIAware() | Out-Null
$p=New-Object PilotInput+POINT
if(-not [PilotInput]::GetCursorPos([ref]$p)){ throw 'GetCursorPos failed' }
Write-Output ("{0}|{1}" -f $p.X,$p.Y)
`);
  const [absoluteX, absoluteY] = raw.split('|').map(Number);
  if (![absoluteX, absoluteY].every(Number.isFinite)) throw new ToolError('INTERNAL', 'Could not determine cursor position.');
  return { x: absoluteX - screen.left, y: absoluteY - screen.top, screen };
}

async function moveOrClick(action: 'move' | 'click', x: number, y: number, button: MouseButton, clicks: number): Promise<ScreenGeometry> {
  const geom = await geometry();
  validatePoint(geom, x, y);
  const [down, up] = mouseFlags(button);
  await powershell(`
Add-Type @'
${WINDOWS_INPUT_TYPE}
'@
[PilotInput]::SetProcessDPIAware() | Out-Null
if(-not [PilotInput]::SetCursorPos([int]$env:PILOT_X,[int]$env:PILOT_Y)){ throw 'SetCursorPos failed' }
if($env:PILOT_ACTION -eq 'click') {
  for($i=0; $i -lt [int]$env:PILOT_CLICKS; $i++) {
    [PilotInput]::mouse_event([uint32]$env:PILOT_DOWN,0,0,0,[UIntPtr]::Zero)
    [PilotInput]::mouse_event([uint32]$env:PILOT_UP,0,0,0,[UIntPtr]::Zero)
  }
}
`, { PILOT_ACTION: action, PILOT_X: String(geom.left + x), PILOT_Y: String(geom.top + y), PILOT_CLICKS: String(clicks), PILOT_DOWN: String(down), PILOT_UP: String(up) });
  return geom;
}

async function drag(fromX: number, fromY: number, toX: number, toY: number, button: MouseButton, durationMs: number): Promise<ScreenGeometry> {
  const geom = await geometry();
  validatePoint(geom, fromX, fromY, 'Drag start');
  validatePoint(geom, toX, toY, 'Drag end');
  const [down, up] = mouseFlags(button);
  const steps = Math.max(1, Math.min(60, Math.ceil(durationMs / 16)));
  await powershell(`
Add-Type @'
${WINDOWS_INPUT_TYPE}
'@
[PilotInput]::SetProcessDPIAware() | Out-Null
$sx=[int]$env:PILOT_SX; $sy=[int]$env:PILOT_SY; $tx=[int]$env:PILOT_TX; $ty=[int]$env:PILOT_TY; $steps=[int]$env:PILOT_STEPS
[PilotInput]::SetCursorPos($sx,$sy) | Out-Null
[PilotInput]::mouse_event([uint32]$env:PILOT_DOWN,0,0,0,[UIntPtr]::Zero)
try {
  for($i=1; $i -le $steps; $i++) {
    $x=[int]($sx+(($tx-$sx)*$i/$steps)); $y=[int]($sy+(($ty-$sy)*$i/$steps))
    [PilotInput]::SetCursorPos($x,$y) | Out-Null
    if([int]$env:PILOT_DELAY -gt 0){ Start-Sleep -Milliseconds ([int]$env:PILOT_DELAY) }
  }
} finally { [PilotInput]::mouse_event([uint32]$env:PILOT_UP,0,0,0,[UIntPtr]::Zero) }
`, {
    PILOT_SX: String(geom.left + fromX), PILOT_SY: String(geom.top + fromY), PILOT_TX: String(geom.left + toX), PILOT_TY: String(geom.top + toY),
    PILOT_STEPS: String(steps), PILOT_DELAY: String(Math.floor(durationMs / steps)), PILOT_DOWN: String(down), PILOT_UP: String(up),
  }, Math.max(15_000, durationMs + 5_000));
  return geom;
}

async function sendKeys(codes: number[], holdMs = 0): Promise<void> {
  await powershell(`
Add-Type @'
${WINDOWS_INPUT_TYPE}
'@
[PilotInput]::SetProcessDPIAware() | Out-Null
$codes=$env:PILOT_KEYS.Split(',') | ForEach-Object {[byte][int]$_}
foreach($code in $codes){ [PilotInput]::KeyDown($code) }
try { if([int]$env:PILOT_HOLD -gt 0){ Start-Sleep -Milliseconds ([int]$env:PILOT_HOLD) } }
finally { [array]::Reverse($codes); foreach($code in $codes){ [PilotInput]::KeyUp($code) } }
`, { PILOT_KEYS: codes.join(','), PILOT_HOLD: String(holdMs) }, Math.max(15_000, holdMs + 5_000));
}

async function typeText(text: string): Promise<void> {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  await powershell(`
Add-Type @'
${WINDOWS_INPUT_TYPE}
'@
[PilotInput]::SetProcessDPIAware() | Out-Null
$text=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PILOT_TEXT_B64))
[PilotInput]::Text($text)
`, { PILOT_TEXT_B64: encoded }, 30_000);
}

async function scroll(delta: number, x?: number, y?: number): Promise<ScreenGeometry> {
  const geom = await geometry();
  if ((x === undefined) !== (y === undefined)) throw new ToolError('INVALID_ARGUMENT', 'Provide both "x" and "y" for positioned scrolling, or neither.');
  if (x !== undefined && y !== undefined) {
    validatePoint(geom, x, y);
    await powershell(`
Add-Type @'
${WINDOWS_INPUT_TYPE}
'@
[PilotInput]::SetProcessDPIAware() | Out-Null
[PilotInput]::SetCursorPos([int]$env:PILOT_X,[int]$env:PILOT_Y) | Out-Null
[PilotInput]::mouse_event(0x0800,0,0,[uint32][int32]$env:PILOT_DELTA,[UIntPtr]::Zero)
`, { PILOT_X: String(geom.left + x), PILOT_Y: String(geom.top + y), PILOT_DELTA: String(delta) });
  } else {
    await powershell(`
Add-Type @'
${WINDOWS_INPUT_TYPE}
'@
[PilotInput]::mouse_event(0x0800,0,0,[uint32][int32]$env:PILOT_DELTA,[UIntPtr]::Zero)
`, { PILOT_DELTA: String(delta) });
  }
  return geom;
}

async function actionStep(args: Record<string, unknown>, batch = false): Promise<Record<string, unknown>> {
  const action = enumArg(args.action, 'action', ['move', 'click', 'drag', 'type', 'key', 'hotkey', 'hold_key', 'scroll', 'wait'] as const) as ComputerAction;
  if (action === 'wait') {
    const durationMs = requiredIntegerArg(args.duration_ms, 'duration_ms', 0, batch ? 5_000 : 30_000);
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    return { action, waitedMs: durationMs };
  }
  if (action === 'move' || action === 'click') {
    const x = requiredIntegerArg(args.x, 'x', 0, 100_000);
    const y = requiredIntegerArg(args.y, 'y', 0, 100_000);
    const button = enumArg(args.button, 'button', ['left', 'right', 'middle'] as const, 'left');
    const clicks = action === 'click' ? integerArg(args.clicks, 'clicks', 1, 3, 1)! : 1;
    const screen = await moveOrClick(action, x, y, button, clicks);
    return { action, x, y, ...(action === 'click' ? { button, clicks } : {}), screen, coordinateSpace: 'screenshot-relative' };
  }
  if (action === 'drag') {
    const x = requiredIntegerArg(args.x, 'x', 0, 100_000);
    const y = requiredIntegerArg(args.y, 'y', 0, 100_000);
    const toX = requiredIntegerArg(args.to_x, 'to_x', 0, 100_000);
    const toY = requiredIntegerArg(args.to_y, 'to_y', 0, 100_000);
    const button = enumArg(args.button, 'button', ['left', 'right', 'middle'] as const, 'left');
    const durationMs = integerArg(args.duration_ms, 'duration_ms', 0, batch ? 2_000 : 5_000, 300)!;
    const screen = await drag(x, y, toX, toY, button, durationMs);
    return { action, from: { x, y }, to: { x: toX, y: toY }, button, durationMs, screen, coordinateSpace: 'screenshot-relative' };
  }
  if (action === 'type') {
    const text = stringArg(args.text, 'text', true)!;
    if (text.length > MAX_TEXT) throw new ToolError('TOO_LARGE', `"text" exceeds the ${MAX_TEXT} character desktop typing limit.`);
    await typeText(text);
    return { action, typedCharacters: text.length };
  }
  if (action === 'key') {
    const key = stringArg(args.key, 'key', true)!;
    await sendKeys([keyCode(key)]);
    return { action, key };
  }
  if (action === 'hotkey') {
    const keys = args.keys;
    if (!Array.isArray(keys) || keys.length < 2 || keys.length > 8 || keys.some((entry) => typeof entry !== 'string')) throw new ToolError('INVALID_ARGUMENT', '"keys" must contain 2-8 key names.');
    const names = keys as string[];
    await sendKeys(names.map(keyCode));
    return { action, keys: names };
  }
  if (action === 'hold_key') {
    const key = stringArg(args.key, 'key', true)!;
    const durationMs = requiredIntegerArg(args.duration_ms, 'duration_ms', 1, batch ? 2_000 : 5_000);
    await sendKeys([keyCode(key)], durationMs);
    return { action, key, durationMs };
  }
  const delta = requiredIntegerArg(args.delta, 'delta', -12_000, 12_000);
  if (delta === 0) throw new ToolError('INVALID_ARGUMENT', '"delta" must be non-zero. Positive scrolls up; negative scrolls down.');
  const x = integerArg(args.x, 'x', 0, 100_000);
  const y = integerArg(args.y, 'y', 0, 100_000);
  const screen = await scroll(delta, x, y);
  return { action, delta, ...(x === undefined ? {} : { x, y }), screen, coordinateSpace: 'screenshot-relative' };
}

export async function computerObserve(args: Record<string, unknown>): Promise<unknown> {
  const action = enumArg(args.action, 'action', ['screenshot', 'cursor', 'zoom'] as const);
  if (action === 'cursor') {
    const cursor = await cursorPosition();
    return { action, x: cursor.x, y: cursor.y, screen: cursor.screen, coordinateSpace: 'screenshot-relative' };
  }
  const screen = await geometry();
  const x = action === 'zoom' ? requiredIntegerArg(args.x, 'x', 0, Math.max(0, screen.width - 1)) : 0;
  const y = action === 'zoom' ? requiredIntegerArg(args.y, 'y', 0, Math.max(0, screen.height - 1)) : 0;
  const width = action === 'zoom' ? requiredIntegerArg(args.width, 'width', 1, screen.width) : screen.width;
  const height = action === 'zoom' ? requiredIntegerArg(args.height, 'height', 1, screen.height) : screen.height;
  const scale = action === 'zoom' ? integerArg(args.scale, 'scale', 1, 4, 2)! : 1;
  const shot = await captureRegion(x, y, width, height, scale);
  return mcpImageResult(shot.buffer, 'image/png', {
    action,
    screen: shot.screen,
    region: shot.region,
    imageWidth: width * scale,
    imageHeight: height * scale,
    bytes: shot.buffer.byteLength,
    coordinateSpace: 'screenshot-relative',
  });
}

export async function computerAct(args: Record<string, unknown>): Promise<unknown> {
  const action = enumArg(args.action, 'action', ['move', 'click', 'drag', 'type', 'key', 'hotkey', 'hold_key', 'scroll', 'wait', 'batch'] as const);
  if (action !== 'batch') return actionStep(args);
  if (!Array.isArray(args.steps) || args.steps.length === 0 || args.steps.length > MAX_BATCH_STEPS || args.steps.some((step) => !step || typeof step !== 'object' || Array.isArray(step))) {
    throw new ToolError('INVALID_ARGUMENT', `"steps" must be an array of 1-${MAX_BATCH_STEPS} computer action objects.`);
  }
  const steps = args.steps as Record<string, unknown>[];
  const typed = steps.reduce((sum, step) => sum + (typeof step.text === 'string' ? step.text.length : 0), 0);
  if (typed > MAX_TEXT) throw new ToolError('TOO_LARGE', `Batch desktop typing exceeds ${MAX_TEXT} total characters.`);
  const totalWait = steps.reduce((sum, step) => sum + (typeof step.duration_ms === 'number' && step.action === 'wait' ? step.duration_ms : 0), 0);
  if (totalWait > 15_000) throw new ToolError('TOO_LARGE', 'Batch desktop waits exceed 15,000 ms total.');
  const results: Record<string, unknown>[] = [];
  for (const step of steps) results.push(await actionStep(step, true));
  return { action, results };
}

const ACT_PROPERTIES = {
  action: { type: 'string', enum: ['move', 'click', 'drag', 'type', 'key', 'hotkey', 'hold_key', 'scroll', 'wait', 'batch'] },
  x: { type: 'integer', minimum: 0, maximum: 100000, description: 'Screenshot-relative X coordinate.' },
  y: { type: 'integer', minimum: 0, maximum: 100000, description: 'Screenshot-relative Y coordinate.' },
  to_x: { type: 'integer', minimum: 0, maximum: 100000 },
  to_y: { type: 'integer', minimum: 0, maximum: 100000 },
  button: { type: 'string', enum: ['left', 'right', 'middle'] },
  clicks: { type: 'integer', minimum: 1, maximum: 3 },
  text: { type: 'string', maxLength: MAX_TEXT },
  key: { type: 'string' },
  keys: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'string' } },
  delta: { type: 'integer', minimum: -12000, maximum: 12000 },
  duration_ms: { type: 'integer', minimum: 0, maximum: 30000 },
};

export function createComputerUseSpecs(): ToolSpec[] {
  return [
    {
      name: 'computer_observe',
      description: 'Observe the Windows desktop without injecting input: capture the full virtual screen, read cursor position, or capture/upscale a bounded region for visual zoom.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['screenshot', 'cursor', 'zoom'] },
          x: { type: 'integer', minimum: 0, maximum: 100000 },
          y: { type: 'integer', minimum: 0, maximum: 100000 },
          width: { type: 'integer', minimum: 1, maximum: 100000 },
          height: { type: 'integer', minimum: 1, maximum: 100000 },
          scale: { type: 'integer', minimum: 1, maximum: 4, description: 'Zoom scale for region capture; defaults to 2.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: computerObserve,
    },
    {
      name: 'computer_act',
      description: 'Inject bounded structured Windows desktop input: move/click/drag, Unicode typing, key/hotkey/hold, scroll, wait, or a bounded batch. No arbitrary script or command input is exposed.',
      inputSchema: {
        type: 'object',
        properties: {
          ...ACT_PROPERTIES,
          steps: {
            type: 'array', minItems: 1, maxItems: MAX_BATCH_STEPS,
            items: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['move', 'click', 'drag', 'type', 'key', 'hotkey', 'hold_key', 'scroll', 'wait'] },
                x: ACT_PROPERTIES.x, y: ACT_PROPERTIES.y, to_x: ACT_PROPERTIES.to_x, to_y: ACT_PROPERTIES.to_y,
                button: ACT_PROPERTIES.button, clicks: ACT_PROPERTIES.clicks, text: ACT_PROPERTIES.text, key: ACT_PROPERTIES.key, keys: ACT_PROPERTIES.keys,
                delta: ACT_PROPERTIES.delta, duration_ms: { type: 'integer', minimum: 0, maximum: 5000 },
              },
              required: ['action'],
              additionalProperties: false,
            },
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: computerAct,
    },
  ];
}
