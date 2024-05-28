import cac from 'cac';
import { SYM_BASE_PATH } from './symbols';
import { handle } from './handle';
import { get_hooks } from 'SERVER';

(globalThis as any)[SYM_BASE_PATH] = import.meta.dirname;

const hooks = await get_hooks();

await hooks.bootstrap?.();

const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'OPTIONS']);

const cli = cac();

cli.command('render', 'Handle a http request')
    .option('--url, -u <url>', 'URL of the request')
    .option('--method, -m <method>', 'Method of the request')
    .option('--client-ip, -i [clientIP]', 'Client IP')
    .option('--no-static', 'Disable serve static file')
    .action((opts: { url: string; method: string; clientIp: string; static: boolean }) => {
        if (typeof opts.url !== 'string' || !URL.canParse(opts.url)) {
            throw new Error('url option need to be a valid url.');
        }
        if (typeof opts.method !== 'string') {
            throw new Error(`method must be a string.`);
        }
        const method = opts.method.toUpperCase() as any;
        if (!methods.has(method)) {
            throw new Error(`invalid method: ${method}`);
        }
        const serveStatic = Boolean(opts.static);
        const clientIP = `${opts.clientIp}`;
        handle({
            url: new URL(opts.url),
            method,
            clientIP,
            static: serveStatic
        });
    });

cli.help();

await hooks.setupCLI?.(cli);

cli.parse();
