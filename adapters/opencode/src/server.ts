import legacy from "./legacy.ts";
import native from "./index.ts";

// Both generations resolve /server; v1 selects server while native v2 selects setup.
export default { ...legacy, setup: native.setup };
