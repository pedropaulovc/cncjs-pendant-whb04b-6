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

   # local checkout: first run npm ci && npm run build in that checkout
   cncjs --mount /whb04b:/path/to/cncjs-pendant-whb04b-6/web
   ```

2. In the CNCjs UI: **Manage Widgets → add a custom widget**, set the URL to
   `/whb04b/widget/index.html`. Mount the whole `web` folder because the widget
   imports the driver from its parent directory.
3. Open the widget and click **Connect pendant** once to grant WebHID access.

The widget reads the CNCjs token and active serial port from the parent frame,
maps the pendant's keys, dials, and jog wheel to grbl commands, and mirrors the
machine coordinates to the pendant LCD.

The LCD shows work coordinates (`X1/Y1/Z1`) by default; Macro-10 switches to
machine coordinates (`X/Y/Z`). Numeric values follow the controller's active
G20 (inches) or G21 (millimetres) mode, converting GRBL's `$13` report units as
needed. Changing G20/G21 updates the displayed numbers without moving an axis.
Feed and spindle fields show **override percentages**, matching CNCjs's override
controls even when the machine is stationary. They do not show actual feed or RPM.
The mode indicator follows MPG, Step, and Continuous. LCD write failures appear
in the widget log. Losing the CNCjs connection or selecting unsupported A/B/C
axes shows RESET with cleared values. Missing coordinates or override feedback
or unit information is logged once; no substitute live values are invented. A stalled HID transfer
disconnects the pendant after one second; reconnect it from the widget.

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

## Pendant controls

The mappings follow [LinuxCNC's xhc-whb04b-6 driver](https://www.linuxcnc.org/docs/master/html/en/man/man1/xhc-whb04b-6.1.html)
with its feed and spindle wheel overrides enabled (`-f -s`). The widget starts
in **MPG** mode. Press **Step** to jog by distance or **Continuous** to jog while
turning the wheel. The current mode appears above the input readout.

| Control | Action |
|---------|--------|
| Reset | GRBL soft reset |
| Stop | Cancel jogs/queued commands; hold a program and reset after motion stops |
| Start/Pause | Start the loaded CNCjs program, pause it, or resume it |
| Feed + / - | Feed override +1 / -1 percentage point |
| Spindle + / - | Spindle override +1 / -1 percentage point |
| M-Home | GRBL homing |
| Safe-Z | Machine Z = -5 mm |
| W-Home | Safe-Z, then G54 X0 Y0 |
| S on/off | Stop a running spindle or start it at its programmed S speed |
| Probe-Z | Z touch probe using the plate thickness field |
| Continuous / Step | Select the jogging mode |
| Macro-10 | Toggle the pendant LCD between work and machine coordinates |
| Fn + Spindle + / - | Increase/decrease programmed S speed (100 RPM by default) |
| Fn + S on/off | Select the next spindle start direction; spindle must be stopped |
| Fn + Continuous / Step | Toggle flood / mist coolant |

Hold **Fn first**, then the other key. Each press executes once; holding a key
while wheel reports arrive does not repeat it. Fn combinations work with either
key-byte order reported by the receiver.

The remaining Fn combinations run operator-configured G-code macros:

| Fn + button | Macro slot |
|-------------|------------|
| Feed + / Feed - | 1 / 2 |
| M-Home / Safe-Z / W-Home | 5 / 6 / 7 |
| Probe-Z | 9 |
| Reset / Stop / Start-Pause | 11 / 12 / 13 |
| Macro-10 | 14 |

Configure these under **Pendant settings → Macro buttons**. Each labelled Fn
combination can be disabled, assigned multiline custom G-code, or linked to a saved
CNCjs macro. Click **Save settings** to apply the assignments in this browser.
An unconfigured macro
only logs its slot number. Bare Reset and Stop retain their normal behavior.

Saved macros come from the same CNCjs Macro widget and remain linked by ID. The
list refreshes when CNCjs settings change; **Refresh CNCjs macros** reloads it
manually without discarding unsaved edits. Deleted macros remain visibly
unavailable until you replace or disable their assignments.

Each press fetches the current definition and sends that checked snapshot through
CNCjs's G-code feeder. Controller variables such as `posx` and `modal.units`, and
`%` assignments, use CNCjs's evaluator. Pending requests are discarded if you press
another button, change selectors, save settings, leave the page, or the controller
changes state. Failed requests never run a cached definition or retry motion.

The pendant does not invoke CNCjs's optional **Run Macro** event hooks. CNCjs also
does not expose its Visualizer bounds to custom widgets, so macros referencing or
assigning `xmin`, `xmax`, `ymin`, `ymax`, `zmin`, or `zmax` in expressions are refused
with an explanation. Run those macros from CNCjs's Macro widget.

The npm package includes the expression parser. For development from a Git
checkout, run `npm ci` and `npm run build` before serving the widget. `npm test`
and `npm pack` build the pinned parser automatically and include its license.

### Wheel and selector

- **MPG:** each wheel detent changes feed override by one percentage point.
- **Lead:** each detent changes spindle override by one percentage point. Both
  known Lead codes (`0x1c` and `0x9b`) are recognized. Lead never moves an axis.
  Leaving Lead returns to MPG.
- **Step:** each detent moves 0.001, 0.01, 0.1, 1, 5, or 10 mm according to the
  selector. The last two positions require **5/10 mm steps → Enabled**, matching
  LinuxCNC's opt-in big-step option. A step finishes after the wheel stops.
- **Continuous:** the selector chooses 2, 5, 10, 30, 60, or 100% of the selected
  axis's GRBL maximum rate (`$110`–`$112`). Motion is issued as one outstanding
  segment with 200 ms of travel at that feed; a 180 ms gap between wheel reports cancels
  the jog. Direction, axis, and mode changes also cancel it. New motion waits
  for an Idle report at the commanded endpoint after each segment, or two
  fresh Idle reports after cancellation. Both Step and Continuous request status
  every 100 ms until completion or cancellation is confirmed. Updated CNCjs
  position broadcasts also confirm completed endpoints. Acceleration and status latency
  can produce pauses between segments; this bounds queued travel if the
  connection drops. Very low rates whose segments fall below position/step
  resolution are refused with a log message. Browser/serial latency and GRBL
  deceleration add to stopping time.

In MPG or Continuous, moving the selector also sets the feed override to its
percentage. GRBL's 10–200% override range clamps the 2% and 5% selections to 10%
for **program feed override**; Continuous jogging still uses the selected 2% or
5% of axis maximum velocity. The initial selector report does not change feed
when the widget connects. GRBL feed overrides do not affect `$J` jogging.

Overrides wait for confirming GRBL `Ov` reports before sending the next realtime
byte, because GRBL can combine duplicate bytes received together. Pending changes
are discarded on reset, Stop, disconnect, or after three seconds without a
confirming report. Their result follows controller feedback, not a local counter.

### Settings and GRBL limits

**Pendant settings** provides step feed (250 mm/min by default), spindle speed
increment, and the large-step option. Changes are stored in browser localStorage
under `whb04b-controls`, separately for each browser/profile and CNCjs origin.
Step feed is capped by the selected axis's GRBL maximum rate. Jogging waits for
controller settings instead of guessing a machine speed.
If GRBL reports an error while the pendant owns a jog, the widget logs the error,
cancels queued jogging, and waits for two Idle reports before accepting another jog.

FluidNC keeps these limits in `config.yaml`, and its `$$` omits `$13` and
`$100`–`$112`. When a joined, idle controller lacks `$13` or `$110`–`$112`, the
widget sends `$I` once. If the reply identifies FluidNC, it reads
`$/report_inches`, `$/axes/{x,y,z}/steps_per_mm`, and
`$/axes/{x,y,z}/max_rate_mm_per_min`, and uses them as the matching GRBL
settings. These read-only queries appear in the CNCjs console. FluidNC spindle
speed maps are not translated to `$30`/`$31`, so Fn spindle-speed changes stay unavailable there.

Tiny Steps and out-and-back Steps can end at the same reported position. Their
completion requires the jog acknowledgement followed by two fresh Idle reports.
When joining an already-open controller, CNCjs does not identify replies to
commands sent before the widget joined. The widget then logs that completion
cannot be confirmed and keeps jog cancellation armed. Changing mode/axis or
pressing Stop cancels those jogs; a controller reset restores acknowledgement
tracking. Program activity also invalidates this tracking. Ordinary Steps with
a fresh, visibly changed endpoint still complete normally.
After two Idle reports, uncertain jogs stop polling and remain passively armed.
Mode/axis cancellation clears the feeder only while owned jog lines remain
unsent, preserving later CNCjs macros once all owned lines were written. Stop
continues to cancel all queued work explicitly.

Only XYZ axes are supported by stock GRBL; A/B/C and Off do not jog. Macros,
homing, spindle G-code, and coolant G-code require an idle controller with no
running program. Feed/spindle realtime overrides remain usable during a program.
Programmed spindle speed changes are bounded by `$30`/`$31`; set a positive S
speed before turning the spindle on. Reversing direction requires stopping the
spindle first. Mist needs firmware compiled with M7 support. Unsupported commands
are reported by CNCjs.

LinuxCNC's HAL machine power, hardware E-stop, joint/teleop modes, and arbitrary
HAL pin wiring have no stock GRBL equivalents. Reset remains a software reset.
Macro-10 changes the pendant LCD only; it does not change the CNCjs or EL400 view.
USB removal, hiding the browser tab, and leaving the page cancel pendant jogging;
wheel/button input is ignored while the browser tab is hidden.
network loss can only be bounded by the already-issued finite jog segment.

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
