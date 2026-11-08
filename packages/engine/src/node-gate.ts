// Runs the Node version check when loaded. cli.ts imports this module first, and
// ES modules evaluate imports in order, so the check runs before the CLI's other
// modules (and their side effects) load. Keep it the first import of cli.ts.
import {
  ENGINE_NODE_RANGE,
  nodeVersionSupported,
  unsupportedNodeMessage,
} from "./node-range.js";

if (!nodeVersionSupported(process.versions.node, ENGINE_NODE_RANGE)) {
  process.stderr.write(`${unsupportedNodeMessage(process.versions.node)}\n`);
  process.exit(1);
}
