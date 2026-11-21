# WHB04B-6 native HID sidecar (Windows)

WebHID loses the pendant when the browser window loses focus. The sidecar is a small tray app that owns the
WHB04B-6 USB receiver (VID `0x10CE`, PID `0xEB93`) through the native Windows HID API and relays raw input reports
and LCD frames to the CNCjs widget over a loopback WebSocket (`ws://127.0.0.1:17104/whb04b`). It has no jog or CNC
logic of its own; the widget's **Sidecar** transport does all of that, exactly as with WebHID.

## Run

Start `Whb04bSidecar.exe`. It shows a tray icon (gray: no pendant, amber: pendant but no widget or LCD stuck,
green: relaying) whose menu has the current status, **Start at login**, **Open log folder** and **Quit**. Starting
it a second time just pops a balloon on the running instance.

| Flag | Meaning |
| --- | --- |
| `--port <n>` | Listen on `127.0.0.1:<n>` (default `17104`; `0` = any free port, printed in the log) |
| `--allow-origin <url>` | Also accept this browser origin, e.g. `http://cnc.local:8000` (repeatable). `localhost`, `127.0.0.1` and `[::1]` on any port are always allowed |
| `--simulate` | Use a simulated pendant instead of USB; enables the `/simulate/*` endpoints for practice and tests |
| `--no-tray` | Headless: no tray icon or single-instance check, logs to stdout too; stop with Ctrl+C |
| `--verbose` | Debug-level logs (per-frame LCD latency, HID details) |
| `--version`, `--help` | Print and exit |

Exit codes: `0` ok, `1` fatal, `2` bad arguments, `3` port in use or reserved (e.g. inside a Windows excluded port range).

Because it is a GUI-subsystem exe, `cmd` and PowerShell do not wait for it. For a headless run in a terminal use
PowerShell `.\Whb04bSidecar.exe --no-tray | Out-Host` (the pipe makes PowerShell wait), or
`start /wait Whb04bSidecar.exe --no-tray`. With `--no-tray` the sidecar attaches to the launching terminal's
console even when stdout is redirected. Ctrl+C, Ctrl+Break and closing the console window run the normal shutdown
(closing the window waits up to 4.5 s for it, within the time Windows allows). Windows does not deliver
logoff/shutdown console events to processes that load `user32.dll`, which every WinForms app does, so those are
not handled in headless mode.

### Files

Everything lives in `%LOCALAPPDATA%\WHB04B-Sidecar`:

- `settings.json`, created on first tray launch; command-line flags take precedence:
  ```json
  { "allowedOrigins": ["http://cnc.local:8000"], "port": 17104, "startAtLogin": false }
  ```
  **Start at login** writes `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\WHB04B-Sidecar` and saves `startAtLogin`.
  If the file is not valid JSON, the sidecar runs on defaults, shows a balloon, leaves the file and the Run entry
  alone, and disables the **Start at login** item until the file is fixed.
- `logs\sidecar-yyyyMMdd[.N].log`: rolling daily (5 MB per file, newest 14 kept; a second running sidecar writes to
  the next `.N` file rather than sharing one). Attach/detach with device paths,
  client connect/supersede/disconnect with origin, LCD failures and timeouts, read errors, and a once-a-minute
  activity summary (reports relayed or dropped, LCD frame count/latency/failures). Rejected origins are logged at
  most once per origin per minute.

## Protocol summary

- `GET /health` → `{"protocol":1,"version":"x.y.z","device":"attached"|"detached","clients":n,"mode":"hid"|"simulated","lcd":"ok"|"stuck"}`.
- WebSocket `/whb04b`, JSON text frames. Server → client: `hello`, `device`, `input`, `display:ack`,
  `display:error`, `superseded`. Client → server: `display` with a 21-byte frame.
- `input` is sent for every report-ID-4 report: `data` is exactly the 7 body bytes (padding trimmed, other report
  IDs ignored) and `t` is the Unix-ms time it was read, so the widget can neutralize stale reports. A slow client
  keeps at most 64 queued `input` messages: when full, the oldest queued input is dropped so the newest (current
  dial/axis state) still goes out. `hello`, `device`, `display:*` and `superseded` are never dropped.
- A `display` frame is written as three `[0x06, 7 bytes]` feature reports with a 1000 ms timeout per chunk. On
  timeout the client gets `display:error`, the device is reset and `/health` reports `"lcd":"stuck"` (the tray says
  "LCD write stuck — unplug/replug the receiver"). Until the timed-out OS call returns, no new frame is started, so
  a late chunk never lands in the middle of a newer frame. If it is still pending 5 s after it began, frames resume
  only once the receiver has been reopened on a fresh handle (logged as a warning, since the old call may still
  complete); otherwise they get `display:error` "previous LCD write still stuck".
- The newest connection owns the pendant. The previous one gets `superseded` and close code `4001`. A malformed
  message gets close code `4400`.
- Plain HTTP requests from a browser origin outside the allow-list get `403`. A WebSocket upgrade from a
  disallowed origin that looks like a CNCjs host on the local network (private, link-local or CGNAT IPv4; ULA or
  link-local IPv6; a single-label name; or a name under `.local`, `.lan`, `.home.arpa`, `.internal`) is accepted
  and immediately closed with `4403` and reason `origin not allowed: <origin>`; it never becomes the owner. Any
  other origin gets a plain `403` before the upgrade, so the widget on a LAN host can explain the fix while public
  websites cannot tell the sidecar is running. Requests with no `Origin` header (local tools) are allowed.
- `--simulate` only: `POST /simulate/input {"data":[7 ints]}`, `POST /simulate/detach`, `POST /simulate/attach`,
  `GET /simulate/display` → `{"frames":[[21 ints], ...]}` (last 50).

## Build

Requires the .NET 10 SDK.

```sh
dotnet test sidecar
dotnet publish sidecar/Whb04bSidecar -c Release -r win-x64 --self-contained \
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true \
  -o sidecar/dist
```

The publish profile does the same thing: `dotnet publish sidecar/Whb04bSidecar -p:PublishProfile=win-x64` writes
to `sidecar/Whb04bSidecar/bin/publish/`. Either way the output is a single self-contained `Whb04bSidecar.exe`, and
no .NET install is needed on the target machine. The version comes from the repo's `package.json`. Override it
with `-p:Version=x.y.z`.
