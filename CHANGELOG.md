# Changelog

All notable changes to this project are documented here.

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
