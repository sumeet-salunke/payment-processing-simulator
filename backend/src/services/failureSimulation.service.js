import { FAILURE_MODES } from "../constants/failureSimulation.constants.js";

class FailureSimulationService {
  constructor() {
    this.currentMode = FAILURE_MODES.NONE;
    this.options = {};
  }

  setFailureMode(mode, options = {}) {
    if (!Object.values(FAILURE_MODES).includes(mode)) {
      throw new Error(`Invalid failure mode: ${mode}`);
    }
    this.currentMode = mode;
    this.options = options;
    console.log(`[FailureSimulation] Active mode set to: ${mode}`, options);
  }

  reset() {
    this.currentMode = FAILURE_MODES.NONE;
    this.options = {};
    console.log(`[FailureSimulation] Reset failure mode to: NONE`);
  }

  getMode() {
    return this.currentMode;
  }

  checkFailure(mode, req = null) {
    if (req?.headers?.["x-simulate-failure"] === mode) {
      return true;
    }
    return this.currentMode === mode;
  }
}

export default new FailureSimulationService();
