#!/usr/bin/env node

// whb04b_controller
// A module that interfaces with the WHB04B-6 CNC pendant controller via USB HID
// and converts raw HID packets into structured pendant input events.
//
// Based on the LinuxCNC xhc-whb04b-6 component and C# WHB04BClient implementation

import { Options } from './console.js';
import { EventEmitter } from 'events';
import HID from 'node-hid';
import log from "npmlog";

//------------------------------------------------------------------------------
// Constants and interface definitions
//------------------------------------------------------------------------------
const LOGPREFIX = 'WHB04B   '; // keep at 9 digits for consistency

// WHB04B-6 USB device identifiers
const WHB04B_VENDOR_ID = 0x10CE;
const WHB04B_PRODUCT_ID = 0xEB93;

// HID packet structure
const INPUT_PACKET_SIZE = 8;
const OUTPUT_PACKET_SIZE = 21;
const POLLING_INTERVAL = 100; // ms

//------------------------------------------------------------------------------
// Enums matching the C# implementation
//------------------------------------------------------------------------------
export enum KeyPressed {
  None = 0,
  Key1 = 1,   // Reset
  Key2 = 2,   // Stop
  Key3 = 3,   // Start/Pause
  Key4 = 4,   // Macro-1/Feed+
  Key5 = 5,   // Macro-2/Feed-
  Key6 = 6,   // Macro-3/Spindle+
  Key7 = 7,   // Macro-4/Spindle-
  Key8 = 8,   // Macro-5/M-Home
  Key9 = 9,   // Macro-6/Safe-Z
  Key10 = 10, // Macro-7/W Home
  Key11 = 11, // Macro-8/S on/off
  Key12 = 12, // Fn
  Key13 = 13, // Macro-9/Probe Z
  Key14 = 16, // Macro-10
  Key15 = 14, // Continuous
  Key16 = 15, // Step
  Unknown = 255
}

export enum DialPosition {
  // Left Dial (Axis Selection) - actual hex values from WHB04B-6
  Off = 0x06,     // Off position
  X = 0x11,       // X axis
  Y = 0x12,       // Y axis  
  Z = 0x13,       // Z axis
  A = 0x14,       // A axis
  B = 0x15,       // B axis
  C = 0x16,       // C axis
  
  // Right Dial (Feed Rate/Step Size) - actual hex values from WHB04B-6  
  Rate2Percent = 0x0D,    // 2% / 0.001
  Rate5Percent = 0x0E,    // 5% / 0.01
  Rate10Percent = 0x0F,   // 10% / 0.1
  Rate30Percent = 0x10,   // 30% / 1
  Rate60Percent = 0x1A,   // 60%
  Rate100Percent = 0x1B,  // 100%
  Lead = 0x9B,            // Lead/Manual (actual value from pendant)
  
  Unknown = 255
}

//------------------------------------------------------------------------------
// Input data structure
//------------------------------------------------------------------------------
export class PendantInputData {
  public rawData: Buffer;
  public timestamp: Date;
  public firstKeyPressed: KeyPressed;
  public secondKeyPressed: KeyPressed;
  public rightDial: DialPosition;
  public leftDial: DialPosition;
  public jogCountOffset: number;

  constructor(data: Buffer) {
    this.rawData = data;
    this.timestamp = new Date();
    
    // Parse HID packet: [header=0x04, random, button1, button2, feedDial, axisDial, jogDelta, checksum]
    this.firstKeyPressed = this.parseKeyPressed(data.length > 2 ? data[2] : 0);
    this.secondKeyPressed = this.parseKeyPressed(data.length > 3 ? data[3] : 0);
    this.rightDial = this.parseRightDial(data.length > 4 ? data[4] : 0);
    this.leftDial = this.parseLeftDial(data.length > 5 ? data[5] : 0);
    this.jogCountOffset = data.length > 6 ? data.readInt8(6) : 0;
  }

