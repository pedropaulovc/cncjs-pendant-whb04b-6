import { validateMacroContent } from './macro-validation.js';

// Fetch on each physical press; run the checked snapshot through CNCjs's feeder.
// Async discovery must never turn a canceled button press into delayed motion.
export class SavedMacroRunner {
  constructor({ session, grbl, library, log = () => {} }) {
    Object.assign(this, { session, grbl, library, log });
    this.intent = 0;
  }

  cancel() { this.intent++; }

  run(id) {
    return this.execute('Saved macro', async () => {
      const record = await this.library.read(id);
      validateMacroContent(record.content);
      return record;
    });
  }

  runClearance(workHome = false) {
    return this.execute(workHome ? 'W-Home' : 'Safe-Z', async () => {
      const z = await this.library.readToolChangeZ();
      const content = [`G21 G53 G0 G90 Z${decimal(z)}`];
      if (workHome) content.push('G21 G54 G0 G90 X0 Y0');
      return { name: workHome ? 'W-Home' : 'Safe-Z', content };
    });
  }

  runProbe() {
    return this.execute('Probe-Z', async () => {
      const height = await this.library.readTouchPlateHeight();
      return { name: 'Probe-Z', content: ['G21 G91', 'G38.2 Z-50 F120',
        `G10 L20 P1 Z${decimal(height + 0.001)}`, 'G0 Z3', 'G90'] };
    });
  }

  async execute(label, load) {
    const intent = ++this.intent;
    if (!this.grbl.manualReady() || this.grbl.jogPhase !== 'idle') {
      this.log(`${label}: wait for an idle controller with no running program or pending jog.`);
      return 'dropped';
    }
    const { generation, motionEpoch, workflowEpoch } = this.session;
    const port = this.session.status.port;
    try {
      const record = await load();
      if (intent !== this.intent) { this.log(`${label} request canceled.`); return 'dropped'; }
      if (generation !== this.session.generation || motionEpoch !== this.session.motionEpoch
        || workflowEpoch !== this.session.workflowEpoch || port !== this.session.status.port
        || !this.grbl.manualReady() || this.grbl.jogPhase !== 'idle') {
        this.log(`${label} canceled: the controller changed while loading it. Press the button again when idle.`);
        return 'dropped';
      }
      const result = this.grbl.macro(record.content);
      if (result === 'sent') this.log(`${label === 'Saved macro' ? 'Saved CNCjs macro' : label} queued: ${record.name}`);
      return result;
    } catch (error) {
      if (intent === this.intent) this.log(`${label}: ${error.message}`);
      return 'dropped';
    }
  }
}

// GRBL accepts decimal words, not JavaScript's exponential number notation.
function decimal(value) {
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  const [coefficient, exponent] = text.split('e');
  const negative = coefficient.startsWith('-');
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const [whole, fraction = ''] = unsigned.split('.');
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  const expanded = point <= 0 ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length ? digits + '0'.repeat(point - digits.length)
    : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return negative ? `-${expanded}` : expanded;
}
