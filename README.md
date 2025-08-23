WHB04B-6 CNC Pendant Support for CNC.js
========================================

 [1]: https://cnc.js.org
 [2]: https://github.com/cncjs/cncjs-pendant-ps3
 [3]: https://github.com/cmidgley/cncjs-pendant-ps3
 [4]: https://github.com/balthisar/cncjs-pendant-gamepad

Provides support for the WHB04B-6 CNC pendant controller as a wireless USB pendant for [CNC.js][1], allowing for operations like jogging, homing, probing, and managing jobs.


Controller Support
------------------

**Currently, only grbl is officially supported. _Please help_.** It's highly likely that Marlin works (it looks okay, but I only use Marlin with a printer, so I can't test it), but I have no idea how to implement/test Smoothieware and TinyG controllers. Please feel free to fork and tweak and submit a PR, or send me a controller. Confirmation that Marlin is good to go would be appreciated, too.


Project Information
-------------------

This project is primarily adapted from **[Jim Derry's cncjs-pendant-gamepad][4]**, which provided the foundational architecture and CNCjs integration patterns that made this WHB04B-6 implementation possible. Jim Derry's gamepad pendant project itself was based on the original [cncjs-pendant-ps3 by Austin St. Aubin][2] and [Chris Midgley's fork][3]. 

While the WHB04B-6 implementation required complete rewriting of the HID communication layer and pendant-specific logic, the core CNCjs integration, G-code handling, and controller abstraction patterns were directly inherited from Jim Derry's excellent work. This project would not have been possible without that solid foundation.

The codebase has been extensively modified to support the WHB04B-6's unique USB HID protocol, LCD display communication, and specific button/dial layout, but maintains the same modular architecture and CNCjs integration approach pioneered in the gamepad pendant.

## Features

- **Direct WHB04B-6 Support**: Native USB HID communication with WHB04B-6 pendant (no vendor DLL required)
- **Real-time Input Processing**: Continuously polls pendant for button presses, dial positions, and jog wheel movements  
- **Display Output**: Sends coordinate data and control information to the pendant's LCD display
- **CNC Controller Support**: Supports both Grbl and Marlin controllers
- **Debugging Features**: Simulate mode and verbose logging for troubleshooting
- **Auto-reconnect**: Automatically reconnects to pendant if connection fails
- **Cross-platform**: Works on Windows, Linux, and macOS

## WHB04B-6 Pendant Features

- **16 Programmable Buttons**: Reset, Stop, Start/Pause, Feed+/-, Spindle+/-, Homing, Probing, etc.
- **Dual Dial Controls**: Left dial for axis selection (X/Y/Z/A/B/C), Right dial for feed rate/step size
- **Jog Wheel**: Precision jog wheel with encoder for smooth movement control
- **LCD Display**: Shows coordinates, jog mode, feed rate, and spindle speed
- **Multiple Jog Modes**: Continuous and Step modes for different machining needs

## Hardware Requirements

- WHB04B-6 wireless CNC pendant controller
- USB receiver/controller for the pendant (typically included)
- Compatible with Windows, Linux, and macOS

## Button Layout

The WHB04B-6 pendant provides 16 programmable buttons with the following default mapping:

| Button | Function | Description |
|--------|----------|-------------|
| Reset | Key1 | Emergency reset/stop |
| Stop | Key2 | Stop current operation |
| Start/Pause | Key3 | Start or pause job |
| Feed+ | Key4 | Increase feed rate |
| Feed- | Key5 | Decrease feed rate |
| Spindle+ | Key6 | Increase spindle speed |
| Spindle- | Key7 | Decrease spindle speed |
| M-Home | Key8 | Machine home all axes |
| Safe-Z | Key9 | Move to safe Z position |
| W-Home | Key10 | Workpiece coordinate home |
| S on/off | Key11 | Spindle on/off toggle |
| Fn | Key12 | Function key (reserved) |
| Probe-Z | Key13 | Z-axis touch probe |
| Macro-10 | Key14 | User macro (reserved) |
| Continuous | Key15 | Continuous jog mode |
| Step | Key16 | Step jog mode |

## Pendant Setup

The WHB04B-6 pendant should be automatically detected when connected via USB. The pendant uses HID (Human Interface Device) protocol and doesn't require special drivers on most operating systems.


## Installation

This pendant requires Node.js 16 or later. Ensure you have a working Node.js installation that's compatible with CNCjs.

    git clone https://github.com/your-repo/cncjs-pendant-whb04b-6.git && cd cncjs-pendant-whb04b-6
    npm install

## Quick Start

After installation, you can use these convenient npm scripts:

### Testing Mode (Recommended First Use)
```bash
npm run simulate
```
This runs the pendant in simulation mode with verbose logging, allowing you to safely test all functions without moving your CNC machine. **Highly recommended before first use with a real machine.**

### Normal Operation
```bash
npm run start
```
This starts the pendant for normal operation. You may need to configure connection settings via command line arguments or configuration file (see Configuration section below).

### Custom Configuration
For specific setups, you can still use the binary directly:
```bash
bin/cncjs-pendant-whb04b-6.js -p /dev/ttyUSB0 -b 115200 -t grbl run
```

## Running cncjs-pendant-whb04b-6

To see all available options:

    cncjs-pendant-whb04b-6.js --help

### Key Options

- `--port (-p)`: Serial port path to the CNC controller (e.g., `/dev/ttyUSB0`)
- `--baudrate (-b)`: Baud rate for the serial connection (e.g., `115200`)
- `--controller-type (-t)`: Controller type (`grbl` or `marlin`)
- `--verbose (-v)`: Enable verbose logging (use `-vv` or `-vvv` for more detail)

### Basic Usage Examples

Start the pendant server for production use:

    cncjs-pendant-whb04b-6.js -p /dev/ttyUSB0 -b 115200 -t grbl run

For testing without a real CNC machine:

    cncjs-pendant-whb04b-6.js simulate -vv

**Quick commands:**
- `npm run simulate` - Safe testing mode with verbose output
- `npm run start` - Normal operation mode


## Configuration Files

You can use a JSON configuration file instead of or in addition to command line parameters. CLI parameters will override settings in the configuration file.

Configuration files are searched in the following order:
- `~/.cncjs-pendant-whb04b-6.rc.json` (user home directory)
- `/etc/cncjs-pendant-whb04b-6.rc.json` (system-wide, Unix only)

Available JSON configuration keys:
- `accessTokenLifetime`: Access token lifetime for CNCjs connection
- `baudrate`: Serial port baud rate
- `controllerType`: CNC controller type (`grbl` or `marlin`)
- `port`: Serial port path
- `socketAddress`: CNCjs server address (default: `localhost`)
- `socketPort`: CNCjs server port (default: `8000`)
- `secret`: CNCjs access secret
- `verbose`: Logging verbosity level
- `zProbeThickness`: Touch plate thickness for Z-probing (in mm)


## First Use Recommendation

We highly recommend running the pendant in simulate mode first using:

    npm run simulate

This allows you to see the commands being sent (G-code and operations) without moving the actual machine. It's very useful to verify everything is working and helps you learn the pendant controls safely.

## Configuring for Auto-start

If you have CNCjs configured to autostart, you can use PM2 to autostart the pendant as well:

    pm2 start --name whb04b-pendant $(which node) -- $(which cncjs-pendant-whb04b-6) -p /dev/ttyUSB0 -b 115200 -t grbl -vv
    pm2 save

## Development

### Building

This pendant is written in TypeScript. The source code in `src/` can be compiled to JavaScript by:

    npm run build-ts

### Code Overview

The codebase is modular and well-commented:

- `bin/cncjs-pendant-whb04b-6.js` - Main entry point
- `src/console.ts` - Command line interface and program initialization  
- `src/whb04b_controller.ts` - WHB04B-6 pendant HID communication and input processing
- `src/whb04b_actions.ts` - Event handling and CNC operation mapping
- `src/connector.ts` - CNCjs WebSocket connection management
- `src/gcode-sender.ts` - Base class for CNC controller communication
- `src/gcode-grbl.ts` / `src/gcode-marlin.ts` - Controller-specific implementations


### Adding CNC Controllers

To add support for additional CNC controllers:

1. Create a new class extending `GcodeSender` (see `gcode-grbl.ts` and `gcode-marlin.ts` as examples)
2. Override methods specific to your controller's G-code dialect
3. Update the CLI in `console.ts` to include your controller option
4. Add the controller to the factory method in `whb04b_actions.ts`

Contributions for Smoothieware and TinyG support would be appreciated!

## Troubleshooting

### Pendant Not Detected

If the WHB04B-6 pendant is not detected:

1. Ensure the pendant is powered on and the USB receiver is connected
2. Check that the pendant is paired with the USB receiver 
3. Verify USB permissions (may require running as sudo on some Linux systems)
4. Try different USB ports or use a USB 2.0 port if having issues with USB 3.0

### Connection Issues

- Ensure CNCjs is running and accessible at the configured address/port
- Check firewall settings that might block WebSocket connections
- Verify the serial port path and permissions for your CNC controller

## License

See LICENSE file for details.

## Acknowledgments

This project stands on the shoulders of several excellent open source projects:

### Primary Foundation
- **[cncjs-pendant-gamepad](https://github.com/balthisar/cncjs-pendant-gamepad) by Jim Derry** - This project provided the primary codebase foundation that this WHB04B-6 implementation was adapted from. Jim Derry's work established the excellent modular architecture, CNCjs integration patterns, controller abstraction layer, and overall project structure that made this WHB04B-6 pendant possible. The core design patterns, WebSocket handling, G-code abstraction, and configuration management were all inherited from Jim's gamepad pendant work. This project would not exist without that solid foundation.

### Additional Recognition
- **[cncjs-pendant-ps3](https://github.com/cncjs/cncjs-pendant-ps3) by Austin St. Aubin** - The original CNCjs pendant implementation that started the pendant ecosystem
- **[Chris Midgley's PS3 pendant fork](https://github.com/cmidgley/cncjs-pendant-ps3)** - Important enhancements and improvements to the PS3 pendant
- **LinuxCNC xhc-whb04b-6 component** - Critical reference for reverse engineering the WHB04B-6 USB protocol
- **WHB04B-6 C# implementation** (included in `whb04b-6/` directory) - Additional protocol reference

**Special Thanks:** Jim Derry's gamepad pendant project deserves particular recognition not just for code reuse, but for demonstrating how to properly architect a CNCjs pendant integration. The clean separation of concerns, robust error handling, configuration management, and modular controller support established in that project made adapting it for the WHB04B-6's unique requirements straightforward and maintainable.

**Note:** This project is not associated with or endorsed by Chengdu Xinhecheng Technology Co., Ltd.
