#!/usr/bin/env node

// whb04b_actions
// A module that creates actions based on input from the WHB04B-6 pendant controller
// and sends them to a socket server (typically CNCjs) to execute them.
//
// Copyright (c) 2017-2022 various contributors. See LICENSE for copyright
// and MIT license information.

import { Options }                                                           from './console';
import { GcodeSender }                                                       from './gcode-sender.js';
import { GcodeGrbl }                                                         from './gcode-grbl.js';
import { GcodeMarlin }                                                       from './gcode-marlin.js';
import { Connector }                                                         from './connector';
import { WHB04BController, WHB04BState, PendantInputData, KeyPressed, DialPosition, PendantDisplayData, JogMode, CoordinateSystem } from './whb04b_controller';

import log from 'npmlog';
import fs from 'fs';
import path from 'path';
import os from 'os';

//------------------------------------------------------------------------------
// Constant and interface definitions.
//------------------------------------------------------------------------------
const LOGPREFIX = 'WHB04B-A '; // keep at 9 digits for consistency

// Jog movement settings for WHB04B pendant
const JOG_INTERVAL = 100;                    // ms/interval; there are 60,000 ms/min.

// Feed rates based on right dial position
const FEED_RATES = {
  [DialPosition.Position1]: 10,    // 0.001/2%
  [DialPosition.Position2]: 50,    // 0.01/5%  
  [DialPosition.Position3]: 100,   // 0.1/10%
  [DialPosition.Position4]: 500,   // 1/30%
  [DialPosition.Position5]: 1000,  // 60%
  [DialPosition.Position6]: 2000,  // 100%
  [DialPosition.Position7]: 3000,  // Lead
};

// Step distances based on right dial position  
const STEP_DISTANCES = {
  [DialPosition.Position1]: 0.001, // 0.001mm
  [DialPosition.Position2]: 0.01,  // 0.01mm
  [DialPosition.Position3]: 0.1,   // 0.1mm
  [DialPosition.Position4]: 1.0,   // 1mm
  [DialPosition.Position5]: 10.0,  // 10mm (60% setting used as 10mm)
  [DialPosition.Position6]: 50.0,  // 50mm (100% setting used as 50mm)
  [DialPosition.Position7]: 100.0, // 100mm (Lead setting used as 100mm)
};

//----------------------------------------------------------------------------
// Interface definitions.
//----------------------------------------------------------------------------
// A simple record that indicates the next jogging motion destination.
export class XYZCoords {
  move_x_axis: number = 0.0;
  move_y_axis: number = 0.0;
  move_z_axis: number = 0.0;
};

// An interface for holding actions mappings. Perhaps a bit overly broad.
export interface ActionsMappings {
  [key: string]: any;
}

//------------------------------------------------------------------------------
// Main WHB04B Actions class
//------------------------------------------------------------------------------
export class WHB04BActions {
  connector: Connector;                       // connection to CNCjs
  whb04bController: WHB04BController;         // connection to WHB04B pendant
  options: Options;                           // program-wide options
  gcodeSender: GcodeSender;                   // abstraction interface
  jogTimer: NodeJS.Timer;                     // jog timer reference

  pendantState = {} as WHB04BState;           // state of current pendant
  axisInstructions = new XYZCoords();         // next jog movement instructions
  
  currentJogMode: JogMode = JogMode.None;     // current jog mode
  isJogging = false;                          // whether continuous jogging is active
  lastJogAxis: string | null = null;          // last axis jogged for continuous mode

  //----------------------------------------------------------------------------
  // constructor()
  //----------------------------------------------------------------------------
  constructor(connector: Connector, options: Options) {
    this.connector = connector;
    this.whb04bController = connector.whb04bController;
    this.options = options;
    this.gcodeSender = this.newGcodeSender();

    this.whb04bController.on('use', this.onUse.bind(this));
    this.jogTimer = setTimeout(this.jogFunction.bind(this), JOG_INTERVAL);
    
    // Send initial display data
    this.updateDisplay();
  }

  //----------------------------------------------------------------------------
  // createGcodeSender()
  // Create an instance of the appropriate Gcode sender.
  //----------------------------------------------------------------------------
  newGcodeSender(): GcodeSender {
    let gcode: typeof GcodeSender;
    switch (this.options.controllerType.toLowerCase()) {
      case 'grbl':
        gcode = GcodeGrbl;
        break;
      case 'marlin':
        gcode = GcodeMarlin;
        break;
      default:
        log.error(LOGPREFIX, `Controller type ${this.options.controllerType} unknown; unable to continue`);
        process.exit(1);
    }
    return new gcode(this);
  }

