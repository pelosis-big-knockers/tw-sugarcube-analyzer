// Convenience entry point. Consumers that want one piece should require it
// directly (`tw-sugarcube-analyzer/twee.js`); this re-export exists so that
// `require("tw-sugarcube-analyzer")` is not a dead end.
"use strict";

const analyzer = require("./analyzer.js");
const twee = require("./twee.js");
const augmentation = require("./augmentation.js");

module.exports = { ...analyzer, ...augmentation, twee };
