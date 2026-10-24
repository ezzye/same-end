// Modern encoder runtime is evaluated only on a capable hosting computer.
// Older phones/tablets loading an invitation need only the player bundle.
export { createCapture, canCapture } from './hls-capture.js';