  //--------------------------------------------------------------------------
  // onUse()
  // Handle input from the WHB04B-6 pendant controller. This processes button
  // presses, dial positions, and jog wheel movements to control the CNC machine.
  //--------------------------------------------------------------------------
  onUse(id: number, inputData: PendantInputData, state: WHB04BState) {
    // Update pendant state
    this.pendantState = state;
    
    // Handle button presses for direct CNC operations
    if (inputData.firstKeyPressed !== KeyPressed.None) {
      this.handleButtonPress(inputData.firstKeyPressed);
    }
    if (inputData.secondKeyPressed !== KeyPressed.None) {
      this.handleButtonPress(inputData.secondKeyPressed);
    }
    
    // Handle jog wheel movement
    if (inputData.jogCountOffset !== 0) {
      this.handleJogWheel(inputData.jogCountOffset, inputData.leftDial, inputData.rightDial);
    }
    
    // Update display with current status
    this.updateDisplay();
  }

  //--------------------------------------------------------------------------
  // handleButtonPress()
  // Process button press events from the pendant
  //--------------------------------------------------------------------------
  private handleButtonPress(key: KeyPressed): void {
    log.debug(LOGPREFIX, `Button pressed: ${KeyPressed[key]}`);
    
    switch (key) {
      case KeyPressed.Key1: // Reset
        this.gcodeSender.controllerReset();
        break;
        
      case KeyPressed.Key2: // Stop
        this.gcodeSender.controllerStop();
        this.isJogging = false;
        break;
        
      case KeyPressed.Key3: // Start/Pause
        this.gcodeSender.controllerCyclestart();
        break;
        
      case KeyPressed.Key4: // Feed+ (not directly available, placeholder)
        log.debug(LOGPREFIX, 'Feed+ not implemented');
        break;
        
      case KeyPressed.Key5: // Feed- (not directly available, placeholder)
        log.debug(LOGPREFIX, 'Feed- not implemented');
        break;
        
      case KeyPressed.Key6: // Spindle+ (not directly available, placeholder)
        log.debug(LOGPREFIX, 'Spindle+ not implemented');
        break;
        
      case KeyPressed.Key7: // Spindle- (not directly available, placeholder)
        log.debug(LOGPREFIX, 'Spindle- not implemented');
        break;
        
      case KeyPressed.Key8: // Machine Home
        this.gcodeSender.performHoming();
        break;
        
      case KeyPressed.Key9: // Safe-Z (move to safe Z position)
        this.gcodeSender.moveGantryZProbePos();
        break;
        
      case KeyPressed.Key10: // Workpiece Home
        this.gcodeSender.moveGantryWCSHome();
        break;
        
      case KeyPressed.Key11: // Spindle on/off
        this.gcodeSender.spindleOff(); // Toggle would need state tracking
        break;
        
      case KeyPressed.Key12: // Function key (reserved for future use)
        break;
        
      case KeyPressed.Key13: // Probe Z
        this.gcodeSender.performZProbing();
        break;
        
      case KeyPressed.Key14: // Macro-10 (reserved for future use)
        break;
        
      case KeyPressed.Key15: // Continuous jog mode
        this.setJogMode(JogMode.Continuous);
        break;
        
      case KeyPressed.Key16: // Step jog mode
        this.setJogMode(JogMode.Step);
        break;
    }
  }

  //--------------------------------------------------------------------------
  // handleJogWheel()
  // Process jog wheel movement based on selected axis and feed rate
  //--------------------------------------------------------------------------
  private handleJogWheel(offset: number, leftDial: DialPosition, rightDial: DialPosition): void {
    // Left dial determines axis (Position1 = Off)
    if (leftDial === DialPosition.Position1) {
      return; // Off position - no movement
    }
    
    const axis = this.getAxisFromDial(leftDial);
    if (!axis) return;
    
    log.debug(LOGPREFIX, `Jog wheel: offset=${offset}, axis=${axis}, leftDial=${DialPosition[leftDial]}, rightDial=${DialPosition[rightDial]}`);
    
    if (this.currentJogMode === JogMode.Continuous) {
      this.handleContinuousJog(offset, axis, rightDial);
    } else if (this.currentJogMode === JogMode.Step) {
      this.handleStepJog(offset, axis, rightDial);
    }
  }

  //--------------------------------------------------------------------------
  // getAxisFromDial()
  // Convert left dial position to axis name
  //--------------------------------------------------------------------------
  private getAxisFromDial(dialPosition: DialPosition): string | null {
    switch (dialPosition) {
      case DialPosition.Position2: return 'X';
      case DialPosition.Position3: return 'Y';
      case DialPosition.Position4: return 'Z';
      case DialPosition.Position5: return 'A';
      case DialPosition.Position6: return 'B';
      case DialPosition.Position7: return 'C';
      default: return null;
    }
  }

