# Changelog

All notable changes to this project are documented here.

## [3.2.9] - 2026-11-02

### Changed

- Safe-Z and W-Home fetch CNCjs Tool's shared `tool.toolChangeZ` on every press instead of using machine Z −5 mm. W-Home still moves Z before G54 X0 Y0 and never adds a final Z move.
- Probe-Z fetches CNCjs Tool's shared metric `tool.touchPlateHeight` on every press. Removed the pendant plate-thickness input and stored setting.
- Shared Tool settings follow CNCjs's unset default 0 (including the native empty API response). Invalid values, authentication/transport errors, or malformed responses send no motion. Stop, another key, disconnect, or controller/workflow changes cancel pending reads through the existing saved-macro lifecycle. All three actions explicitly select G21; machine Z and plate height are millimetres regardless of previous G20/G21.

## [3.2.8] - 2026-11-02

### Added

- An **i** button beside the Mode readout explains Step, Continuous, MPG, how to enter each, and the Lead dial position (spindle override, never motion). Hover or keyboard focus previews it, a click keeps it open, and a second click or Escape closes it. It opens in the page flow, so a 320 px widget column does not clip it.
- **Default button reference**, collapsed inside **Macro buttons**, lists every built-in button and Fn action with the G-code or GRBL command it sends, including the built-in Fn+Spindle and Fn+S on/off functions and the unassigned default for Fn+Macro-10.

### Changed

- Macro assignments use the macro number printed on each pendant key: `Macro-1 (Fn+Feed+)`, `Macro-2 (Fn+Feed-)`, `Macro-5 (Fn+M-Home)`, `Macro-6 (Fn+Safe-Z)`, `Macro-7 (Fn+W-Home)`, `Macro-9 (Fn+Probe-Z)`, and `Macro-10 (Fn+Macro-10)`. Fn+Reset, Fn+Stop, and Fn+Start/Pause, which print no number, keep plain labels. Stored slot numbers are unchanged, so existing assignments keep working; logs use the same labels.
- Settings save automatically on every change, and the Save settings button is gone. Probe plate thickness (millimetres, 20 by default) is now saved and restored with the other settings instead of resetting on reload. Invalid entries, such as empty or invalid custom G-code, an empty or negative probe plate thickness, or an empty spindle increment, are reported with `Not saved:` and never replace the last valid configuration. While the probe plate field is invalid, Probe-Z still refuses to probe. Each valid change also applies to the open widget even when another widget already stored the same settings.
- A newly added macro row starts **Disabled** instead of Custom G-code. Disabled rows are saved as `{ "source": "disabled" }` and stay listed after a reload; pressing one logs that it is disabled, while an unassigned combination logs that it is not configured.
- The socket, token, and port pills appear only while something is wrong; the pendant pill stays visible. **Re-read creds & connect** moved into Diagnostics.
- The large-step setting explains that it affects Step only, at full axis velocity, and under G20 its label reads `5/10 in steps (127/254 mm)`. It remains opt-in; selector 1 stays allowed, which is 25.4 mm per detent under G20.

## [3.2.7] - 2026-11-02

### Changed

- Step jogging follows the controller's active G20/G21 units instead of always sending millimetres: inches under G20 and millimetres under G21. The same selector travels 25.4 times farther under G20, so 0.1 is 2.54 mm under G20 and 0.1 mm under G21. Selector 1 needs no opt-in in either unit, so under G20 it moves 1 in (25.4 mm). Selectors 5 and 10 still need **5/10 steps → Enabled** in either unit, because the opt-in tests the numeric selector. Readouts and the opt-in label show the active unit.
- Continuous keeps its physical speed and 200 ms segment in either unit. Only its `$J` line changes: it is written in inches and in/min under G20. Previously every `$J` line was G21, even while the controller was in G20.
- Step and Continuous wait for a known G20/G21 state. While it is unknown, readouts show `waiting for G20/G21`, Step ignores new wheel input, and Continuous refuses to jog. Only an unknown state retains merged Step detents, in millimetres, until a mode is known. A known G20/G21 switch does not reinterpret them. If the active mode cannot write their distance or feed, they are discarded with a log message rather than retried. Stop, mode changes, and axis changes still discard them.
- The low-level jog helper still takes millimetres and mm/min. `$13` report units still affect only LCD and position conversion, never jog units.
- Safe-Z, W-Home, Probe-Z, and the probe plate thickness remain millimetres by design. Those macros select G21 and leave the controller in G21, so later Step and Continuous jogs use millimetres until G20 is commanded again.

## [3.2.6] - 2026-11-02

### Changed

