// index.js — Cloudflare Worker entry point.
//
// Wires the provider registry into the framework. To add a provider later,
// import it and add one line to the registry — nothing else changes.

import { handleRequest } from './connector.js';
import { pandaProvider } from './providers/panda.js';
import { amazonProvider, setAmazonEnv } from './providers/amazon.js';
import { tamimiProvider } from './providers/tamimi.js';
import { danubeProvider } from './providers/danube.js';
import { luluProvider } from './providers/lulu.js';
import { noonProvider } from './providers/noon.js';
import { ninjaProvider } from './providers/ninja.js';

const registry = {
  [pandaProvider.id]: pandaProvider,
  [amazonProvider.id]: amazonProvider,
  [tamimiProvider.id]: tamimiProvider,
  [danubeProvider.id]: danubeProvider,
  [luluProvider.id]: luluProvider,
  [noonProvider.id]: noonProvider,
  [ninjaProvider.id]: ninjaProvider,
};

export default {
  fetch(request, env) {
    // Thread Worker secrets/env to providers that need them (PA-API keys for
    // Amazon). The Core (connector.js) stays unchanged and provider-agnostic.
    setAmazonEnv(env);
    return handleRequest(request, registry);
  },
};
