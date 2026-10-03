#!/usr/bin/env node
/**
 * ansidither launcher.
 *
 * Node refuses to strip TypeScript types for files under node_modules, so an
 * installed copy cannot load src/cli.ts on its own. This registers a load hook
 * that strips the types itself and then imports the real CLI. Plain JavaScript,
 * no dependencies, no build step.
 */

import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

registerHooks({
	load(url, context, nextLoad) {
		// Anything that is not TypeScript keeps the default handling.
		if (!url.endsWith('.ts')) return nextLoad(url, context);

		// nextLoad cannot be used here: it throws
		// ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING for exactly these files,
		// which is the error this launcher exists to work around. Read and strip
		// them by hand instead. Nodes' own loader takes care of caching.
		const source = readFileSync(new URL(url), 'utf8');
		return {
			format: 'module',
			source: stripTypeScriptTypes(source, { mode: 'strip' }),
			shortCircuit: true,
		};
	},
});

await import('./cli.ts');