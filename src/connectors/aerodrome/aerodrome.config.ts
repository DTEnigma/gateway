import { getAvailableEthereumNetworks } from '../../chains/ethereum/ethereum.utils';
import { AvailableNetworks } from '../../services/base';
import { ConfigManagerV2 } from '../../services/config-manager-v2';

export namespace AerodromeConfig {
  // Aerodrome Slipstream is Base-only (single network).
  export const chain = 'ethereum';
  export const networks = getAvailableEthereumNetworks().filter((network) =>
    ['base'].includes(network),
  );
  export type Network = string;

  // Supported trading types — amm (standard pools) is doc 03 phase 2.
  export const tradingTypes = ['clmm'] as const;

  export interface RootConfig {
    slippagePct: number;
    availableNetworks: Array<AvailableNetworks>;
  }

  export const config: RootConfig = {
    slippagePct: ConfigManagerV2.getInstance().get('aerodrome.slippagePct') || 0.5,
    availableNetworks: [
      {
        chain,
        networks: networks,
      },
    ],
  };
}
