# WHB04B-6 CNC Pendant for CNCjs (WebHID)

A WebHID driver and CNCjs custom widget for the WHB04B-6 wireless USB pendant.
It runs entirely in the browser — there is no Node process to install and no
native HID module to compile. The pendant talks to the device through
`navigator.hid` and drives the machine through CNCjs's existing socket session.

## Requirements

- A Chromium-based browser (Chrome, Edge, or Opera) — WebHID is not available in
  Firefox or Safari.
- A secure context: `https://` or `localhost`.
- The WHB04B-6 pendant and its USB receiver (VID `0x10CE`, PID `0xEB93`).
- On Linux, a udev/hidraw rule so the browser can open the device.

Only grbl is wired up today. Other controllers are welcome as contributions.

## Layout

```
web/
  index.html          standalone tester page
  whb04b-webhid.js    dependency-free WebHID driver (ES module)
  widget/
    index.html        CNCjs custom-widget page
    whb04b-widget.js  widget integration (creds from parent, grbl mapping)
```

## Install from npm

```bash
npm install cncjs-pendant-whb04b-6
```

Import the dependency-free WebHID driver in a browser project:

```js
import {
  WHB04BWebHID,
  buildDisplayFrame,
  JogMode,
} from 'cncjs-pendant-whb04b-6';

const pendant = new WHB04BWebHID();
const frame = buildDisplayFrame({ jogMode: JogMode.Step, x: 12.345 });
```

## Use it as a CNCjs custom widget (recommended)

The widget runs in a same-origin iframe inside CNCjs, so `navigator.hid` works
without any CNCjs patch and the widget reuses the app's session — it never needs
the `~/.cncrc` secret.

1. Mount the widget folder from the CNCjs server:

   ```bash
   # installed package
   cncjs --mount /whb04b:/path/to/node_modules/cncjs-pendant-whb04b-6/web

   # local checkout
   cncjs --mount /whb04b:/path/to/cncjs-pendant-whb04b-6/web
   ```

2. In the CNCjs UI: **Manage Widgets → add a custom widget**, set the URL to
   `/whb04b/widget/index.html`. Mount the whole `web` folder because the widget
   imports the driver from its parent directory.
3. Open the widget and click **Connect pendant** once to grant WebHID access.

The widget reads the CNCjs token and active serial port from the parent frame,
maps the pendant's keys, dials, and jog wheel to grbl commands, and mirrors the
machine coordinates to the pendant LCD.

Open the machine port in CNCjs first. The widget joins the selected open port,
or the sole open port if CNCjs has not supplied a selection. With several open
ports it waits for an explicit selection. It reconnects after a network drop
and discards pendant commands while disconnected instead of queuing them.

Jog distances and feed rates are always millimetres. Safe-Z moves to machine
Z = -5 mm; W-Home uses that move before travelling to G54 X0 Y0. Verify that
height against your machine and workholding before using either key. Probe-Z
travels up to 50 mm downward at 120 mm/min and uses the widget's plate thickness
field (20 mm by default). These macros select G21 and leave the controller in mm.

## Use the standalone tester

Useful for checking the device and protocol without CNCjs:

```bash
npm run serve   # serves web/ at http://localhost:8000
```

Open `http://localhost:8000/index.html`, click **Connect pendant**, then watch
the live key/dial/jog readout and push coordinates to the LCD.

## Button layout

| Button | Function |
|--------|----------|
| Reset | Controller soft reset |
| Stop | Cancel jogs and queued commands; hold a running program, then reset after motion stops |
| Start/Pause | Cycle start |
| M-Home | Homing |
| Safe-Z | Move to safe Z height |
| W-Home | Move to G54 work zero |
| S on/off | Spindle off |
| Probe-Z | Z touch probe |
| Continuous / Step | Jog mode |

The left dial selects the axis (X/Y/Z/A/B/C), the right dial selects the step
size and feed rate, and the wheel jogs.

Stop waits for GRBL 1.1 to report a completed hold (`Hold:0`) before resetting
programmed motion. It leaves an idle controller idle when no program is running
or paused; a program's dwell is canceled with hold and reset too. Pendant motion commands
stay blocked until the controller confirms the stop; inspect CNCjs if status
updates stop arriving. Reset remains available.
If a connection is interrupted during Stop, motion stays blocked after reconnect;
inspect CNCjs and press Stop or Reset to recover. Follow the controller's
unlock/homing procedure after a reset. With no active program, Stop at Idle or
during jogging does not switch off the spindle. These software controls depend on the
browser and serial connection and do not replace a wired emergency stop.
Stop aborts homing with a reset, which may require unlocking and homing again.
For a safety-door, sleep, or check state, inspect CNCjs; Reset remains available.

## How it works

- **Device** — `web/whb04b-webhid.js` opens the pendant over WebHID, parses its
  8-byte input reports (keys, dials, signed jog delta), and writes the 21-byte
  LCD frame as three `0x06` feature reports.
- **Credentials** — the widget pulls the CNCjs token from the parent frame: the
  `?token=` query param, the parent's `postMessage` (which also supplies the
  active port), or a same-origin read of `localStorage['cnc']`.
- **Commands** — it loads same-origin `socket.io` and emits
  `command` with the active port against the already-open serial port. CNCjs's
  `open` socket RPC joins that controller and supplies its initial state. The
  widget only requests ports reported as in use; it never sends a close command.

## Notes

- **Same origin.** Mounted on the CNCjs server the widget is same origin, so
  WebHID works without any CNCjs change (the `hid` permission policy defaults to
  `self`). Serving it from a different origin would need `allow="hid"` on the
  widget iframe in CNCjs's `Custom.jsx` — a one-line upstream patch.
- **No headless mode.** WebHID needs an open browser tab, so there is no
  headless/PM2 deployment. As a widget the pendant simply lives in the CNCjs
  tab the operator already has open.

## Reference implementation

The WHB04B-6 USB HID protocol used here — input report layout, key and dial
codes, and the 21-byte LCD frame — is documented in the companion C# reference
implementation: <https://github.com/pedropaulovc/whb04b-6>.

## Acknowledgments

This project descends from
[cncjs-pendant-gamepad](https://github.com/balthisar/cncjs-pendant-gamepad) by
Jim Derry, itself based on
[cncjs-pendant-ps3](https://github.com/cncjs/cncjs-pendant-ps3) by Austin St.
Aubin and [Chris Midgley's fork](https://github.com/cmidgley/cncjs-pendant-ps3).
The WHB04B-6 USB protocol was reverse-engineered with help from the LinuxCNC
`xhc-whb04b-6` component and a
[C# reference implementation](https://github.com/pedropaulovc/whb04b-6/).

Not associated with or endorsed by Chengdu Xinhecheng Technology Co., Ltd.

## License

MIT — see [LICENSE](LICENSE).
