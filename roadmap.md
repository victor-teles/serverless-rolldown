Target only Serverless Framework v4 and Node-based Lambda handlers in v1.
invoke local, serverless-offline, watch mode, layers, and non-Node runtimes are out of scope for this first slice.
Missing rolldown.config.* is not an error.
Multi-entry efficiency is used only where Serverless is producing one shared service artifact; individual packaging intentionally falls back to single-entry builds because Rolldown cannot disable code splitting for multiple inputs.