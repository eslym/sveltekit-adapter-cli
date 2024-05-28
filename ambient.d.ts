declare module 'SERVER' {
    import { CAC } from 'cac';
    export { Server } from '@sveltejs/kit';
    export function get_hooks(): Promise<{
        setupCLI?: (cac: CAC) => Promise<void>;
        bootstrap?: () => Promise<void>;
    }>;
}

declare module 'MANIFEST' {
    import { SSRManifest } from '@sveltejs/kit';
    export const manifest: SSRManifest;
}
