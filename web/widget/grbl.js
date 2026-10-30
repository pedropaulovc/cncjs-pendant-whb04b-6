const FEED_RATES = {
  0x0d: 50, 0x0e: 125, 0x0f: 250, 0x10: 750, 0x1a: 1500, 0x1b: 2500, 0x9b: 3000,
};
const STEP_DISTANCES = {
  0x0d: 0.001, 0x0e: 0.01, 0x0f: 0.1, 0x10: 1.0, 0x1a: 10.0, 0x1b: 50.0, 0x9b: 100.0,
};

const Z_SAFE = -5.0; // Machine-coordinate millimetres; verify against your machine.

export class Grbl {
  constructor(session, getProbeThickness = () => 20) { this.session = session; this.getProbeThickness = getProbeThickness; }
  _cmd(directive, data) {
    this.session.command(directive, data);
  }
  gcode(g) { this._cmd('gcode', g); }
  reset() { this._cmd('reset'); }
  stop() {
    this._cmd('gcode:stop', { force: true });
    this._cmd('feeder:stop');
    this._cmd('jogCancel');
  }
  cyclestart() { this._cmd('cyclestart'); }
  homing() { this._cmd('homing'); }
  spindleOff() { this.gcode('M5'); }
  safeZ() { this.gcode(`G21 G53 G0 G90 Z${Z_SAFE}`); }
  wcsHome() { this.safeZ(); this.gcode('G21 G54 G0 G90 X0 Y0'); }
  probeZ() {
    const dz = Number(this.getProbeThickness()) + 0.001;
    this.gcode('G21 G91');
    this.gcode('G38.2 Z-50 F120');
    this.gcode(`G10 L20 P1 Z${dz}`);
    this.gcode('G0 Z3');
    this.gcode('G90');
  }
  jog(axis, signedDetents, rightCode) {
    const step = STEP_DISTANCES[rightCode] ?? 0.1;
    const feed = FEED_RATES[rightCode] ?? 500;
    const dist = (signedDetents * step).toFixed(4);
    this.gcode(`$J=G21 G91 ${axis}${dist} F${feed}`);
  }
}