  //--------------------------------------------------------------------------
  // handleContinuousJog()
  // Handle continuous jogging based on jog wheel movement
  //--------------------------------------------------------------------------
  private handleContinuousJog(offset: number, axis: string, rightDial: DialPosition): void {
    const feedRate = FEED_RATES[rightDial] || FEED_RATES[DialPosition.Position3]; // Default to 100mm/min
    const direction = offset > 0 ? 1 : -1;
    const distance = Math.abs(offset) * 0.1 * direction; // Use small increments for continuous feel
    
    // Use the existing relative movement method for continuous jog
    let x = 0, y = 0, z = 0;
    switch (axis) {
      case 'X': x = distance; break;
      case 'Y': y = distance; break;
      case 'Z': z = distance; break;
    }
    
    this.gcodeSender.moveGantryRelative(x, y, z, feedRate);
    
    this.isJogging = true;
    this.lastJogAxis = axis;
    
    // If wheel stopped moving, stop jogging after a brief delay
    clearTimeout(this.jogTimer);
    this.jogTimer = setTimeout(() => {
      this.isJogging = false;
      this.lastJogAxis = null;
    }, 200); // 200ms delay to allow for wheel momentum
  }

  //--------------------------------------------------------------------------
  // handleStepJog()
  // Handle step jogging based on jog wheel movement
  //--------------------------------------------------------------------------
  private handleStepJog(offset: number, axis: string, rightDial: DialPosition): void {
    const stepDistance = STEP_DISTANCES[rightDial] || STEP_DISTANCES[DialPosition.Position3]; // Default to 0.1mm
    const distance = Math.abs(offset) * stepDistance * (offset > 0 ? 1 : -1);
    
    let x = 0, y = 0, z = 0;
    switch (axis) {
      case 'X': x = distance; break;
      case 'Y': y = distance; break;
      case 'Z': z = distance; break;
    }
    
    // Use a reasonable feed rate for step movements
    const feedRate = 500; // mm/min
    this.gcodeSender.moveGantryRelative(x, y, z, feedRate);
  }

  //--------------------------------------------------------------------------
  // setJogMode()
  // Set the current jog mode and update display
  //--------------------------------------------------------------------------
  private setJogMode(mode: JogMode): void {
    this.currentJogMode = mode;
    log.info(LOGPREFIX, `Jog mode set to: ${JogMode[mode]}`);
    
    // Stop any current jogging
    if (this.isJogging) {
      // Stop current movement by clearing the timer
      clearTimeout(this.jogTimer);
      this.isJogging = false;
      this.lastJogAxis = null;
    }
    
    this.updateDisplay();
  }

  //--------------------------------------------------------------------------
  // updateDisplay()
  // Update the pendant display with current machine status
  //--------------------------------------------------------------------------
  private updateDisplay(): void {
    // Get current machine coordinates (this would need to be implemented
    // based on the actual machine state from CNCjs)
    const displayData = new PendantDisplayData(
      this.currentJogMode,
      CoordinateSystem.XYZ,
      0, // X coordinate - would need to get from machine state
      0, // Y coordinate - would need to get from machine state  
      0, // Z coordinate - would need to get from machine state
      100, // Feed rate - would need to get from machine state
      0  // Spindle rate - would need to get from machine state
    );
    
    this.whb04bController.sendDisplayData(displayData);
  }

  //--------------------------------------------------------------------------
  // jogFunction()
  // Timer function for handling continuous jog movements
  //--------------------------------------------------------------------------
  jogFunction(): void {
    // Handle any pending axis movements
    if (this.axisInstructions.move_x_axis !== 0 || 
        this.axisInstructions.move_y_axis !== 0 || 
        this.axisInstructions.move_z_axis !== 0) {
      
      this.jogGantry(
        this.axisInstructions.move_x_axis,
        this.axisInstructions.move_y_axis,
        this.axisInstructions.move_z_axis
      );
    }
    
    // Reset axis instructions
    this.axisInstructions = new XYZCoords();
    
    // Schedule next timer
    this.jogTimer = setTimeout(this.jogFunction.bind(this), JOG_INTERVAL);
  }

  //--------------------------------------------------------------------------
  // jogGantry()
  // Send jog commands to the machine
  //--------------------------------------------------------------------------
  jogGantry(x: number, y: number, z: number): void {
    if (this.options.simulate) {
      if (x !== 0 || y !== 0 || z !== 0) {
        log.info(LOGPREFIX, `SIMULATE: Jog X:${x.toFixed(3)} Y:${y.toFixed(3)} Z:${z.toFixed(3)}`);
      }
    } else {
      this.gcodeSender.jogMove(x, y, z);
    }
  }

  //--------------------------------------------------------------------------
  // cleanup()
  // Clean up timers and connections
  //--------------------------------------------------------------------------
  cleanup(): void {
    if (this.jogTimer) {
      clearTimeout(this.jogTimer);
    }
    
    if (this.isJogging) {
      this.isJogging = false;
    }
  }
}