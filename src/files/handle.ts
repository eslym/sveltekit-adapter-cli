import type { Server } from 'SERVER';
import { PassThrough, Readable } from 'stream';
import { SYM_BASE_PATH, SYM_SERVER, SYM_VERCELCONTEXT } from './symbols';
import { statSync, existsSync, type Stats } from 'fs';
import { normalize } from 'path';
import { Readline } from './readline';
import { manifest } from 'MANIFEST';

const env = Bun.env;

export type HandleOptions = {
    method: 'HEAD' | 'GET' | 'POST' | 'PATCH' | 'PUT' | 'OPTIONS';
    url: URL;
    clientIP?: string;
    static: boolean;
};

export function handle(options: HandleOptions) {
    globalThis.console = new console.Console(process.stderr, process.stderr);
    const waits = new Set<Promise<any>>();
    const wu = {
        waitUntil(promise: Promise<any>) {
            waits.add(promise.catch(console.error));
        }
    };
    (globalThis as any)[SYM_VERCELCONTEXT] = {
        get: () => wu
    };
    const headers = new Headers();
    const readline = new Readline();
    const abort = new AbortController();
    const pipe = new PassThrough();
    process.stdin.pipe(readline);
    let bodyStart = false;
    readline.on('line', (line: string) => {
        const [cmd, ...params] = JSON.parse(line) as string[];
        if (!bodyStart) {
            switch (cmd) {
                case 'header': {
                    headers.append(params[0], params[1]);
                    break;
                }
                case 'start-body': {
                    const req = new Request(options.url, {
                        method: options.method,
                        headers,
                        body: Readable.toWeb(pipe) as any,
                        signal: abort.signal
                    });
                    bodyStart = true;
                    serve(req, options)
                        .then((res) => writeResponse(res, req.method === 'HEAD'))
                        .catch((err) => {
                            console.error(err);
                        })
                        .finally(async () => {
                            await Promise.allSettled(waits);
                            process.exit(0);
                        });
                    break;
                }
            }
        } else if (!abort.signal.aborted) {
            switch (cmd) {
                case 'data': {
                    pipe.write(Buffer.from(params[0], 'base64'));
                    break;
                }
                case 'end-body': {
                    pipe.end();
                    break;
                }
                case 'abort': {
                    pipe.end();
                    abort.abort();
                    break;
                }
            }
        }
    });
}

async function firstResolve(resolvers: (undefined | (() => Response | undefined | Promise<Response | undefined>))[]) {
    for (let i = 0; i < resolvers.length; i++) {
        if (!resolvers[i]) continue;
        const res = await resolvers[i]!();
        if (res) return res;
    }
    return new Response('404 Not Found', {
        status: 404,
        headers: {
            'content-type': 'text/plain'
        }
    });
}

async function serve(request: Request, options: HandleOptions): Promise<Response> {
    return firstResolve([
        options.static
            ? () => serveStatic(request, options, (globalThis as any)[SYM_BASE_PATH] + '/client', true)
            : undefined,
        () => serveStatic(request, options, (globalThis as any)[SYM_BASE_PATH] + '/prerendered', false),
        async () => {
            const server = (globalThis as any)[SYM_SERVER] as Server;
            await server.init({ env: Bun.env as any });
            return server.respond(request, {
                getClientAddress() {
                    if (options.clientIP) return options.clientIP;
                    throw new Error('Unable to determine client IP.');
                }
            });
        }
    ]);
}

const tryFiles = ['.html', '.htm', '/index.html', '/index.htm'];

function statFile(path: string): Stats | undefined {
    if (!existsSync(path)) return undefined;
    const stats = statSync(path);
    if (!stats.isFile()) return undefined;
    return stats;
}

function lookup(path: string) {
    let stats = statFile(path);
    if (stats) return [path, stats] as const;
    for (let i = 0; i < tryFiles.length; i++) {
        const tryFile = path + tryFiles[i];
        stats = statFile(tryFile);
        if (stats) return [tryFile, stats] as const;
    }
    return ['', null] as const;
}

