/**
 * Supported assets for the create-stream / create-flow asset picker.
 *
 * Reads `GET /api/assets` (public deployment config — admin parties resolved
 * server-side for the target network). Cached long; the list rarely changes.
 */

import { useQuery } from '@tanstack/react-query';
import type { SupportedAsset } from '../api/client.js';
import { useCantonClient } from './useCantonClient.js';

export function useAssets() {
  const client = useCantonClient();

  return useQuery<SupportedAsset[]>({
    queryKey: ['assets'],
    queryFn: () => client!.listAssets(),
    enabled: !!client,
    staleTime: 5 * 60_000,
  });
}
