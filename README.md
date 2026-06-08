# WHB04B-6 CNC Pendant for CNCjs (WebHID)

A WebHID driver and CNCjs custom widget for the WHB04B-6 wireless USB pendant.
It runs entirely in the browser — there is no Node process to install and no
native HID module to compile. The pendant talks to the device through
`navigator.hid` and drives the machine through CNCjs's existing socket session.

> Earlier 2.x releases shipped a Node CLI built on `node-hid`. That has been
> replaced by this browser implementation. See [WEBHID.md](WEBHID.md) for the
> migration details and the node-hid → WebHID mapping.

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

## Use it as a CNCjs custom widget (recommended)

The widget runs in a same-origin iframe inside CNCjs, so `navigator.hid` works
without any CNCjs patch and the widget reuses the app's session — it never needs
the `~/.cncrc` secret.

1. Mount the widget folder from the CNCjs server:

   ```bash
   cncjs --mount /whb04b:/path/to/cncjs-pendant-whb04b-6/web/widget
   ```

2. In the CNCjs UI: **Manage Widgets → add a custom widget**, set the URL to
   `/whb04b/index.html`.
3. Open the widget and click **Connect pendant** once to grant WebHID access.

The widget reads the CNCjs token and active serial port from the parent frame,
maps the pendant's keys, dials, and jog wheel to grbl commands, and mirrors the
machine coordinates to the pendant LCD.

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
| Reset | Emergency reset |
| Stop | Stop current operation |
| Start/Pause | Cycle start |
| M-Home | Homing |
| Safe-Z | Move to safe Z height |
| W-Home | Move to G54 work zero |
| S on/off | Spindle off |
| Probe-Z | Z touch probe |
| Continuous / Step | Jog mode |

The left dial selects the axis (X/Y/Z/A/B/C), the right dial selects the step
size and feed rate, and the wheel jogs.

## How it works

- **Device** — `web/whb04b-webhid.js` opens the pendant over WebHID, parses its
  8-byte input reports (keys, dials, signed jog delta), and writes the 21-byte
  LCD frame as three `0x06` feature reports.
- **Credentials** — the widget pulls the CNCjs token from the parent frame: the
  `?token=` query param, the parent's `postMessage` (which also supplies the
  active port), or a same-origin read of `localStorage['cnc']`.
- **Commands** — it loads same-origin `socket.io` and emits
  `command/<port>` against the already-open serial port; it does not open or
  close the port itself.

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
