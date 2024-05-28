import type { Adapter, Builder } from '@sveltejs/kit';
import { name as adapterName } from '../package.json';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import { createReadStream, createWriteStream, existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import glob from 'tiny-glob';
import { pipeline } from 'stream/promises';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';

const files = fileURLToPath(new URL('./files', import.meta.url));

type PreCompressOptions = {
    /**
     * @default false;
     */
    [k in 'gzip' | 'brotli']?: boolean;
} & {
    /**
     * Extensions to pre-compress
     * @default ['html','js','json','css','svg','xml','wasm']
     */
    files?: string[];
};

type AdapterOptions = {
    /**
     * Output path
     * @default './build'
     */
    out?: string;

    /**
     * Transpile server code with bun transpiler after build. (will add `// @bun` tag to first line)
     * @default false
     */
    transpileBun?: boolean;

    /**
     * Enable pre-compress
     * @default false
     */
    precompress?: boolean | PreCompressOptions;

    /**
     * Run after build.
     * @param opts adapter options
     */
    postBuild?: (opts: AdapterOptions, builder: Builder) => void | Promise<void>;
};

const isBun = 'Bun' in globalThis;

export default function adapter(userOpts: AdapterOptions = {}): Adapter {
    const opts: Required<AdapterOptions> = {
        out: './build',
        transpileBun: false,
        precompress: false,
        postBuild: () => {},
        ...userOpts
    };
    return {
        name: adapterName,
        async adapt(builder) {
            if (isBun) {
                if (Bun.semver.order(Bun.version, '1.1.8') < 0) {
                    if (opts.precompress === true) {
                        builder.log.warn(
                            `Bun v${Bun.version} does not support brotli, please use newer version of bun or nodejs to build, otherwise brotli will be ignore.`
                        );
                        opts.precompress = {
                            gzip: true,
                            brotli: false
                        };
                    } else if (typeof opts.precompress === 'object' && opts.precompress) {
                        throw new Error(
                            `Bun v${Bun.version} does not support brotli, please use newer version of bun or nodejs to build.`
                        );
                    }
                }
            } else if (opts.transpileBun) {
                throw new Error('Please run build with bun to use `transpileBun: true`');
            }

            const tmp = builder.getBuildDirectory(adapterName);

            const { out, precompress, transpileBun } = opts;

            builder.rimraf(out);
            builder.mkdirp(out);

            builder.log.minor('Copying assets');
            builder.writeClient(`${out}/client${builder.config.kit.paths.base}`);
            builder.writePrerendered(`${out}/prerendered${builder.config.kit.paths.base}`);

            if (precompress) {
                builder.log.minor('Compressing assets');
                await Promise.all([
                    compress(`${out}/client`, precompress),
                    compress(`${out}/prerendered`, precompress)
                ]);
            }

            builder.log.minor('Building server');
            builder.writeServer(tmp);

            exportSetupCLI(tmp);

            writeFileSync(
                `${tmp}/manifest.js`,
                `export const manifest = ${builder.generateManifest({ relativePath: './' })};\n\n` +
                    `export const prerendered = new Set(${JSON.stringify(builder.prerendered.paths)});\n`
            );

            const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

            // we bundle the Vite output so that deployments only need
            // their production dependencies. Anything in devDependencies
            // will get included in the bundled code
            const bundle = await rollup({
                input: {
                    index: `${tmp}/index.js`,
                    manifest: `${tmp}/manifest.js`
                },
                external: [
                    // dependencies could have deep exports, so we need a regex
                    ...Object.keys(pkg.dependencies || {}).map((d) => new RegExp(`^${d}(\\/.*)?$`))
                ],
                plugins: [
                    nodeResolve({
                        preferBuiltins: true,
                        exportConditions: ['node']
                    }),
                    // @ts-ignore https://github.com/rollup/plugins/issues/1329
                    commonjs({ strictRequires: true }),
                    // @ts-ignore https://github.com/rollup/plugins/issues/1329
                    json()
                ]
            });

            await bundle.write({
                dir: `${out}/server`,
                format: 'esm',
                sourcemap: true,
                chunkFileNames: 'chunks/[name]-[hash].js'
            });

            builder.copy(files, out, {
                replace: {
                    SERVER: './server/index.js',
                    MANIFEST: './server/manifest.js'
                }
            });

            if (opts.transpileBun) {
                const files = await glob('./server/**/*.js', { cwd: out, absolute: true });
                const transpiler = new Bun.Transpiler({ loader: 'js' });
                for (const file of files) {
                    const src = await Bun.file(file).text();
                    if (src.startsWith('// @bun')) continue;
                    await Bun.write(file, '// @bun\n' + transpiler.transformSync(src));
                }
            }

            await opts.postBuild(opts, builder);

            builder.log.success(`Build done.`);
        }
    };
}

async function compress(directory: string, options: true | PreCompressOptions) {
    if (!existsSync(directory)) {
        return;
    }

    const files_ext =
        options === true || !options.files ? ['html', 'js', 'json', 'css', 'svg', 'xml', 'wasm'] : options.files;
    const files = await glob(`**/*.{${files_ext.join()}}`, {
        cwd: directory,
        dot: true,
        absolute: true,
        filesOnly: true
    });

    let doBr = false,
        doGz = false;

    if (options === true) {
        doBr = doGz = true;
    } else if (typeof options == 'object') {
        doBr = options.brotli ?? false;
        doGz = options.gzip ?? false;
    }

    await Promise.all(
        files.map((file) => Promise.all([doGz && compress_file(file, 'gz'), doBr && compress_file(file, 'br')]))
    );
}

/**
 * @param {string} file
 * @param {'gz' | 'br'} format
 */
async function compress_file(file: string, format: 'gz' | 'br' = 'gz') {
    if (format === 'br' && typeof zlib.createBrotliCompress !== 'function') {
        throw new Error(
            'Brotli compression is not supported, this might happens if you are using Bun to build your project instead of Node JS. See https://github.com/oven-sh/bun/issues/267'
        );
    }
    const compress =
        format == 'br'
            ? zlib.createBrotliCompress({
                  params: {
                      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
                      [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
                      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: statSync(file).size
                  }
              })
            : zlib.createGzip({ level: zlib.constants.Z_BEST_COMPRESSION });

    const source = createReadStream(file);
    const destination = createWriteStream(`${file}.${format}`);

    await pipeline(source, compress, destination);
}

function exportSetupCLI(out: string) {
    let src = readFileSync(`${out}/index.js`, 'utf8');
    const result = src.replace(/^export\s*{/gm, 'export {\nget_hooks,\n');

    writeFileSync(`${out}/index.js`, result, 'utf8');
}