  private parseKeyPressed(value: number): KeyPressed {
    switch (value) {
      case 0x00: return KeyPressed.None;
      case 0x01: return KeyPressed.Key1;
      case 0x02: return KeyPressed.Key2;
      case 0x03: return KeyPressed.Key3;
      case 0x04: return KeyPressed.Key4;
      case 0x05: return KeyPressed.Key5;
      case 0x06: return KeyPressed.Key6;
      case 0x07: return KeyPressed.Key7;
      case 0x08: return KeyPressed.Key8;
      case 0x09: return KeyPressed.Key9;
      case 0x0A: return KeyPressed.Key10;
      case 0x0B: return KeyPressed.Key11;
      case 0x0C: return KeyPressed.Key12;
      case 0x0D: return KeyPressed.Key13;
      case 0x10: return KeyPressed.Key14;  // Macro-10
      case 0x0E: return KeyPressed.Key15;  // Continuous
      case 0x0F: return KeyPressed.Key16;  // Step
      default: return KeyPressed.Unknown;
    }
  }

  private parseRightDial(value: number): DialPosition {
    // Right dial (feed rate/step size) valid values: 0x0D, 0x0E, 0x0F, 0x10, 0x1A, 0x1B, 0x9B
    switch (value) {
      case 0x0D: return DialPosition.Rate2Percent;
      case 0x0E: return DialPosition.Rate5Percent;
      case 0x0F: return DialPosition.Rate10Percent;
      case 0x10: return DialPosition.Rate30Percent;
      case 0x1A: return DialPosition.Rate60Percent;
      case 0x1B: return DialPosition.Rate100Percent;
      case 0x9B: return DialPosition.Lead;
      default: 
        // Debug: log unknown right dial values to help identify the issue
        log.info(LOGPREFIX, `Unknown right dial value: 0x${value.toString(16).padStart(2, '0').toUpperCase()} (${value})`);
        return DialPosition.Unknown;
    }
  }

  private parseLeftDial(value: number): DialPosition {
    // Left dial (axis selection) valid values: 0x06, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16
    switch (value) {
      case 0x06: return DialPosition.Off;
      case 0x11: return DialPosition.X;
      case 0x12: return DialPosition.Y;
      case 0x13: return DialPosition.Z;
      case 0x14: return DialPosition.A;
      case 0x15: return DialPosition.B;
      case 0x16: return DialPosition.C;
      default: 
        // Debug: log unknown left dial values to help identify the issue
        log.info(LOGPREFIX, `Unknown left dial value: 0x${value.toString(16).padStart(2, '0').toUpperCase()} (${value})`);
        return DialPosition.Unknown;
    }
  }
}

//------------------------------------------------------------------------------
// Display data structure
//------------------------------------------------------------------------------
export enum JogMode {
  None = 0,
  Continuous = 1,
  Step = 2,
  Reset = 3
}

export enum CoordinateSystem {
  XYZ = 0,
  X1Y1Z1 = 1
}

export class PendantDisplayData {
  private data: Buffer;

  constructor(
    jogMode: JogMode = JogMode.None,
    coordinateSystem: CoordinateSystem = CoordinateSystem.XYZ,
    x: number = 0,
    y: number = 0,
    z: number = 0,
    feedRate: number = 0,
    spindleRate: number = 0
  ) {
    this.data = Buffer.alloc(OUTPUT_PACKET_SIZE, 0);
    this.formatDisplayData(jogMode, coordinateSystem, x, y, z, feedRate, spindleRate);
  }

