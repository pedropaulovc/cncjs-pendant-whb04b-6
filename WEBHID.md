# WebHID feasibility evaluation

**Question:** can `cncjs-pendant-whb04b-6` be reimplemented using WebHID?

**Answer: yes.** The HID layer maps cleanly onto the WebHID API, and the rest
of the pendant (CNCjs socket connection, action mapping, G-code generation) is
ordinary logic that already runs in a browser. The only hard requirement is a
runtime shift: WebHID exists only in Chromium browsers (Chrome / Edge / Opera)
over a secure context, so the pendant moves from a standalone Node CLI to a web
page rather than running headless under `node`.

## What the current code does with `node-hid`

`src/whb04b_controller.ts` is the only file that touches hardware. It:

1. enumerates devices by VID `0x10CE` / PID `0xEB93`;
2. on Windows opens two HID paths (`col01` for input, `col02` for output);
3. polls `readTimeout(8)` every 100 ms for 8-byte input reports whose first
   byte is the report id `0x04`;
4. sends the LCD frame as three `sendFeatureReport` transfers, each `0x06`
   followed by 7 data bytes.

Everything else — `connector.ts` (socket.io to CNCjs), `whb04b_actions.ts`
(input → jog/probe/home), `gcode-*.ts` — never touches the device.

## Operation-by-operation mapping

| node-hid | WebHID |
| --- | --- |
| `HID.devices().filter(vid/pid)` | `navigator.hid.getDevices()` (already-authorised) |
| open a device by path | `navigator.hid.requestDevice({filters:[{vendorId,productId}]})` then `device.open()` — **needs a user gesture** |
| `col01` input + `col02` output as two handles | one `HIDDevice` aggregates every top-level collection; input arrives via the event, output routes by report id — the split disappears |
| `setInterval` + `readTimeout(8)` polling | `device.addEventListener('inputreport', …)` (event driven) |
| input byte `data[0] === 0x04` is the report id | WebHID puts it in `event.reportId`; `event.data` is a `DataView` with the id **stripped**, so offsets shift by one |
| `sendFeatureReport([0x06, ...7])` | `device.sendFeatureReport(0x06, Uint8Array(7))` — report id is the first arg, excluded from the buffer |
| `write([0x06, ...])` fallback | `device.sendReport(0x06, Uint8Array(7))` |
| `device.close()` | `device.close()` |
| reconnect on unplug | `navigator.hid` `connect` / `disconnect` events |

The protocol parsing and the 21-byte LCD frame layout are unchanged. In the
WebHID port the report id is re-prepended to the input bytes before parsing, so
the exact `data[2..6]` offsets from the original implementation still apply and
the bytes put on the wire for the display are byte-for-byte identical.

## What this branch adds

- `src/whb04b_controller_webhid.ts` — a drop-in WebHID controller that keeps the
  same public surface as `whb04b_controller.ts` (`on('attach'|'use'|'remove')`,
  `sendDisplayData`, `clearDisplay`, `isConnected`, `numDevices`, `destroy`), so
  `whb04b_actions.ts` can drive it unchanged in a browser build. Node-only deps
  (`node-hid`, `npmlog`, `Buffer`) are replaced with WebHID, `console`, and
  `Uint8Array`/`DataView`.
- `web/whb04b-webhid.js` + `web/index.html` — a zero-build, dependency-free
  tester that connects to a real pendant, shows live key/dial/jog input, and
  pushes coordinates to the LCD. Open it from any `https`/`localhost` origin.

## Caveats

- **Browser only.** WebHID is Chromium-only and unavailable in Firefox/Safari
  and in Node. A headless deployment would need a different path (keep node-hid,
  or run the page in headless Chrome).
- **User gesture + permission.** `requestDevice()` must run from a click; the
  grant persists and `getDevices()` re-attaches silently afterwards.
- **Secure context** required (`https://` or `localhost`).
- **OS access.** Linux needs a udev/hidraw rule; WebHID blocks protected
  top-level usages (keyboard/pointer), but the WHB04B-6 enumerates as a
  vendor-defined device so it is reachable.
- **Full browser port.** `connector.ts`/`actions`/`gcode` are browser-portable
  but still import `npmlog`/`fs`/`os` and the Node build of `socket.io-client`;
  finishing a 100% in-browser pendant means swapping those for `console`, a
  browser JWT, the socket.io browser bundle, and dropping the file-based config
  loader. None of that is blocked by WebHID — it is ordinary bundling work.
