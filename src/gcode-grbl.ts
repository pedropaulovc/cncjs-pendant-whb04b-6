#!/usr/bin/env node

// gcode-grbl
// G-code handler for Grbl controllers. Sends messages to CNCjs via the
// connector service based on input from the actions service.
//
// Copyright (c) 2017-2022 various contributors. See LICENSE for copyright
// and MIT license information.

import { WHB04BActions } from './whb04b_actions.js';
import { GcodeSender }   from './gcode-sender.js';

//----------------------------------------------------------------------------
// class GcodeGrbl
//----------------------------------------------------------------------------
export class GcodeGrbl extends GcodeSender {

zProbeRecord: ZProbeRecord;

  //----------------------------------------------------------------------------
  // Override the constructor to subscribe to serial port read messages, so
  // that we can react to grbl-specific messages.
  //----------------------------------------------------------------------------
  constructor(actions: WHB04BActions) {
    super(actions);
    this.zProbeRecord = new ZProbeRecord();
    this.connector.subscribeMessage('serialport:read', (data:string) => {
      if (this.zProbeRecord.isValidString(data)) {
        this.zProbeRecord.updateFromString(data);
        if (this.zProbeRecord.success) {
          // The actual Z position is the detected position, but additionally
          // the thickness of the plate. This assumes Z is negative, and makes
          // it more so. This works for me; is this a safe assumption?
          const dz = this.zProbeRecord.z - Number(this.options.zProbeThickness);
          this.sendMessage('command', 'gcode', 'G91');              // relative coordinates
          this.sendMessage('command', 'gcode', `G10 L2 P1 Z${dz}`); // set the offset
          this.sendMessage('command', 'gcode', 'G0 Z3');            // lift up just a bit
          this.sendMessage('command', 'gcode', 'G90');              // back to absolute coordinates
        }
      }
    });
  }


  //----------------------------------------------------------------------------
  // move gantry: relative movement
  //  Override the base class implementation to use grbl-specific `$J=`ogging
  //  notation. We're also going to slow the speed down just slightly so that
  //  we can keep the planner full.
  //----------------------------------------------------------------------------
  override moveGantryJogToXYZ(x: number, y: number, z: number, mmPerMin: number) {
    this.sendMessage('command', 'gcode', 'G21');  // set to millimeters
    this.sendMessage('command', 'gcode', `G91`);
    this.sendMessage('command', 'gcode', `$J=X${x.toFixed(4)} Y${y.toFixed(4)} Z${z.toFixed(4)} F${mmPerMin * 0.98}`);
    this.sendMessage('command', 'gcode', 'G90');  // back to absolute coordinates
  }


  //----------------------------------------------------------------------------
  // move gantry: z probe position
  //  The base class doesn't provide this, but this override uses some grbl
  //  specific sniffing to know where the last probe position occurred. In
  //  general for hobby CNC, this is probably where the Z was last probed.
  //  This lets us go back and probe Z again at the same XY position for
  //  subsequent operations.
  //----------------------------------------------------------------------------
  override moveGantryZProbePos() {
    if (this.zProbeRecord.success) {
      this.sendMessage('command', 'gcode', `G53 G0 G90 Z${this.zsafepos}`);
      this.sendMessage('command', 'gcode', `G54 G0 G90 X${this.zProbeRecord.x} Y${this.zProbeRecord.y}`);
      }
  }

  
  //----------------------------------------------------------------------------
  // execute a probe operation
  //  Override the base class implementation to use grbl-specific probing data
  //  that should provide a much more precise probing operation. In this case,
  //  we're going to leave the probing operation incomplete, and complete it
  //  in the callback.
  //----------------------------------------------------------------------------
  override performZProbing() {
    this.sendMessage('command', 'gcode', 'G91');                   // relative coordinates
    this.sendMessage('command', 'gcode', 'G38.2 Z-50 F120');       // probe toward stock
    this.sendMessage('command', 'gcode', 'G90');                   // back to absolute coordinates
    // Stop! Now let's wait for the callback to finish setting up.
  }
} // class GcodeGrbl;


//----------------------------------------------------------------------------
// Instances of this class keep a record of the Z Probe position as they
// come in.
//----------------------------------------------------------------------------
import log from "npmlog";
class ZProbeRecord {

  x: number;
  y: number;
  z: number;
  success: boolean;

  //-------------------------------------------------------------
  // constructor()
  //-------------------------------------------------------------
  constructor() {
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.success = false;
  } // constructor();

  //-------------------------------------------------------------
  // Determines whether or not the provided string is a valid
  // grbl PRB response string.
  //-------------------------------------------------------------
  isValidString(data: string): Boolean {
    return data.match(/^\[PRB:.*:\d\]$/) != null;
  } // isValidString()

  //-------------------------------------------------------------
  // Given a well formatted string, set our values from it.
  //-------------------------------------------------------------
  updateFromString(data: string) {
    if ( !this.isValidString(data) ) {
      log.error('ZPROBEREC', `The string ${data} is NOT a correct record.`)
      return;
    }

    const values = data.match(/:(.*):/)[1].split(',');
    const success = data.match(/.*:(\d)/)[1];

    this.x = Number(values[0]);
    this.y = Number(values[1]);
    this.z = Number(values[2]);
    this.success = Boolean(Number(success));

  }; // updateFromString()

}; // class ZProbeRecord