  private formatDisplayData(
    jogMode: JogMode,
    coordinateSystem: CoordinateSystem,
    x: number,
    y: number,
    z: number,
    feedRate: number,
    spindleRate: number
  ) {
    // Format coordinates as fixed-point (4 decimal places)
    const formatCoordinate = (coord: number): number => {
      return Math.round(coord * 10000) & 0xFFFFFFFF;
    };

    let offset = 0;
    
    // Block 1 (7 bytes): Header and status
    this.data[offset++] = 0x06; // Report ID
    this.data[offset++] = jogMode;
    this.data[offset++] = coordinateSystem;
    this.data[offset++] = 0x00; // Reserved
    this.data[offset++] = 0x00; // Reserved
    this.data[offset++] = 0x00; // Reserved
    this.data[offset++] = 0x00; // Reserved

    // Block 2 (7 bytes): X and Y coordinates
    const xCoord = formatCoordinate(x);
    this.data.writeUInt32LE(xCoord, offset);
    offset += 4;
    const yCoord = formatCoordinate(y);
    // Manually write 3 bytes for Y coordinate (no writeUInt24LE)
    this.data.writeUInt8((yCoord >> 0) & 0xFF, offset++);
    this.data.writeUInt8((yCoord >> 8) & 0xFF, offset++);
    this.data.writeUInt8((yCoord >> 16) & 0xFF, offset++);

    // Block 3 (7 bytes): Z coordinate, feed rate, and spindle rate
    const zCoord = formatCoordinate(z);
    this.data.writeUInt32LE(zCoord, offset);
    offset += 4;
    this.data.writeUInt16LE(feedRate & 0xFFFF, offset);
    offset += 2;
    this.data[offset] = (spindleRate & 0xFF);
  }

  get rawData(): Buffer {
    return this.data;
  }
}

//------------------------------------------------------------------------------
// WHB04B Controller State interface (compatible with original controller interface)
//------------------------------------------------------------------------------
export interface WHB04BState {
  id: number;
  connected: boolean;
  timestamp: number;
  buttons: { [key: string]: boolean };
  axes: { [key: string]: number };
}

//------------------------------------------------------------------------------
// Main WHB04B Controller class
//------------------------------------------------------------------------------
export class WHB04BController extends EventEmitter {
  private options: Options;
  private inputDevice: HID.HID | null = null;
  private outputDevice: HID.HID | null = null;
  private pollingTimer: NodeJS.Timer | null = null;
  private previousData: Buffer | null = null;
  private connected = false;
  private deviceCount = 0;

  constructor(options: Options) {
    super();
    this.options = options;
    
    log.info(LOGPREFIX, 'Initializing WHB04B-6 pendant controller');
    this.connectDevice();
  }

  //----------------------------------------------------------------------------
  // Device connection and detection
  //----------------------------------------------------------------------------
  private connectDevice(): void {
    try {
      // Find all WHB04B-6 devices
      const devices = HID.devices().filter(d => 
        d.vendorId === WHB04B_VENDOR_ID && d.productId === WHB04B_PRODUCT_ID
      );

      if (devices.length === 0) {
        log.warn(LOGPREFIX, 'WHB04B-6 pendant not found. Please connect the device.');
        this.scheduleReconnect();
        return;
      }

      log.info(LOGPREFIX, `Found ${devices.length} WHB04B-6 HID endpoint(s)`);

      // Find input and output devices based on path patterns
      this.findInputOutputDevices(devices);
      
      if (!this.inputDevice || !this.outputDevice) {
        log.error(LOGPREFIX, 'Could not find both input and output devices');
        this.scheduleReconnect();
        return;
      }

      this.connected = true;
      this.deviceCount = 1;

      // Start polling
      this.startPolling();
      
      // Emit attach event for compatibility with original controller interface
      this.emit('attach', 0, this.getState());

    } catch (error) {
      log.error(LOGPREFIX, `Failed to connect to WHB04B-6: ${error}`);
      this.scheduleReconnect();
    }
  }

