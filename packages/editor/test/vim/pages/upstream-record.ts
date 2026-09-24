/** Page entry that records upstream tests (run against the oracle editor) as vector cases. */
import { type Recording, type RecordingSkip, UpstreamRecorder } from "../upstream/recorder";
import { runUpstreamSuite, type UpstreamResult } from "../upstream/runner";

export interface RecordRun {
  recordings: Recording[];
  skipped: RecordingSkip[];
  results: UpstreamResult[];
}

declare global {
  interface Window {
    __vimRecord: { run(): Promise<RecordRun> };
  }
}

window.__vimRecord = {
  async run() {
    const recorder = new UpstreamRecorder();
    const results = await runUpstreamSuite(recorder.codeMirror(), {
      before: (name) => recorder.beforeTest(name),
      after: (name, passed) => recorder.afterTest(name, passed),
    });
    return { recordings: recorder.recordings, skipped: recorder.skipped, results };
  },
};