function serveStatic(request: Request, options: HandleOptions, basePath: string, cache: boolean) {
    if (!existsSync(basePath)) return undefined;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return undefined;
    }
    const normalized = normalize(decodeURIComponent(options.url.pathname)).replace(/^\/$/, '');
    if (env.IGNORE_FILES) {
        const ignores = env.IGNORE_FILES.split(',').map((s) => s.trim());
        const candidate = normalized.substring(1);
        for (let i = 0; i < ignores.length; i++) {
            const glob = new Bun.Glob(ignores[i]);
            if (glob.match(candidate)) return undefined;
        }
    }
    const [resolvedPath, stats] = lookup(basePath + normalized);
    if (!stats) return undefined;
    if (options.url.pathname !== '/' && options.url.pathname.endsWith('/')) {
        return new Response(null, {
            status: 302,
            headers: {
                location: new URL(normalized + options.url.search, options.url).toString()
            }
        });
    }
    const etag = `W/${stats.size}-${stats.mtimeMs}`;
    const [rangeStart, rangeEnd] = parseRange(request.headers);
    const headers = new Headers({
        'content-type': Bun.file(resolvedPath).type,
        'content-length': stats.size.toString(),
        'last-modified': stats.mtime.toUTCString(),
        etag
    });
    if (request.headers.get('if-non-match') === etag) {
        return new Response(null, {
            status: 304
        });
    }
    if (request.headers.has('range')) {
        if (!rangeStart) {
            headers.set('content-range', `bytes */${stats.size}`);
            headers.set('content-length', '0');
            return new Response(null, {
                status: 416,
                headers
            });
        }
        let startBytes = 0;
        let endBytes = stats.size;
        if (rangeStart < 0n) {
            startBytes = stats.size + rangeStart;
        } else {
            startBytes = rangeStart;
            if (rangeEnd) endBytes = rangeEnd + 1;
        }
        if (endBytes <= startBytes || startBytes < 0n || endBytes > stats.size) {
            headers.set('content-range', `bytes */${stats.size}`);
            headers.set('content-length', '0');
            return new Response(null, {
                status: 416,
                headers
            });
        }
        headers.set('content-range', `bytes ${startBytes}-${endBytes - 1}/${stats.size}`);
        headers.set('content-length', `${endBytes - startBytes}`);
        headers.set('accept-range', 'bytes');
        return new Response(Bun.file(resolvedPath).slice(startBytes, endBytes), {
            status: 206,
            headers
        });
    }
    if (cache)
        headers.set(
            'cache-control',
            normalized.startsWith(`/${manifest.appDir}/immutable/`)
                ? 'public,max-age=604800,immutable'
                : 'public,max-age=14400'
        );
    if (!request.headers.has('accept-encoding')) {
        return new Response(Bun.file(resolvedPath), {
            status: 200,
            headers
        });
    }
    const ac = request.headers.get('accept-encoding')!;
    if (existsSync(resolvedPath + '.gz') && ac.includes('gzip')) {
        const file = Bun.file(resolvedPath + '.gz');
        headers.set('content-length', `${file.size}`);
        headers.set('content-encoding', 'gzip');
        return new Response(file, {
            status: 200,
            headers
        });
    }
    if (existsSync(resolvedPath + '.br') && ac.includes('br')) {
        headers.set('content-encoding', 'br');
        return new Response(Bun.file(resolvedPath + '.br'), {
            status: 200,
            headers
        });
    }
    return new Response(Bun.file(resolvedPath), {
        status: 200,
        headers
    });
}

function parseRange(header: Headers): [number | null, number | null] {
    if (!header.has('range')) return [null, null];
    const range = header.get('range')!;
    const match = /^bytes=(?:(\d+)\-(\d+)?|(\-\d+))/.exec(range);
    if (!match) return [null, null];
    if (match[3]) return [+match[3], null];
    return [+match[1], match[2] ? +match[2] + 1 : null];
}

async function writeResponse(res: Response, ignoreBody: boolean) {
    await writeOut(['status', res.status, res.statusText]);
    const headers: string[] = [];
    res.headers.forEach((val, key) => headers.push(key, val));
    for (let i = 0; i < headers.length; i += 2) {
        await writeOut(['header', headers[i], headers[i + 1]]);
    }
    await writeOut(['start-body']);
    if (!res.body || ignoreBody) {
        await writeOut(['end-body']);
        return;
    }
    const reader = res.body.getReader();
    while (true) {
        const read = await reader.read();
        if (read.value) {
            await writeOut(['data', Buffer.from(read.value).toString('base64')]);
        }
        if (read.done) {
            await writeOut(['end-body']);
            return;
        }
    }
}

async function writeOut(data: any) {
    return new Promise<void>((res, rej) => {
        process.stdout.write(JSON.stringify(data) + '\n', (err) => {
            if (err) rej(err);
            else res();
        });
    });
}
