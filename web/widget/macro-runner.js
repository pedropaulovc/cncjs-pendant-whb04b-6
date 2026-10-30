import { validateMacroContent } from './macro-validation.js';

// Fetch on each physical press; run the checked snapshot through CNCjs's feeder.
// Async discovery must never turn a canceled button press into delayed motion.
export class SavedMacroRunner {
  constructor({ session, grbl, library, log = () => {} }) {
    Object.assign(this, { session, grbl, library, log });
    this.intent = 0;
  }

  cancel() { this.intent++; }

  async run(id) {
    const intent = ++this.intent;
    if (!this.grbl.manualReady() || this.grbl.jogPhase !== 'idle') {
      this.log('Saved macro: wait for an idle controller with no running program or pending jog.');
      return 'dropped';
    }
    const { generation, motionEpoch, workflowEpoch } = this.session;
    const port = this.session.status.port;
    try {
      const record = await this.library.read(id);
      if (intent !== this.intent) return 'dropped';
      if (generation !== this.session.generation || motionEpoch !== this.session.motionEpoch
        || workflowEpoch !== this.session.workflowEpoch || port !== this.session.status.port
        || !this.grbl.manualReady() || this.grbl.jogPhase !== 'idle') {
        this.log('Saved macro canceled: the controller changed while loading it. Press the button again when idle.');
        return 'dropped';
      }
      validateMacroContent(record.content);
      const result = this.grbl.macro(record.content);
      if (result === 'sent') this.log(`Saved CNCjs macro queued: ${record.name}`);
      return result;
    } catch (error) {
      if (intent === this.intent) this.log(`Saved macro: ${error.message}`);
      return 'dropped';
    }
  }
}
