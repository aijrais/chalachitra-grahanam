import {
  heldNotes
} from './detectors.js';
self.onmessage = ({
  data
}) => {
  try {
    const notes = heldNotes(data.pcm, data.rate, data.target, fraction => self.postMessage({
      fraction
    }));
    self.postMessage({
      notes
    });
  } catch (err) {
    self.postMessage({
      error: err.message
    });
  }
};
