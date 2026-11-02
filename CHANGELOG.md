# Changelog

All notable changes to this project are documented here.

## [3.2.6] - 2026-11-02

### Changed

- Restyled the pendant widget to match CNCjs's compact, light Bootstrap-like controls: a connection bar and single operating readout replace the page heading and large cards.
- Moved probe thickness into collapsed Pendant settings, and raw keys and the bounded log into collapsed Diagnostics. The latest diagnostic message remains visible in a live status line even when Diagnostics is closed. Existing controls, defaults, and motion behavior are unchanged.

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
