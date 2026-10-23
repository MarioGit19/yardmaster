import { createWebglSlot, useWebglClaim, useWebglClaimed } from '../fx/webglSlot.js';

/**
 * A layout that draws its own backdrop (Office, Grid: DESIGN.md §10.1) holds this while shown,
 * and the ambient field unmounts until it lets go.
 */
export const backdropSlot = createWebglSlot();

export const useOwnBackdrop = () => useWebglClaim(true, backdropSlot);

export const useBackdropTaken = () => useWebglClaimed(backdropSlot);