  private findInputOutputDevices(devices: HID.Device[]): void {
    // On Windows, WHB04B-6 creates separate HID endpoints:
    // - col01 (collection 1) for input data
    // - col02 (collection 2) for output data
    for (const device of devices) {
      if (this.options.verbose >= 2) {
        log.info(LOGPREFIX, `Checking device path: ${device.path}`);
      }
      
      // Check if this is an input device (Col01)
      if (device.path && device.path.toLowerCase().includes('col01') && !this.inputDevice) {
        try {
          this.inputDevice = new HID.HID(device.path);
          log.info(LOGPREFIX, `Input device opened: ${device.path}`);
        } catch (error) {
          log.warn(LOGPREFIX, `Failed to open input device: ${error}`);
        }
      }
      
      // Check if this is an output device (Col02)  
      if (device.path && device.path.toLowerCase().includes('col02') && !this.outputDevice) {
        try {
          this.outputDevice = new HID.HID(device.path);
          log.info(LOGPREFIX, `Output device opened: ${device.path}`);
        } catch (error) {
          log.warn(LOGPREFIX, `Failed to open output device: ${error}`);
        }
      }
    }
    
    // Fallback: if we only found one device, use it for both
    if (!this.inputDevice && !this.outputDevice && devices.length > 0) {
      try {
        const device = devices[0];
        this.inputDevice = new HID.HID(device.path!);
        this.outputDevice = this.inputDevice; // Use same device for both
        log.info(LOGPREFIX, `Using single device for both input and output: ${device.path}`);
      } catch (error) {
        log.error(LOGPREFIX, `Failed to open fallback device: ${error}`);
      }
    }
  }

  private scheduleReconnect(): void {
    setTimeout(() => {
      if (!this.connected) {
        this.connectDevice();
      }
    }, 2000);
  }