- Restyled the pendant widget to match CNCjs's compact, light Bootstrap-like controls: a connection bar and single operating readout replace the page heading and large cards.
- Moved probe thickness into collapsed Pendant settings, and raw keys and the bounded log into collapsed Diagnostics. The latest diagnostic message remains visible in a live status line even when Diagnostics is closed. Existing controls, defaults, and motion behavior are unchanged.
- Promoted Macro buttons to its own collapsed panel alongside Pendant settings and Diagnostics. The editor lists configured assignments only, adds unused Fn combinations one at a time, and offers per-row removal without changing the supported combinations.
- Shared Save settings across both configuration panels, preserving unsaved edits and status when panels close. Saving omits removed, disabled, and empty custom mappings while retaining saved CNCjs macro links and catalog refresh behavior.

## [3.2.5] - 2026-11-02

### Fixed

- Step jogging now requests the selected XYZ axis's full GRBL maximum rate (`$110`/`$111`/`$112`), following LinuxCNC's distance-only Step selector behavior. Program feed override does not reduce Step speed; acceleration and travel length still limit actual velocity. Missing or invalid axis limits refuse motion. Step distances, large-step opt-in, Continuous, overrides, and `$J` cancellation are unchanged.
- Removed the separate Step feed setting and its UI. Loading and saving pendant configuration drops obsolete fields without resetting spindle increment, large-step preference, or macro assignments.

## [3.2.4] - 2026-11-02

### Fixed

- Step and Continuous jog completion now follows fresh native CNCjs motion updates rather than polling every 100 ms. A changed endpoint completes immediately without an extra `statusreport`, and normal motion adds no status requests. Ambiguous Idle evidence waits 750 ms before a burst of at most five requests spaced 250 ms apart: two post-acknowledgement Idle reports confirm tiny or out-and-back moves, while clipped or zero-clipped moves require five. An unknown outcome after two Idle reports remains armed. Fresh motion resets the burst; cached or parser-only state is not fresh evidence.
- A trusted pending acknowledgement has no deadline or status queries: it can wait behind a long dwell while merged detents and the 50 ms backlog timer are preserved. After acknowledgement, three seconds of native moving-state feedback silence leaves cancellation armed rather than declaring completion. Cancellation requires two distinct raw Idle reports; its delayed, bounded burst failing leaves it blocked without further automatic queries unless fresh progress arrives. Stop and override behavior is unchanged.
- Changing raw Jog/Run positions also keep motion observation alive when another client requests status before CNCjs publishes its matching native update. The native echo still contributes no extra freshness, and Idle echoes cannot renew the bounded confirmation budget.

## [3.2.3] - 2026-11-02

### Fixed

- Start the widget in Step mode instead of MPG mode, so turning the wheel jogs by distance without first pressing Step.

## [3.2.2] - 2026-11-01

### Fixed

- Turning the wheel quickly in Step mode no longer floods the controller with one `$J` line per detent. CNCjs writes a single queued line to serial without waiting for the controller's `ok`, so a full planner made those lines pile up past the controller's buffers. The pendant now keeps one Step line awaiting the controller's reply and merges later detents into one line sent when that reply arrives. Total travel is unchanged; Stop and mode or axis changes discard merged detents that were not yet sent.

## [3.2.1] - 2026-11-01

### Fixed

- A jog the controller clips at a soft limit no longer leaves the pendant polling status every 100 ms until Stop. FluidNC acknowledges a clipped jog with `ok` and stays Idle short of the target; after five settled Idle reports the pendant ends the jog and logs that it stopped short. Without trusted acknowledgements it pauses polling and keeps cancellation armed instead.

## [3.2.0] - 2026-10-30

### Added

- FluidNC support: read report units, steps per mm, and axis maximum rates from FluidNC config when `$$` omits `$13` and `$110`–`$112`. This enables jogging and the LCD on FluidNC.

## [3.1.0] - 2026-10-30

### Added

- Labelled Fn-button assignments, multiline custom G-code, and saved CNCjs macro selection with previews.
- Linked macro definitions refreshed from CNCjs, with missing-macro and request-error feedback.
- Cancellation checks for macro loading and validation of expressions that require unavailable Visualizer bounds.

### Changed

- Custom G-code using Visualizer bounds is now refused on button press, including existing assignments. Settings retain the code for editing and show an inline explanation.

## [3.0.1] - 2026-10-30

### Fixed

- Corrected the physical LCD protocol, including signed coordinates, mode indicators, and full-width feed/spindle fields.
- Show CNCjs feed/spindle override percentages and refresh the LCD when attaching the pendant.
- Convert reported coordinates to the active G20/G21 units, including when `$13` settings arrive after machine state.
- Show RESET after losing the CNCjs connection or selecting unsupported A/B/C axes.
- Report missing controller feedback and HID write failures; discard superseded LCD snapshots and stop stalled transfers.
- Report invalid display values in the standalone tester.

## [3.0.0] - 2026-10-30

### Added

- Published the dependency-free WebHID driver and CNCjs widget as an npm package.
- Added ES module exports, TypeScript declarations, and package validation tests.
