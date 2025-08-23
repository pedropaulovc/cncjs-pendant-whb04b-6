WHB04B-6 CNC Pendant Support for CNC.js
========================================

 [1]: https://cnc.js.org
 [2]: https://github.com/cncjs/cncjs-pendant-ps3
 [3]: https://github.com/cmidgley/cncjs-pendant-ps3
 [4]: https://github.com/balthisar/cncjs-pendant-gamepad

Provides support for the WHB04B-6 CNC pendant controller as a wireless USB pendant for [CNC.js][1], allowing for operations like jogging, homing, probing, and managing jobs.


Controller Support
------------------

**Currently, only grbl is officially supported. _Please help_.** It’s highly likely that Marlin works (it looks okay, but I only use Marlin with a printer, so I can’t test it), but I have no idea how to implement/test Smoothieware and TinyG controllers. Please feel free to fork and tweak and submit a PR, or send me a controller. Confirmation that Marlin is good to go would be appreciated, too.


Project Information
-------------------

This project is adapted from the original [cncjs-pendant-ps3 by Austin St. Aubin][2] and [the gamepad fork by Chris Midgley][3], but has been completely rewritten to support the WHB04B-6 CNC pendant controller.

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

The main script will be available in the `bin/` directory:

    bin/cncjs-pendant-whb04b-6.js -p /dev/ttyUSB0 -b 115200 -t grbl run 

## Running cncjs-pendant-whb04b-6

To see all available options:

    cncjs-pendant-whb04b-6.js --help

### Key Options

- `--port (-p)`: Serial port path to the CNC controller (e.g., `/dev/ttyUSB0`)
- `--baudrate (-b)`: Baud rate for the serial connection (e.g., `115200`)
- `--controller-type (-t)`: Controller type (`grbl` or `marlin`)
- `--verbose (-v)`: Enable verbose logging (use `-vv` or `-vvv` for more detail)

### Basic Usage

Start the pendant server:

    cncjs-pendant-whb04b-6.js -p /dev/ttyUSB0 -b 115200 -t grbl run

For testing without a real CNC machine:

    cncjs-pendant-whb04b-6.js simulate -vv


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
- `secret`: CNCjs access secret
- `socketAddress`: CNCjs server address (default: `localhost`)
- `socketPort`: CNCjs server port (default: `8000`)
- `verbose`: Logging verbosity level
- `zProbeThickness`: Touch plate thickness for Z-probing (in mm)


## First Use Recommendation

We highly recommend running `cncjs-pendant-whb04b-6` in `simulate` mode first. This allows you to see the commands being sent (G-code and operations) without moving the actual machine. It's very useful to verify everything is working and helps you learn the pendant controls safely.

    cncjs-pendant-whb04b-6.js simulate -vv

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

This implementation is based on:

- Original [cncjs-pendant-ps3](https://github.com/cncjs/cncjs-pendant-ps3) by Austin St. Aubin
- [Gamepad pendant fork](https://github.com/cmidgley/cncjs-pendant-ps3) by Chris Midgley
- LinuxCNC xhc-whb04b-6 component for USB protocol reverse engineering
- WHB04B-6 C# implementation in the `whb04b-6/` directory

**Note:** This project is not associated with or endorsed by Chengdu Xinhecheng Technology Co., Ltd.