  //----------------------------------------------------------------------------
  // Polling and data processing
  //----------------------------------------------------------------------------
  private startPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
    }

    this.pollingTimer = setInterval(() => {
      this.pollDevice();
    }, POLLING_INTERVAL);
  }

  private pollDevice(): void {
    if (!this.inputDevice || !this.connected) {
      return;
    }

    try {
      // Read HID input report
      const data = this.inputDevice.readTimeout(INPUT_PACKET_SIZE);
      
      if (data && data.length >= INPUT_PACKET_SIZE) {
        const inputBuffer = Buffer.from(data);
        
        // Check if data has changed and is valid
        if (this.hasDataChanged(inputBuffer)) {
          this.previousData = inputBuffer;
          const inputData = new PendantInputData(inputBuffer);
          
          if (this.options.verbose >= 3) {
            log.info(LOGPREFIX, 
              `Key1: ${KeyPressed[inputData.firstKeyPressed]} | ` +
              `Key2: ${KeyPressed[inputData.secondKeyPressed]} | ` +
              `RightDial: ${DialPosition[inputData.rightDial]} | ` +
              `LeftDial: ${DialPosition[inputData.leftDial]} | ` +
              `Jog: ${inputData.jogCountOffset}`
            );
          }

          // Emit 'use' event for compatibility with actions module
          this.emit('use', 0, inputData, this.getState());
        }
      }
    } catch (error) {
      log.debug(LOGPREFIX, `Polling error: ${error}`);
      this.handleDisconnect();
    }
  }

  private hasDataChanged(newData: Buffer): boolean {
    // Check if packet is valid (header should be 0x04)
    if (newData.length >= 8 && newData[0] !== 0x04) {
      return false;
    }

    // Compare with previous data
    if (!this.previousData) {
      return true;
    }

    return !newData.equals(this.previousData);
  }

  //----------------------------------------------------------------------------
  // Display output
  //----------------------------------------------------------------------------
  public sendDisplayData(displayData: PendantDisplayData): void {
    if (!this.outputDevice || !this.connected) {
      log.warn(LOGPREFIX, 'Cannot send display data - device not connected');
      return;
    }

    try {
      const data = displayData.rawData;
      
      // Ensure data is exactly 21 bytes (3 blocks of 7 bytes each)
      const paddedData = Buffer.alloc(21);
      data.copy(paddedData, 0, 0, Math.min(data.length, 21));
      
      // Send data in 7-byte chunks with report ID, matching C# implementation
      for (let i = 0; i < paddedData.length; i += 7) {
        const block = Buffer.alloc(8); // 8 bytes total
        block[0] = 0x06; // Report ID
        
        const bytesToCopy = Math.min(7, paddedData.length - i);
        paddedData.copy(block, 1, i, i + bytesToCopy);
        
        if (this.options.verbose >= 3) {
          log.info(LOGPREFIX, `Sending block ${Math.floor(i/7) + 1}: ${block.toString('hex')}`);
        }
        
        // Try sendFeatureReport first (HID control transfer)
        try {
          this.outputDevice.sendFeatureReport(Array.from(block));
          if (this.options.verbose >= 3) {
            log.info(LOGPREFIX, `sendFeatureReport succeeded for block ${Math.floor(i/7) + 1}`);
          }
        } catch (featureError) {
          if (this.options.verbose >= 3) {
            log.info(LOGPREFIX, `sendFeatureReport failed for block ${Math.floor(i/7) + 1}, trying write...`);
          }
          
          // Fallback to write
          try {
            this.outputDevice.write(Array.from(block));
            if (this.options.verbose >= 3) {
              log.info(LOGPREFIX, `write succeeded for block ${Math.floor(i/7) + 1}`);
            }
          } catch (writeError) {
            log.error(LOGPREFIX, `Both sendFeatureReport and write failed for block ${Math.floor(i/7) + 1}: ${writeError}`);
            throw writeError;
          }
        }
      }
    } catch (error) {
      log.error(LOGPREFIX, `Failed to send display data: ${error}`);
    }
  }

  public clearDisplay(): void {
    const clearData = new PendantDisplayData(JogMode.None, CoordinateSystem.XYZ, 0, 0, 0);
    this.sendDisplayData(clearData);
    this.sendDisplayData(clearData); // Send twice for reliability
  }

  //----------------------------------------------------------------------------
  // Connection management and cleanup
  //----------------------------------------------------------------------------
  private handleDisconnect(): void {
    if (this.connected) {
      log.warn(LOGPREFIX, 'WHB04B-6 pendant disconnected');
      this.connected = false;
      this.deviceCount = 0;
      
      if (this.inputDevice) {
        try {
          this.inputDevice.close();
        } catch (error) {
          // Ignore close errors
        }
        this.inputDevice = null;
      }
      
      if (this.outputDevice && this.outputDevice !== this.inputDevice) {
        try {
          this.outputDevice.close();
        } catch (error) {
          // Ignore close errors
        }
        this.outputDevice = null;
      }

      if (this.pollingTimer) {
        clearInterval(this.pollingTimer);
        this.pollingTimer = null;
      }

      // Emit remove event
      this.emit('remove', 0, this.getState());

      // Schedule reconnection
      this.scheduleReconnect();
    }
  }

  //----------------------------------------------------------------------------
  // Controller compatibility interface
  //----------------------------------------------------------------------------
  public isConnected(): boolean {
    return this.connected;
  }

  public numDevices(): number {
    return this.deviceCount;
  }

  private getState(): WHB04BState {
    return {
      id: 0,
      connected: this.connected,
      timestamp: Date.now(),
      buttons: {}, // WHB04B uses different input model
      axes: {}     // WHB04B uses different input model
    };
  }

  //----------------------------------------------------------------------------
  // Cleanup
  //----------------------------------------------------------------------------
  public destroy(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }

    if (this.inputDevice) {
      try {
        this.inputDevice.close();
      } catch (error) {
        // Ignore close errors
      }
      this.inputDevice = null;
    }
    
    if (this.outputDevice && this.outputDevice !== this.inputDevice) {
      try {
        this.outputDevice.close();
      } catch (error) {
        // Ignore close errors
      }
      this.outputDevice = null;
    }

    this.connected = false;
    this.deviceCount = 0;
  }
}