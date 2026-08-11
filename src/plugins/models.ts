import type { RouterPlugin } from './types';
import { huaweiH155Plugin } from './huawei-h155';

/**
 * Concrete model families. Each is a thin declaration — capabilities plus
 * matched model strings. All heavy lifting is shared in the core layers, so
 * adding a new router is a few lines here (see docs/PLUGIN_GUIDE.md).
 */

const fullCapabilities = () => ({
  lteBandLock: true,
  lteCellLock: true,
  nrBandLock: true,
  nrCellLock: true,
  towerScan: true,
  carrierAggregation: true,
  temperature: true,
  thermalControl: true,
});

/** MC801A / MC801A1 — the reference device from the knowledge base. */
export const mc801aPlugin: RouterPlugin = {
  id: 'mc801a',
  name: 'ZTE MC801A / MC801A1',
  models: ['MC801A', 'MC801A1'],
  authStrategyId: 'classic-zte',
  capabilities: () => ({
    ...fullCapabilities(),
    // Reference device is 5G NSA; SA cell-lock unverified on this firmware.
    nrCellLock: false,
  }),
};

export const mc888Plugin: RouterPlugin = {
  id: 'mc888',
  name: 'ZTE MC888 (Pro / Ultra)',
  // Prefix match also covers "MC888 Pro" / "MC888 Ultra".
  models: ['MC888'],
  authStrategyId: 'classic-zte',
  capabilities: fullCapabilities,
};

export const mc889Plugin: RouterPlugin = {
  id: 'mc889',
  name: 'ZTE MC889 / MC889A',
  models: ['MC889', 'MC889A'],
  authStrategyId: 'classic-zte',
  capabilities: fullCapabilities,
};

export const mc8020Plugin: RouterPlugin = {
  id: 'mc8020',
  name: 'ZTE MC8020',
  models: ['MC8020'],
  authStrategyId: 'classic-zte',
  capabilities: fullCapabilities,
};

/** ZTE G5B — Livewire UK G5B / G5BHWV1.0.0. */
export const g5bPlugin: RouterPlugin = {
  id: 'g5b',
  name: 'ZTE G5B',
  models: ['G5B'],
  authStrategyId: 'classic-zte',
  bandConfig: {
    // Verified from the G5B browser management script.
    lteAutoMask: 0xA3E2AB0908DFn,

    // Verified G5B NR allow-all/Auto band list.
    nrAutoBands: [
      1,
      2,
      3,
      5,
      7,
      8,
      20,
      28,
      38,
      41,
      50,
      51,
      66,
      70,
      71,
      74,
      75,
      76,
      77,
      78,
      79,
      80,
      81,
      82,
      83,
      84,
    ],
  },
  capabilities: () => ({
    ...fullCapabilities(),
    // LTE cell lock is verified through LTE_LOCK_CELL_SET.
    nrCellLock: false,
    // Not verified on the G5B firmware yet.
    towerScan: false,
    // Not verified on the G5B firmware yet.
    thermalControl: false,
  }),
};

export const MODEL_PLUGINS: readonly RouterPlugin[] = [
  mc801aPlugin,
  mc888Plugin,
  mc889Plugin,
  mc8020Plugin,
  g5bPlugin,
  huaweiH155Plugin,
];
